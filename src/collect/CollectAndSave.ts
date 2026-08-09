import { Subscriptions } from './Subscriptions';
import { Embedding } from './Embedding';
import { Middleware } from '../common/Middleware';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { API, type CollectOptions } from './API';
import { delay } from './ApiSupport';
import { Paper } from './Paper';
import type { SearchQuery } from './SearchQuery';

// run()의 실제 수집 범위는 원래 Subscriptions(API별 SearchQuery)에서 읽어와야 하지만,
// 그게 구현되기 전까지 설정탭의 테스트 버튼이 직접 범위를 넘겨볼 수 있도록 임시로 받는
// 옵션. hours는 API.SearchRecentPaper(hours), from/to는 API.Backfill(from, to)와
// 대응한다 (2026-08-02).
export interface CollectTestOptions {
	hours?: number;
	from?: number;
	to?: number;
}

// 한 API(구독)가 이번 실행에서 훑을 구간. hours가 있으면 SearchRecentPaper로, 없으면
// Backfill로 부른다. advancesCursor는 "이 실행 결과를 그 API의 updateTime에 반영해도
// 되는가" — 테스트 경로(직접 범위를 준 경우)가 운영 커서를 오염시키지 않게 구분한다.
//
// 구독마다 독립이다. Backfill/테스트 hours처럼 범위를 직접 주는 경로는 모든 구독에 같은
// 구간을 적용하지만(사용자가 명시한 범위이므로), recent 자동 계산은 구독마다 자기
// 커서(updateTime)와 자기 recentRescanWindowMs로 서로 다른 구간을 낸다 — resolveWindow
// 참고.
interface CollectWindow {
	hours?: number;
	from: number;
	to: number;
	advancesCursor: boolean;
}

// embedOrReuse가 서킷브레이커 대응에 필요한 만큼만 보는 조각. run()의 CollectStats와
// repairNow()의 RepairStats가 둘 다 이 모양을 가지므로, 두 경로가 같은 브레이커 로직을
// 공유할 수 있다(embedOrReuse 주석 참고) — 임베딩이 실패하는 방식은 수집 중이든 보정
// 중이든 같은 사정(모델이 죽었다)이기 때문이다.
interface EmbedBreakerStats {
	// 서킷브레이커 쿨다운을 기다린 횟수, 그리고 이번 실행에서 임베딩을 포기했는지.
	embedWaits: number;
	embedGaveUp: boolean;
}

// 한 번의 수집 실행이 무엇을 했는지. 청크 단위로 처리하면서 누적한다.
export interface CollectStats extends EmbedBreakerStats {
	collected: number;
	// 벡터가 빈 채로 저장된 논문 수. 임베딩 실패는 수집을 멈추지 않지만([3] 정책과 같은
	// 취지 — 메타데이터는 살린다), 조용히 넘어가면 사용자가 알 방법이 없어 집계해 알린다.
	embedFailed: number;
}

// 한 번의 보정 실행이 무엇을 했는지 (예전 combined 경로 — repair()가 남긴다).
export interface RepairStats extends EmbedBreakerStats {
	reembedded: number;
	reembedFailed: number;
	citationsFixed: number;
}

// 재임베딩만 돈 실행의 집계 (repairEmbeddings()가 남긴다).
export interface EmbedRepairStats extends EmbedBreakerStats {
	reembedded: number;
	reembedFailed: number;
}

// 인용수 재보강만 돈 실행의 집계 (repairCitations()가 남긴다).
export interface CitationRepairStats {
	citationsFixed: number;
}

// 큐에 들어간 작업의 종류. UI가 "무엇이 돌고 있는지"를 표시하는 데 쓴다.
export type CollectJobKind = 'recent' | 'backfill' | 'repair';

export interface CollectJob {
	kind: CollectJobKind;
	// 사람이 읽는 이름("Backfill" 등). UI 문구를 도메인이 정하는 게 아니라, 호출자가
	// 자기가 만든 작업에 이름을 붙여 보내면 그대로 되돌려준다.
	label: string;
}

// 큐 상태 한 장. 실행 중인 작업과 대기 중인 작업 수.
export interface CollectQueueState {
	active: CollectJob | undefined;
	waiting: CollectJob[];
}

export class CollectAndSave {
	sub!: Subscriptions;
	embedding!: Embedding;
	middlewares: Middleware[] = [];

	// ── 직렬 작업 큐 ───────────────────────────────────────────────
	//
	// 수집 작업은 절대 겹치면 안 된다: Embedding이 세션/서킷브레이커를 락 없이 공유하고
	// (Embedding.embed의 "동시 호출 안전하지 않음" 경고), 커서도 하나뿐이다. 그렇다고
	// 두 번째 요청을 거절할 수는 없다 — 자동 수집이 도는 중에도 사용자가 구독을 추가하거나
	// Backfill을 실행할 수 있어야 하고, 그것들은 "무시"가 아니라 "다음 차례"가 되어야 한다.
	//
	// 큐를 UI가 아니라 여기 두는 이유: UI의 잠금은 설정 탭이 다시 그려지는 순간 사라지고,
	// 나중에 TaskManager/스케줄러가 수집을 부르면 아무것도 막지 못한다. "겹치면 안 된다"는
	// 것은 이 클래스의 사정이므로 이 클래스가 지킨다.
	private tail: Promise<void> = Promise.resolve();
	private activeJob: CollectJob | undefined;
	private waitingJobs: CollectJob[] = [];
	private queueListeners: ((state: CollectQueueState) => void)[] = [];
	// 아직 시작하지 않은 recent 작업. 합침(coalescing) 대상이다 — 아래 requestRecent 참고.
	private pendingRecent: Promise<void> | undefined;
	// dispose() 이후 true. 이미 시작한 네트워크 요청은 취소할 수 없지만(requestUrl에
	// 취소 수단이 없다 — ApiSupport.requestWithTimeout 주석 참고), 이 플래그가 서는
	// 지점들(enqueue/collect/processChunk/repairNow)은 그 요청이 끝나는 대로 더 진행하지
	// 않고 멈춘다.
	private disposed = false;

	// 직전 수집 실행의 집계. UI가 완료 문구를 만들 때 읽는다(run()은 void를 반환하므로).
	lastStats: CollectStats | undefined;
	// 직전 보정 실행의 집계. lastStats와 같은 이유로 존재한다(repairNow()도 void 반환).
	lastRepairStats: RepairStats | undefined;
	// 직전 재임베딩 전용 실행(repairEmbeddings, PCA 트리거 경로)의 집계.
	lastEmbedRepairStats: EmbedRepairStats | undefined;
	// 직전 인용수 재보강 전용 실행(repairCitations, 수집 후 자동 실행)의 집계.
	lastCitationRepairStats: CitationRepairStats | undefined;

	// 한 실행에서 서킷브레이커 쿨다운을 몇 번까지 기다려줄지. 이 횟수를 넘으면 모델이
	// 회복 불가능한 상태라고 보고 임베딩을 포기한다 — embedOrReuse 주석 참고.
	private static readonly MAX_BREAKER_WAITS = 2;

	get isBusy(): boolean {
		return this.activeJob !== undefined;
	}

	get queueState(): CollectQueueState {
		return { active: this.activeJob, waiting: [...this.waitingJobs] };
	}

	// 아직 시작 안 한 recent가 줄에 있는가. 호출자가 "이미 예약돼 있으니 또 알릴 필요 없다"를
	// 판단하는 데 쓴다 — requestRecent는 합쳐주지만, 합쳐졌다는 사실을 모르면 UI는 요청한
	// 횟수만큼 진행률 Notice를 띄우게 된다.
	get hasPendingRecent(): boolean {
		return this.pendingRecent !== undefined;
	}

	// 큐가 변할 때마다(입큐/시작/종료) 불린다. UI가 버튼 상태와 안내 문구를 갱신한다.
	onQueueChange(listener: (state: CollectQueueState) => void): void {
		this.queueListeners.push(listener);
	}

	private notifyQueue(): void {
		const state = this.queueState;
		for (const listener of this.queueListeners) {
			try {
				listener(state);
			} catch (error) {
				// UI 리스너의 버그가 수집을 멈추게 두지 않는다.
				Log.error('collect', '큐 상태 리스너 실패', error);
			}
		}
	}

	// 작업 하나를 큐 끝에 붙이고, 그 작업의 완료를 기다릴 수 있는 Promise를 돌려준다.
	//
	// 반환 Promise는 작업의 실패를 그대로 전달하지만, 큐를 잇는 체인(tail)은 실패를 삼킨다 —
	// 한 작업이 실패했다고 뒤에 줄 선 작업까지 취소되면 안 되기 때문이다.
	private enqueue(job: CollectJob, task: () => Promise<void>, onStart?: () => void): Promise<void> {
		this.waitingJobs.push(job);
		Log.info('collect.queue', `입큐: ${job.label}`, {
			kind: job.kind,
			waiting: this.waitingJobs.length,
			busy: this.isBusy,
		});
		this.notifyQueue();

		const result = this.tail.then(async () => {
			this.waitingJobs = this.waitingJobs.filter((waiting) => waiting !== job);
			if (this.disposed) {
				// 플러그인이 언로드된 뒤 줄에서 차례가 온 작업 — 시작하지 않는다.
				Log.info('collect.queue', `건너뜀(언로드됨): ${job.label}`);
				this.notifyQueue();
				return;
			}
			this.activeJob = job;
			onStart?.();
			Log.info('collect.queue', `시작: ${job.label}`, { waiting: this.waitingJobs.length });
			this.notifyQueue();
			try {
				await task();
				Log.info('collect.queue', `완료: ${job.label}`);
			} finally {
				this.activeJob = undefined;
				this.notifyQueue();
			}
		});

		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// 등록 계열: 안전하게 동작한다.
	setMiddleware(mw: Middleware): void {
		this.middlewares.push(mw);
	}

	// Obsidian이 플러그인을 끄거나 리로드할 때 부른다(main.ts onunload). 지금 시도 중인
	// requestUrl 호출은 끝까지 진행되지만(취소 불가), 그 이후로는 다음 구독으로 넘어가거나
	// 다음 논문을 처리하거나 대기 중인 작업을 시작하지 않는다.
	dispose(): void {
		this.disposed = true;
	}

	// "구독이 바뀌었으니 최근 논문을 한 번 훑어라". 구독 편집 UI가 부른다.
	//
	// 아직 시작하지 않은 recent가 큐에 있으면 거기에 합친다 — 조건을 연달아 다듬으면
	// 편집할 때마다 수집이 예약될 텐데, recent는 실행 시점에 구독을 다시 읽으므로
	// (run()의 첫 줄) 한 번만 돌아도 전부 반영된다.
	//
	// 합침은 "아직 시작 안 한" 작업까지만이다. 이미 실행 중인 recent는 시작 시점의 구독
	// 목록으로 돌고 있어서 방금 추가된 구독을 보지 못한다 — 그 경우엔 새 작업을 예약해야 한다.
	requestRecent(label = '최근 논문 수집', onStart?: () => void): Promise<void> {
		if (this.pendingRecent !== undefined) {
			return this.pendingRecent;
		}
		const pending = this.enqueue({ kind: 'recent', label }, () => this.runNow('recent'), () => {
			// 시작하는 순간 합침 대상에서 빠진다.
			if (this.pendingRecent === pending) {
				this.pendingRecent = undefined;
			}
			onStart?.();
		});
		this.pendingRecent = pending;
		return pending;
	}

	// 실행 계열. 큐를 거쳐 직렬로 실행된다 — 이미 돌고 있는 작업이 있으면 그 뒤에 선다.
	// requestRecent와 달리 합치지 않는다: 호출자가 명시적으로 요청한 실행이라 임의로
	// 하나로 묶으면 "누른 만큼 돈다"는 기대가 깨진다.
	//
	// onStart는 "줄에서 빠져나와 실제로 시작했다"는 신호다. 큐가 생기면서 요청 시점과 실행
	// 시점이 갈라졌고, UI는 그 둘을 다르게 표시해야 한다(대기 중 / 수집 중).
	//
	// onTotal은 구독(API 인스턴스)마다 최대 한 번씩, 그 구독이 이번 구간에 몇 편을
	// 갖고 있는지 arXiv 응답으로 알게 되는 즉시 불린다(API.CollectOptions.onTotal 참고).
	// 여러 구독을 순회하므로 총 여러 번 불릴 수 있다 — 호출자가 값을 누적해야 전체
	// 총계가 된다.
	run(
		mode: 'recent' | 'backfill',
		testOptions?: CollectTestOptions,
		onStart?: () => void,
		onTotal?: (subtotal: number) => void,
	): Promise<void> {
		const label = mode === 'recent' ? '최근 논문 수집' : 'Backfill';
		return this.enqueue(
			{ kind: mode, label },
			() => this.runNow(mode, testOptions, onTotal),
			onStart,
		);
	}

	// targetSourceIds를 주면 그 논문들만 재시도한다. 생략하면 코퍼스 전체에서 실패 플래그가
	// 선 논문을 찾는다(수동 「보정」 버튼의 경로).
	repair(targetSourceIds?: string[], onStart?: () => void): Promise<void> {
		return this.enqueue(
			{ kind: 'repair', label: '보정' },
			() => this.repairNow(targetSourceIds),
			onStart,
		);
	}

	// 재임베딩 전용 — PCA가 needsReembedding(임베딩이 안 됐거나 깨진 논문의 sourceId)을
	// 신호로 줄 때 그 논문들만 재시도한다. 인용수는 건드리지 않는다: PCA는 임베딩만
	// 신경 쓰므로(selectValidPapers가 citationCount를 안 읽는다), 시각화를 열 때마다
	// 불필요한 S2 호출까지 딸려 가면 안 된다.
	repairEmbeddings(targetSourceIds?: string[], onStart?: () => void): Promise<void> {
		return this.enqueue(
			{ kind: 'repair', label: '재임베딩 보정' },
			() => this.repairEmbeddingsNow(targetSourceIds),
			onStart,
		);
	}

	// 인용수 재보강 전용 — 대상을 좁히지 않고 코퍼스 전체를 본다. runNow()가 수집 직후
	// 자동으로 호출하므로, 사용자가 직접 부를 일은 거의 없다(그래도 수동 호출 경로는
	// 열어 둔다).
	repairCitations(onStart?: () => void): Promise<void> {
		return this.enqueue(
			{ kind: 'repair', label: '인용수 보정' },
			() => this.repairCitationsNow(),
			onStart,
		);
	}

	// 실제 수집 몸통 — 큐가 한 번에 하나만 부른다.
	//
	// 흐름 (다이어그램 명시):
	//   전체 데이터 수집 -> 미들웨어(all) -> loop { 임베딩 -> 미들웨어(forEach) -> 데이터 저장 }
	// 이 흐름 제어는 여기서만 하고, 세부 함수가 미들웨어를 직접 호출하지 않는다.
	// mode로 backfill과 최근 논문 수집을 구분해 내부 if문으로 분기한다.
	private async runNow(
		mode: 'recent' | 'backfill',
		testOptions?: CollectTestOptions,
		onTotal?: (subtotal: number) => void,
	): Promise<void> {
		this.sub = await File.readSubscriptions();
		const apis = this.sub.apis ?? [];
		if (apis.length === 0) {
			throw new Error(
				'PaperGraph3D: 등록된 구독이 없습니다. 설정 탭에서 API와 검색 조건을 먼저 추가하세요.',
			);
		}

		// 임베딩 모델이 없으면 네트워크를 쓰기 전에 끊는다. embed()는 모델 미설치를 "실패"로
		// 치지 않아(서킷브레이커에 반영 안 함, Embedding.embed 참고) 그냥 진행하면 논문 수만큼
		// throw가 나면서도 Notice 하나 없이 전부 embeddingSucceeded=false로 저장된다. 게다가
		// 재임베딩 경로가 아직 없어(003 문서) 그렇게 저장된 논문은 다음 수집 창에 다시 걸리지
		// 않는 한 벡터가 빈 채로 영구히 남는다 — 조용히 코퍼스를 망치느니 여기서 멈춘다.
		if (!(await this.embedding.isModelInstalled())) {
			throw new Error(
				'PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 모델을 먼저 설치하세요.',
			);
		}

		Log.info('collect', `실행 시작 (${mode})`, {
			apis: apis.map((api) => ({ apiName: api.apiName, updateTime: api.updateTime })),
		});
		this.embedding.resetCircuitBreaker();
		const stats: CollectStats = {
			collected: 0,
			embedFailed: 0,
			embedWaits: 0,
			embedGaveUp: false,
		};
		let chunks = 0;
		const cursorUpdates = await this.collect(
			apis,
			mode,
			testOptions,
			(chunk) => {
				chunks += 1;
				return this.processChunk(chunk, stats);
			},
			onTotal,
		);
		if (chunks === 0) {
			// 한 편도 안 걸린 실행에서도 'all'은 빈 배열로 한 번 불린다. 미들웨어가 실행마다
			// 반드시 한 번은 호출된다는 보장이 없으면, 실행 단위로 초기화하는 미들웨어가
			// "논문이 0편인 실행"에서 조용히 건너뛰어진다.
			await this.processChunk([], stats);
		}

		Log.info('collect', '임베딩/저장 완료', stats);
		if (stats.embedFailed > 0) {
			// 조용히 넘어가면 사용자는 벡터가 빈 논문이 쌓인 걸 모른다. 보정으로 복구된다.
			Log.warn('collect', '임베딩에 실패한 논문이 있다 — 보정 패스로 재시도할 수 있다', stats);
		}
		this.lastStats = stats;

		// 구독마다 독립 커서라 갱신 대상도 구독마다 다르다 — collect()가 advancesCursor인
		// 구독만 골라 돌려준다(Backfill/테스트 hours로 돈 구독은 여기 안 낀다).
		Log.info('collect', '수집 커서 갱신', {
			updates: cursorUpdates.map((u) => ({
				apiName: u.apiName,
				cursor: new Date(u.cursor).toISOString(),
			})),
		});
		await File.updateApiCursors(cursorUpdates);

		// 인용수 재보강을 자동으로 뒤이어 돌린다 — await하지 않는다: repairCitations()도
		// enqueue()를 타는데, 지금 이 함수(runNow) 자체가 아직 끝나지 않은 큐 작업의 task()
		// 안에서 실행 중이라 여기서 기다리면 "이 작업이 끝나야 다음 작업(방금 큐에 넣은
		// repairCitations)이 시작"→"그 다음 작업을 기다리는 이 작업은 안 끝남"이 서로를
		// 기다리는 순환 대기가 된다. fire-and-forget으로 큐 뒤에 줄만 세운다.
		void this.repairCitations().catch((error) => {
			Log.error('collect', '자동 인용수 보정 실패', error);
		});
	}

	// 청크 하나를 끝까지 처리한다: 미들웨어(all) -> loop { 임베딩 -> 미들웨어(forEach) -> 저장 }.
	//
	// 다이어그램의 흐름을 청크 단위로 한 번씩 도는 형태다. 전량을 모아 한 번에 도는 예전
	// 방식은 Backfill 상한이 사라지면서 못 쓰게 됐다 — 5만 편을 다 받을 때까지 한 편도
	// 저장되지 않고, 마지막에 실패하면 전부 버려진다.
	//
	// ⚠️ 계약 변화: 'all' 미들웨어가 수집 전체가 아니라 **청크마다** 불린다. 청크 안에서
	// in-place로 항목을 덜어내는(splice) 방식은 그대로 동작하지만, 청크를 가로지르는 중복
	// 제거가 필요하면 미들웨어가 자체 상태를 들고 있어야 한다.
	//
	// ⚠️ 언로드(dispose) 신호를 여기서는 보지 않는다 — 이 청크는 이미 arXiv에서 받아온
	// 페이지 하나다. 여기서 처리를 건너뛰면 이 청크의 논문들은 저장도 안 됐는데 API 쪽
	// coverage.coveredThrough는 이미 이 지점을 지나쳤다고 기록해, 커서가 실제로 저장한
	// 지점보다 앞서가는 영구 누락을 만든다. dispose()는 그 대신 "다음 구독을 시작하지
	// 않는다"(collect() 참고)와 "다음 큐 작업을 시작하지 않는다"(enqueue 참고)는 안전한
	// 경계에서만 멈춘다 — 이미 시작한 구독 하나는 자연스러운 완료(성공/실패/상한)까지
	// 진행되도록 둔다.
	private async processChunk(papers: Paper[], stats: CollectStats): Promise<void> {
		await this.runMiddlewares('all', papers);

		for (const paper of papers) {
			// ⚠️ 반드시 순차 실행. embedOrReuse()가 실제로 새 임베딩을 계산할 때
			// embed()는 세션/서킷브레이커 상태를 락 없이 공유하므로 Promise.all 등으로
			// 병렬 호출하면 안 된다 (003 문서 "동시성 가정" 참고).
			await this.embedOrReuse(paper, stats);
			if (!paper.embeddingSucceeded) {
				stats.embedFailed += 1;
			}
			await this.runMiddlewares('forEach', paper);
			// 저장 실패는 [1] 정책대로 전파하되, 어느 논문에서 끊겼는지는 남긴다 —
			// 이게 없으면 "수집은 됐는데 파일이 일부만 있다"의 원인을 못 찾는다.
			try {
				await File.writePaper(paper);
			} catch (error) {
				Log.error('collect', '논문 저장 실패', error, { sourceId: paper.sourceId });
				throw error;
			}
			stats.collected += 1;
		}
	}

	// 보정 패스 몸통 — runNow()와 별개의 사이클. 저장된 논문 전체를 훑어 실패 플래그가 선 것만
	// 다시 시도한다: embeddingSucceeded=false는 재임베딩, citationsKnown=false는 S2 재보강.
	//
	// 큐를 두지 않는 이유: 실패 논문이 이미 디스크에 플래그로 남아 있어 파일 자체가 재시도
	// 목록이다. 별도 큐를 들고 있으면 큐와 디스크가 어긋나는 동기화 문제만 새로 생긴다.
	//
	// 미들웨어는 돌리지 않는다 — 다이어그램의 미들웨어 흐름은 수집(run) 경로에 대한 정의고,
	// 보정은 저장된 값의 필드 몇 개를 고치는 작업이라 범위 밖으로 둔다.
	//
	// ⚠️ readAllPapers()로 코퍼스 전체를 메모리에 올린다 — run() 경로는 청크 스트리밍으로
	// 이 비용을 없앴지만(CollectAndSave.prefillFromStore 참고), 보정은 "실패 플래그가 선
	// 논문을 찾는다"는 게 본질적으로 전수 조사라 페이지로 나눠 받을 날짜 구간이 없다.
	// 코퍼스가 아주 커지면 이 로드 자체가 무거워질 수 있다는 건 알려진 한계로 남겨둔다
	// (별도 인덱스 없이는 못 줄인다).
	// sourceId -> 경로 인덱스가 없어 "그 논문들만" 골라 읽을 수는 없다 — 전체를 읽은 뒤
	// targetSourceIds가 있으면 메모리에서 좁힌다. 좁혀도 디스크 읽기 비용은 그대로지만,
	// 재임베딩/재보강 루프가 도는 대상(=네트워크 호출)은 줄어든다.
	private async loadRepairTargets(targetSourceIds?: string[]): Promise<Paper[]> {
		const all = await File.readAllPapers();
		if (!targetSourceIds) {
			return all;
		}
		const targetSet = new Set(targetSourceIds);
		return all.filter((p) => targetSet.has(p.sourceId));
	}

	// 재임베딩만 하는 몸통. embedOrReuse()가 run() 경로와 같은 서킷브레이커 대응을 해준다 —
	// 브레이커가 열려 있으면 쿨다운을 기다렸다 재개하고, 계속 안 풀리면 몇 번 뒤에는
	// 포기한다(embedOrReuse 주석 참고). 보정은 실패한 논문만 모아 도는 경로라 오히려
	// 브레이커가 열릴 확률이 가장 높은 곳이다 — 예전 코드는 이 대응이 없어 브레이커가
	// 열리면 남은 논문 전부가 빈 catch로 몇 초 만에 조용히 실패했다.
	//
	// 논문마다 즉시 저장한다 — 끝에 한꺼번에 쓰면, 도중에 저장이 실패하거나 언로드되면
	// 그때까지 고친 것까지 전부 사라진다.
	private async repairEmbeddingsBody(papers: Paper[]): Promise<EmbedRepairStats> {
		const stats: EmbedRepairStats = { reembedded: 0, reembedFailed: 0, embedWaits: 0, embedGaveUp: false };
		this.embedding.resetCircuitBreaker();
		for (const paper of papers) {
			if (this.disposed) {
				// 재임베딩 루프는 안전한 경계다 — 어느 논문에서 멈추든 나머지는 그냥
				// "아직 고치지 못한 상태"로 남을 뿐, 잘못된 상태가 되는 게 아니다(run()의
				// 커서/coverage 같은 순서 의존 개념이 보정에는 없다). 다음 보정이 이어받는다.
				break;
			}
			if (paper.embeddingSucceeded) {
				continue;
			}
			await this.embedOrReuse(paper, stats);
			if (paper.embeddingSucceeded) {
				stats.reembedded += 1;
				try {
					await File.writePaper(paper);
				} catch (error) {
					Log.error('collect', '보정 중 논문 저장 실패', error, { sourceId: paper.sourceId });
					throw error;
				}
			} else {
				stats.reembedFailed += 1;
			}
		}
		return stats;
	}

	// 재보강(인용수)만 하는 몸통. 논문이 수집된 API별로 묶어 각 구현체의 EnrichCitations에
	// 맡긴다(citationsKnown 필터는 그 안에 있다). 실패해도 throw하지 않는 [3] 정책 그대로.
	private async repairCitationsBody(papers: Paper[]): Promise<CitationRepairStats> {
		const stats: CitationRepairStats = { citationsFixed: 0 };
		if (this.disposed) {
			return stats;
		}
		const secret = await File.readSecret();
		for (const apiName of File.supportedApiNames()) {
			if (this.disposed) {
				// API(서비스) 경계 — collect()가 구독 경계에서 멈추는 것과 같은 원칙.
				break;
			}
			const targets = papers.filter(
				(paper) => !paper.citationsKnown && paper.collectedApis.includes(apiName),
			);
			if (targets.length === 0) {
				continue;
			}
			await File.createApi(apiName, [], secret).EnrichCitations(targets);
			for (const paper of targets) {
				if (paper.citationsKnown) {
					stats.citationsFixed += 1;
					try {
						await File.writePaper(paper);
					} catch (error) {
						Log.error('collect', '보정 중 논문 저장 실패', error, {
							sourceId: paper.sourceId,
						});
						throw error;
					}
				}
			}
		}
		return stats;
	}

	// 재임베딩 전용 진입점 — PCA가 needsReembedding으로 좁혀준 목록을 받아 그것만 돈다.
	// 「진짜 UI」에서는 재임베딩을 이 경로(PCA 트리거)로만 실행한다: 인용수는 건드리지
	// 않으므로 시각화를 열 때마다 불필요한 S2 호출이 함께 도는 일이 없다.
	private async repairEmbeddingsNow(targetSourceIds?: string[]): Promise<void> {
		// 모델이 없으면 대상 논문 수만큼 조용히 실패만 반복하게 된다(run()의 같은 체크 참고).
		if (!(await this.embedding.isModelInstalled())) {
			throw new Error(
				'PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 모델을 먼저 설치하세요.',
			);
		}
		const papers = await this.loadRepairTargets(targetSourceIds);
		const stats = await this.repairEmbeddingsBody(papers);
		Log.info('collect', '재임베딩 보정 완료', stats);
		this.lastEmbedRepairStats = stats;
	}

	// 인용수 재보강 전용 진입점 — 대상을 좁히지 않는다(코퍼스 전체에서 citationsKnown=false를
	// 찾는다). runNow()가 수집 직후 자동으로 호출한다 — 「진짜 UI」에서는 사용자가 누를
	// 버튼 없이 수집이 끝날 때마다 조용히 따라 도는 것이 목표다.
	private async repairCitationsNow(): Promise<void> {
		const papers = await this.loadRepairTargets();
		const stats = await this.repairCitationsBody(papers);
		Log.info('collect', '인용수 보정 완료', stats);
		this.lastCitationRepairStats = stats;
	}

	// 예전 combined 경로 — 재임베딩과 재보강을 같은 대상 집합에 대해 함께 돈다. 수동 「보정」
	// 버튼/커맨드가 아직 이 경로를 쓴다.
	private async repairNow(targetSourceIds?: string[]): Promise<void> {
		if (!(await this.embedding.isModelInstalled())) {
			throw new Error(
				'PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 모델을 먼저 설치하세요.',
			);
		}
		const papers = await this.loadRepairTargets(targetSourceIds);
		const embedStats = await this.repairEmbeddingsBody(papers);
		const citationStats = await this.repairCitationsBody(papers);
		const stats: RepairStats = { ...embedStats, ...citationStats };
		Log.info('collect', '보정 완료', stats);
		this.lastRepairStats = stats;
	}

	// ── 수집 범위 ──────────────────────────────────────────────────

	// 구독(api) 하나가 이번 실행에서 훑을 구간. Backfill/테스트 hours는 사용자가 직접
	// 범위를 주는 경로라 모든 구독에 같은 구간이 나오지만(api를 실제로는 안 쓴다),
	// recent 자동 계산만큼은 그 구독 고유의 커서(api.updateTime)와 재스캔 창
	// (api.recentRescanWindowMs)을 쓴다 — 구독마다 색인 지연이 다를 수 있어서다.
	private resolveWindow(
		mode: 'recent' | 'backfill',
		testOptions: CollectTestOptions | undefined,
		api: API,
	): CollectWindow {
		const now = Date.now();

		if (mode === 'backfill') {
			// backfill은 "어느 구간을 메울지"가 본질이라 범위 없이는 의미가 없다.
			const from = testOptions?.from;
			const to = testOptions?.to;
			if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
				throw new Error(
					'PaperGraph3D: Backfill에는 수집할 구간(from/to)이 필요합니다. 설정 탭의 Backfill 버튼에서 범위를 지정해 실행하세요.',
				);
			}
			return { from, to, advancesCursor: false };
		}

		if (testOptions?.hours !== undefined) {
			const hours = testOptions.hours;
			if (!Number.isFinite(hours) || hours <= 0) {
				throw new Error(`PaperGraph3D: 수집 시간(hours)이 올바르지 않습니다 (${hours}).`);
			}
			// 범위를 직접 준 테스트 경로 — 운영 커서는 건드리지 않는다.
			return { hours, from: now - hours * 60 * 60 * 1000, to: now, advancesCursor: false };
		}

		// "최근"의 실제 폭 = 이 구독이 속한 API의 색인 지연(recentRescanWindowMs). 예전에는
		// Subscriptions 전체가 커서 하나를 공유해서, 여러 API를 묶으면 그중 가장 보수적인
		// 값(Math.max) 하나로 전부를 다시 훑어야 했다 — 커서가 구독마다 독립이 된 지금은
		// 그럴 필요가 없다. 커서가 없는 첫 실행도 같은 폭을 쓴다 — "최근"은 24시간이 아니라
		// 이 값이라는 개념 정정이다.
		const hasCursor = api.updateTime > 0;
		const referencePoint = hasCursor ? api.updateTime : now;
		return { from: referencePoint - api.recentRescanWindowMs, to: now, advancesCursor: true };
	}

	// API를 순차로 돌며 수집한다. 병렬로 부르면 같은 호스트에 동시 요청이 나가 arXiv의
	// 요청 간격 권고를 깨뜨린다. 수집 자체의 실패([1] 정책)는 그대로 전파한다 — 그러면
	// 이 함수도 예외로 끝나고, 이미 처리한 구독의 cursorUpdates까지 호출자에게 도달하지
	// 못한다. 즉 한 구독이 실패하면 이번 실행에서는 어떤 구독의 커서도 갱신되지 않는다
	// (예전에도 advanceCursor를 전체 성공 후 한 번만 불렀던 것과 같은 보수적 동작).
	//
	// 논문을 모아서 받지 않고 청크가 나올 때마다 onChunk로 처리한다 — processChunk 주석 참고.
	private async collect(
		apis: API[],
		mode: 'recent' | 'backfill',
		testOptions: CollectTestOptions | undefined,
		onChunk: (papers: Paper[]) => Promise<void>,
		onTotal?: (subtotal: number) => void,
	): Promise<{ apiName: string; querys: SearchQuery[]; cursor: number }[]> {
		const options: CollectOptions = {
			prefill: (papers) => this.prefillFromStore(papers),
			onChunk,
			onTotal,
		};
		const cursorUpdates: { apiName: string; querys: SearchQuery[]; cursor: number }[] = [];

		for (const [index, api] of apis.entries()) {
			// 플러그인이 언로드됐으면 아직 시작하지 않은 구독은 시작하지 않는다. 이미
			// 시작한 구독(index 0)은 여기 걸리지 않고 자연스럽게 끝까지 진행된다 — 그
			// 구독의 coverage가 실제로 저장한 지점과 어긋나지 않게 하려면 중간에 끊으면
			// 안 되기 때문이다(processChunk 주석 참고). 아직 손대지 않은 다음 구독은
			// 통째로 건너뛰어도 안전하다 — 그 구독의 커서는 그대로 남고, 다음 실행이
			// 처음부터 다시 훑을 뿐이다.
			if (this.disposed) {
				Log.info('collect', `언로드됨 — 남은 구독 ${apis.length - index}개는 건너뜀`);
				break;
			}
			// 한 구독의 마지막 페이지 요청과 다음 구독의 첫 요청 사이에도 간격을 둔다.
			// 페이지네이션 내부(fetchPage)의 딜레이는 각 API 구현체가 스스로 챙기지만,
			// 구독과 구독의 경계는 이 루프만 안다.
			if (index > 0) {
				await delay(api.requestDelayMs);
			}
			const window = this.resolveWindow(mode, testOptions, api);
			if (window.hours === undefined) {
				await api.Backfill(window.from, window.to, options);
			} else {
				await api.SearchRecentPaper(window.hours, options);
			}
			if (window.advancesCursor) {
				cursorUpdates.push({
					apiName: api.apiName,
					querys: api.querys,
					cursor: CollectAndSave.resolveCursor(api, window.to),
				});
			}
		}
		return cursorUpdates;
	}

	// 잘린(truncated) API는 그 지점까지만 인정한다. 요청한 구간의 끝(requestedTo)을
	// 그대로 쓰면 실제로 못 본 구간을 봤다고 기록해 영구 누락이 된다 (004 문서).
	private static resolveCursor(api: API, requestedTo: number): number {
		const coverage = api.lastCoverage;
		if (coverage !== undefined && coverage.truncated && coverage.coveredThrough < requestedTo) {
			return coverage.coveredThrough;
		}
		return requestedTo;
	}

	// 저장본에 이미 있는 값을 청크에 얹는다. 재스캔 구간은 이전에 이미 처리한 논문을 다시
	// 잡아오는데, 그 논문들에 대해 S2를 다시 두드리거나 임베딩을 다시 계산할 이유가 없다.
	//
	// 예전에는 수집 시작 전에 File.readKnownCitations()로 **코퍼스 전체**를 읽어 인용수
	// 맵을 만들고, 그와 별개로 논문마다 readStoredPaper를 또 불렀다 — 같은 파일을 두 번
	// 읽으면서 비용이 코퍼스 크기에 비례해 늘었다. 지금은 청크에 속한 논문만 한 번씩 읽어
	// 인용수와 임베딩을 동시에 채운다. 전체 스캔이 사라지고 읽기 횟수는 늘지 않는다.
	private async prefillFromStore(papers: Paper[]): Promise<void> {
		for (const paper of papers) {
			const stored = await File.readStoredPaper(paper);
			if (!stored) {
				continue;
			}
			if (stored.citationsKnown) {
				paper.citationCount = stored.citationCount;
				// references는 인용수와 같은 S2 응답에서 함께 채워진다(EnrichCitations).
				// citationsKnown만 복사하고 이걸 빼먹으면, 보강이 건너뛰어진 재스캔 논문의
				// 빈 references([] — arXiv 파싱 기본값)가 저장본의 참고문헌을 덮어쓴다.
				paper.references = stored.references ?? [];
				paper.citationsKnown = true;
			}
			if (stored.embeddingSucceeded) {
				paper.embedding = stored.embedding;
				paper.embeddingModel = stored.embeddingModel;
				paper.embeddingSource = stored.embeddingSource;
				paper.embeddingSucceeded = true;
			}
		}
	}

	// ── 미들웨어 ───────────────────────────────────────────────────

	// 등록된 미들웨어 중 type이 일치하는 것만 순서대로 호출한다. 외부 개발자가 붙인
	// 미들웨어의 버그(예외)가 수집 전체를 죽이면 확장 지점으로서 너무 위험하므로, 하나가
	// 실패해도 나머지 미들웨어와 이후 단계(임베딩/저장/커서 갱신)는 계속 진행한다.
	// Notice 등 UI를 여기서 띄우지 않는다 — CollectAndSave는 Obsidian을 몰라야 한다
	// (다이어그램/001 합의). 실패 사실은 devtools 콘솔에만 남긴다.
	private async runMiddlewares(type: Middleware['type'], context: unknown): Promise<void> {
		for (const mw of this.middlewares) {
			if (mw.type !== type) {
				continue;
			}
			try {
				await mw.run(context);
			} catch (error) {
				Log.error('collect', `'${type}' 미들웨어 실패 — 계속 진행합니다`, error);
			}
		}
	}

	// ── 논문 한 편 ─────────────────────────────────────────────────

	// 이미 벡터가 있으면 새로 계산하지 않는다. 재스캔 창(resolveWindow의
	// recentRescanWindowMs) 때문에 recent 수집은 매번 최근 논문을 다시 훑는데, 이 확인이
	// 없으면 같은 논문을 실행마다 다시 임베딩하게 된다 — 파이프라인에서 가장 비싼 단계라
	// 낭비가 크다. File.writePaperAt의 보존 규칙과 별개로(그건 안전망), 여기서 건너뛰어야
	// 애초에 비용 자체가 안 든다.
	//
	// 저장본을 읽는 일은 prefillFromStore가 청크 단위로 이미 해뒀다 — 여기서 또 읽으면
	// 같은 파일을 두 번 읽는 셈이다.
	private async embedOrReuse(paper: Paper, stats: EmbedBreakerStats): Promise<void> {
		if (paper.embeddingSucceeded) {
			return;
		}

		// 서킷브레이커가 열려 있으면 embed()는 시도조차 안 하고 즉시 throw한다. 그대로
		// 두면 남은 수천 편이 몇 초 만에 전부 빈 벡터로 저장된다 — 쿨다운을 한 번 기다려
		// 모델이 회복할 기회를 준다.
		//
		// 다만 무한정 기다릴 수도 없다: 모델이 정말 망가진 상태라면 논문마다 1분씩 서게
		// 되어 수집이 사실상 멈춘다. 몇 번 기다려도 안 되면 이번 실행에서는 임베딩을
		// 포기하고 메타데이터만 저장한다 — 벡터는 보정 패스가 채운다.
		if (!stats.embedGaveUp) {
			const cooldownMs = this.embedding.breakerCooldownRemainingMs;
			if (cooldownMs > 0) {
				if (stats.embedWaits >= CollectAndSave.MAX_BREAKER_WAITS) {
					stats.embedGaveUp = true;
					Log.warn('collect', '임베딩이 계속 실패해 이번 실행에서는 포기한다 — 메타데이터만 저장', {
						waits: stats.embedWaits,
					});
				} else {
					stats.embedWaits += 1;
					Log.warn('collect', '임베딩 서킷브레이커 열림 — 쿨다운을 기다린다', {
						cooldownMs,
						wait: stats.embedWaits,
					});
					await delay(cooldownMs);
				}
			}
		}

		if (stats.embedGaveUp) {
			CollectAndSave.markEmbeddingFailed(paper);
			return;
		}
		await this.embedOne(paper);
	}

	private async embedOne(paper: Paper): Promise<void> {
		try {
			// EmbeddingResult의 4필드가 Paper의 임베딩 4필드와 이름까지 대응하도록
			// 설계돼 있어 그대로 얹으면 된다 (003 문서).
			Object.assign(paper, await this.embedding.embed(paper.title, paper.abstract));
		} catch (error) {
			// 실패해도 저장은 한다. 스킵하면 "이 논문이 임베딩에 실패했다"는 사실이 어디에도
			// 남지 않아 나중에 재임베딩 대상을 찾을 수 없다 — SettingTab의 테스트 버튼이 내린
			// 것과 같은 판단((b) 선택, 003 문서). 가짜 벡터는 만들지 않는다.
			Log.warn('collect', '임베딩 실패 — 플래그만 남기고 계속', {
				sourceId: paper.sourceId,
				error: error instanceof Error ? error.message : String(error),
			});
			CollectAndSave.markEmbeddingFailed(paper);
		}
	}

	// "임베딩 안 됨"을 Paper에 명시적으로 남긴다. Paper.embedding이 non-nullable이라 빈
	// 배열로 채우되, embeddingSucceeded=false가 보정 패스의 재시도 대상 표식이 된다.
	private static markEmbeddingFailed(paper: Paper): void {
		paper.embedding = [];
		paper.embeddingModel = '';
		paper.embeddingSource = '';
		paper.embeddingSucceeded = false;
	}

}
