import { Subscriptions } from './Subscriptions';
import { Embedding } from './Embedding';
import { Middleware } from '../common/Middleware';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { API, type CollectOptions, type SkippedEntryRecord } from './API';
import { delay, describeFailure, runQuietly } from './ApiSupport';
import { embeddingSourceOf, ExtraData, Paper } from './Paper';
import type { SearchQuery } from './SearchQuery';

// run()의 실제 수집 범위는 원래 Subscriptions(API별 SearchQuery)에서 읽어와야 하지만,
// 그게 구현되기 전까지 설정탭의 테스트 버튼이 직접 범위를 넘겨볼 수 있도록 임시로 받는
// 옵션. hours는 API.SearchRecentPaper(hours), from/to는 API.Backfill(from, to)와
// 대응한다 (2026-08-02).
export interface CollectTestOptions {
	hours?: number;
	from?: number;
	to?: number;
	// 이번 실행에서 돌 구독만 좁힌다. 생략(undefined)하면 등록된 구독 전체를 돈다 —
	// 지금까지의 기본 동작을 그대로 유지한다. 항목은 (apiName, querys)로 구독을 가리키며,
	// 8번 작업(File.hasDuplicateSubscription)이 이 조합을 구독의 유일한 신원으로
	// 보장하므로 이것만으로 특정 구독을 정확히 골라낼 수 있다.
	targetSubscriptions?: { apiName: string; querys: SearchQuery[] }[];
}

// 이번 실행에서 인용수 실패로 메모리에 붙들고 있을 Paper(임베딩 벡터 포함)의 상한.
// S2가 rate-limit/장애 중이면 대형 Backfill(수만 편)에서 거의 전부가 실패로 남을 수
// 있는데, 그걸 다 붙들면 청크 스트리밍으로 없앤 "전체를 메모리에 올리는" 문제가 되살아난다
// (processChunk 참고). 상한을 넘는 나머지는 이번 실행에서는 못 잡아도, 다음 플러그인
// 로드 때의 전수 보정(main.ts)이 결국 잡는다 — 데이터 유실은 아니고 재시도 시점만 늦다.
const MAX_TRACKED_CITATION_FAILURES = 500;

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
	// backfill 전용 — 사용자가 실제로 요청한 구간의 시작. 이어받기로 from이 앞당겨져도
	// 진행 기록의 키와 실패 메시지의 "미완료 구간"은 요청한 원래 구간이어야 한다.
	requestedFrom?: number;
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
	// 이번 실행에서 끝까지 실패한 구독들. 한 구독의 실패가 나머지 구독의 진행/커서 갱신을
	// 막지 않도록 collect()가 구독 경계에서 격리하는데(아래 collect() 주석 참고), 그
	// 대가로 "무엇이 실패했는지"를 어딘가에는 남겨야 한다 — 그게 여기다.
	failedSubscriptions: {
		apiName: string;
		querys: SearchQuery[];
		error: string;
		hint: string;
		// backfill 실패에서만 채워진다 — 어느 구간이 안 끝났는지 사용자가 알아야
		// 「과거 논문 수집」을 그 범위로 다시 열어 재입력할 수 있다.
		range?: { from: number; to: number };
	}[];
	// [2] 정책으로 arXiv 응답에서 건너뛴 항목 수의 합(API.CollectionCoverage.skippedEntries,
	// 구독마다 누적). Paper로 승격되지 못해 어디에도 저장되지 않는 항목이라, 여기서 집계하지
	// 않으면 "N편 수집" 요약만 보고는 이런 항목이 있었다는 사실 자체를 알 수 없다.
	skippedEntries: number;
	// 구독 하나라도 라운드 상한(MAX_PAGES)이나 커서 정체로 truncated된 채 끝났으면 true.
	// 그 구간은 이번 실행에서 다 못 훑었다는 뜻 — 다음 실행이 이어받지만, 그 사실 자체는
	// 알려야 한다("이번엔 일부만 봤다").
	anyTruncated: boolean;
	// citationsKnown=false로 남은 논문 중 MAX_TRACKED_CITATION_FAILURES를 넘겨 이번 실행의
	// 자동 재시도(repairCitationsBody) 대상에서 빠진 수. 이 논문들은 유실은 아니고(다음
	// 플러그인 로드 시 전수 보정이 결국 잡는다 — 위 상수 주석 참고) 재시도만 늦어진다.
	citationRetryOverflow: number;
	// 요청한 category 조건과 실제 응답이 어긋난 건수의 합(API.CollectionCoverage.
	// categoryMismatches, 구독마다 누적). 정상 상황에서는 항상 0 — 0이 아니면 수집 도중
	// 요청이 변조됐거나(8번, 프록시 재현 사례) arXiv 응답 자체가 이상했다는 신호라, 조용히
	// 넘기지 않고 사용자에게 알린다.
	categoryMismatches: number;
	// 읽는 중에 허용되지 않는 구독 조건이 걸러졌는가(9번/69번 화이트리스트 — 보통 파일을
	// 직접 편집한 경우). 예전엔 이 경우 수집 전체를 막고 throw했는데, 그러면 UI가 없는
	// 자동 실행 경로(자동 수집 스케줄러·명령 팔레트)에서는 걸러진 구독 하나 때문에 나머지
	// 멀쩡한 구독까지 아무것도 수집되지 않은 채로 계속 실패만 반복했다(사용자 요청 —
	// 리본/구독 선택 창처럼 "걸러내고 나머지는 계속 진행"이 자동 실행에서도 똑같이
	// 적용돼야 한다). 이제 막지 않고 계속 진행하되, 이 신호를 실어 CollectController가
	// (실행 경로와 무관하게) 완료 알림에 반영한다.
	droppedInvalidConditions: boolean;
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
	// 이번 실행에서 실제로 S2에 물어본 논문 수. citationsFixed와 같이 봐야 "시도했는데
	// 하나도 못 고쳤다"(구조적 실패 — 키 문제, S2 장애 등)와 "애초에 고칠 게 없었다"(0/0,
	// 정상)를 구분할 수 있다. UI가 이 값으로 Notice 여부를 판단한다(CollectController 참고)
	// — CollectAndSave 자신은 Notice를 모른다.
	attempted: number;
}

// 전체 코퍼스 강제 새로고침(인용수 강제 재조회 + 콘텐츠 동기화 + 조건부 재임베딩)의 집계
// (refreshAll()이 남긴다). citationsKnown 여부와 무관하게 코퍼스 전체를 대상으로 하므로
// "고쳐진 수"가 아니라 "다시 확인한 수"다 — repair 계열의 *Fixed와 이름을 구분한다.
// EmbedBreakerStats를 확장하는 이유는 CollectStats/RepairStats와 같다 — embedOrReuse가
// 서킷브레이커 대응에 그 두 필드를 읽고 쓴다.
export interface RefreshStats extends EmbedBreakerStats {
	citationsRefreshed: number;
	// 제목/초록이 실제로 달라져(재조회 전후 embeddingSourceOf 비교) 재임베딩까지 이어진
	// 논문 수.
	reembedded: number;
	// Refresh()가 예외를 던진 출처들 — collect()의 subscriptionFailures와 같은 이유(구독/
	// 출처 격리 실패를 사용자에게 알리는 자리). API.Refresh는 "절대 안 던진다"는 계약이
	// 없어(EnrichCitations와 달리) 구현체가 실수로 던질 수 있다 — 그 경우에도 다른 출처의
	// 새로고침은 계속 진행되고, 여기에 무엇이 실패했는지만 남는다.
	failedApis: { apiName: string; error: string }[];
	// 논문 저장(File.writePaper)이 실패한 것들 — 구독/출처 격리와 같은 원칙을 논문 단위로도
	// 적용한다. 예전엔 여기서 던지면 refreshAllBody 전체가 그 자리에서 죽어 나머지 수천 편이
	// 손도 못 댄 채 남았다(실제 재현됨). 이제 그 논문만 건너뛰고 목록에 남긴 뒤 계속 진행한다.
	failedPapers: { sourceId: string; error: string }[];
}

// 7번(부분 재조회) 실행 하나의 집계 (retrySkippedEntries()가 남긴다). recovered는
// SkippedEntries.json에서 지워진 수, stillMissing은 다시 물어봐도 여전히 없어서 남은 수.
export interface RetrySkippedStats {
	recovered: number;
	stillMissing: number;
}

// 큐에 들어간 작업의 종류. UI가 "무엇이 돌고 있는지"를 표시하는 데 쓴다.
export type CollectJobKind = 'recent' | 'backfill' | 'repair' | 'refresh';

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
	// 아직 시작하지 않은 run() 작업들 — mode+대상 구독이 같으면 새로 큐에 넣지 않고 여기
	// 걸린 Promise를 그대로 돌려준다. 사용자가 같은 버튼을 연타해도 대기 중인 동일 요청이
	// 있으면 합쳐진다(연타로 큐가 무한히 쌓이는 것을 막는다) — run() 참고.
	private pendingRuns = new Map<string, Promise<void>>();
	// 아직 시작하지 않은 refreshAll() 작업 — pendingRecent와 같은 패턴. refreshAll은
	// 대상을 좁히는 인자가 없어(항상 코퍼스 전체) 요청마다 구분할 키가 필요 없다 —
	// 「새로고침」 버튼 연타가 그대로 큐에 쌓이던 문제(57번) 방지.
	private pendingRefresh: Promise<void> | undefined;
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
	// 직전 전체 새로고침(refreshAll, 사용자가 누르는 「새로고침」 버튼)의 집계.
	lastRefreshStats: RefreshStats | undefined;
	// 직전 7번(부분 재조회, retrySkippedEntries) 실행의 집계.
	lastRetrySkippedStats: RetrySkippedStats | undefined;

	// 한 실행에서 서킷브레이커 쿨다운을 몇 번까지 기다려줄지. 이 횟수를 넘으면 모델이
	// 회복 불가능한 상태라고 보고 임베딩을 포기한다 — embedOrReuse 주석 참고.
	private static readonly MAX_BREAKER_WAITS = 2;

	// 수집 직후 자동 인용수 보정(runNow 끝)이 직전에 "시도했지만 한 건도 못 고쳤다"로
	// 끝났으면, 이 시간 안에는 다시 자동으로 시도하지 않는다. S2가 rate-limit/장애 중이면
	// 그 원인은 몇 분 안에 안 풀리는 게 보통인데, 자동 보정은 수집 주기(스케줄러는 기본
	// 몇 시간 간격이지만 사용자가 짧게 잡을 수도 있다)마다 매번 같은 실패 논문 수백 건을
	// 다시 두드리게 된다 — 개별 요청은 이미 재시도/딜레이가 있지만([3] 정책,
	// ArxivAPI.fetchCitationBatch), 그걸 매 실행마다 반복하는 것 자체가 낭비다. 사용자가
	// 명시적으로 누르는 「보정」/「인용수 보정」 버튼(repair/repairCitations 공개 메서드)은
	// 이 쿨다운을 보지 않는다 — "지금 다시 해봐라"는 요청이므로 방금 실패했어도 존중한다.
	private static readonly AUTO_CITATION_REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
	// 직전 자동 인용수 보정이 "시도했지만 0건도 못 고쳤다"로 끝난 시각. undefined면 쿨다운
	// 없음(한 번도 실패로 끝난 적 없거나, 그 뒤로 성공한 적이 있다).
	private lastCitationRepairAllFailedAt: number | undefined;

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

	// run()과 정확히 같은 키(mode+대상 구독)로 아직 시작하지 않은 요청이 이미 큐에 있는가 —
	// hasPendingRecent와 같은 이유다. run() 자체는 이미 대기 중인 요청과 합쳐 같은
	// Promise를 돌려주지만(57번, 새로고침과 같은 근본 원인), 그 사실을 모르는 호출자
	// (CollectController.runRecent/openBackfillModal)는 매 클릭마다 새 ProgressFlow와
	// Notice를 또 만든다 — run()이 내부적으로 합쳐도 UI에서는 "쌓이는 것처럼" 보였다.
	// 호출자가 실제로 run()을 부르기 전에 이걸로 먼저 확인해, 이미 대기 중이면 새
	// 진행률 UI를 만들지 않고 조용히 안내만 하게 한다.
	hasPendingRun(mode: 'recent' | 'backfill', testOptions?: CollectTestOptions): boolean {
		return this.pendingRuns.has(CollectAndSave.runKey(mode, testOptions));
	}

	// hasPendingRun과 같은 이유로 refreshAll() 전용 — CollectController.refreshAllAuto가
	// 매 클릭마다 "준비 중..." Notice를 새로 띄우기 전에 먼저 확인한다.
	get hasPendingRefresh(): boolean {
		return this.pendingRefresh !== undefined;
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
	//
	// 아직 시작하지 않은 동일 요청(mode + 대상 구독이 같음)이 큐에 있으면 새로 넣지 않고
	// 그 Promise를 합쳐 돌려준다(pendingRuns) — 사용자가 같은 버튼을 연타해도 의미 없는
	// 중복 실행이 쌓이지 않는다. targetSubscriptions가 없으면(구독 전체 대상) 항상 같은
	// 키로 취급한다. 이미 시작된 작업은 합치지 않는다 — 그 시점의 구독 목록으로 이미 돌고
	// 있어서 뒤늦은 요청은 별개로 다시 실행해야 반영된다.
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
		// 구독 하나를 시작/종료할 때마다 불린다(2번: 구독별 독립 진행 표시). index/total은
		// 이번 실행이 도는 구독 목록 안에서의 순번 — 몇 번째 구독인지 UI가 "2/3 구독"처럼
		// 표시할 수 있게 한다.
		onApiStart?: (api: API, index: number, total: number) => void,
		onApiDone?: (api: API, index: number, total: number) => void,
	): Promise<void> {
		const label = mode === 'recent' ? '최근 논문 수집' : '과거 논문 수집';
		const key = CollectAndSave.runKey(mode, testOptions);
		const pending = this.pendingRuns.get(key);
		if (pending !== undefined) {
			return pending;
		}
		const result = this.enqueue(
			{ kind: mode, label },
			() => this.runNow(mode, testOptions, onTotal, onApiStart, onApiDone),
			() => {
				// 시작하는 순간 합침 대상에서 빠진다(requestRecent와 같은 패턴).
				if (this.pendingRuns.get(key) === result) {
					this.pendingRuns.delete(key);
				}
				onStart?.();
			},
		);
		this.pendingRuns.set(key, result);
		return result;
	}

	// run() 합침 판단용 키 — mode와 대상 구독(선택 안 했으면 "전체")이 같으면 같은 요청으로
	// 본다. backfill은 날짜 범위도 다르면 별개 요청이어야 하므로 from/to까지 포함한다.
	private static runKey(mode: 'recent' | 'backfill', testOptions?: CollectTestOptions): string {
		const targets =
			testOptions?.targetSubscriptions
				?.map((t) => `${t.apiName}:${t.querys.map((q) => `${q.searchType}:${q.query}`).join(',')}`)
				.sort()
				.join('|') ?? 'ALL';
		const range = mode === 'backfill' ? `:${testOptions?.from ?? ''}~${testOptions?.to ?? ''}` : '';
		return `${mode}:${targets}${range}`;
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

	// 전체 코퍼스 강제 새로고침 — citationsKnown과 무관하게 모든 논문의 인용수를 다시
	// 조회하고, 콘텐츠(제목/초록/저자) 재조회를 지원하는 출처(API.Refresh를 구현한 것들)는
	// 최신값으로 동기화한다. 실제로 내용이 달라진 논문만 재임베딩까지 이어진다
	// (refreshAllBody가 호출 전후 embeddingSourceOf 스냅샷으로 판단). 어떤 출처가 재조회를
	// 지원하는지는 여기서 알 필요가 없다 — refreshAllBody가 API별로 Refresh 존재 여부만
	// 보고 위임한다. repair 계열과 같은 이유로 미들웨어를 돌리지 않는다(저장된 값의 필드
	// 몇 개를 고치는 작업이라 다이어그램의 수집 흐름 범위 밖 — repairEmbeddingsBody 참고).
	// repair 계열과 달리 "실패한 것만"이 아니라 "전부 다시" 확인하는 게 목적이라 별도 job
	// kind('refresh')로 둔다 — 사용자가 명시적으로 누르는 수동 동작(설정 탭/리본 「새로고침」)이다.
	//
	// onProgress는 API/구독 단위가 아니라 전체 코퍼스 논문 수 기준 flat done/total이다 —
	// 인용수/콘텐츠 재확인은 "구독별로 다른 진행"을 보여줄 이유가 없다(run()의 구독별
	// 진행률과 의도적으로 다른 모양).
	refreshAll(
		onStart?: () => void,
		onProgress?: (done: number, total: number) => void,
	): Promise<void> {
		if (this.pendingRefresh !== undefined) {
			return this.pendingRefresh;
		}
		const pending = this.enqueue(
			{ kind: 'refresh', label: '새로고침' },
			() => this.refreshAllNow(onProgress),
			() => {
				// 시작하는 순간 합침 대상에서 빠진다(requestRecent/run()과 같은 패턴).
				if (this.pendingRefresh === pending) {
					this.pendingRefresh = undefined;
				}
				onStart?.();
			},
		);
		this.pendingRefresh = pending;
		return pending;
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
		onApiStart?: (api: API, index: number, total: number) => void,
		onApiDone?: (api: API, index: number, total: number) => void,
	): Promise<void> {
		this.sub = await File.readSubscriptions();
		// 읽는 중에 허용되지 않는 조건이 걸러졌으면(9번/69번 화이트리스트 — 보통 파일을
		// 직접 편집한 경우) 여기서 값을 캡처해둔다 — 이 뒤로 다른 File 호출이 끼어들면
		// 플래그가 다시 계산돼 이 정보를 놓친다. 예전엔 이 경우 수집 전체를 막고 throw
		// 했는데, UI가 없는 자동 실행 경로(스케줄러·명령 팔레트)에서는 걸러진 구독 하나
		// 때문에 나머지 멀쩡한 구독까지 계속 아무것도 수집 못 했다 — 리본/구독 선택
		// 창(걸러내고 나머지는 진행)과 다른 동작이었다(사용자 요청으로 통일). 이제 막지
		// 않고 stats에 실어 CollectController가 완료 알림에 반영한다.
		const droppedInvalidConditions = File.lastReadDroppedInvalidConditions;
		const allApis = this.sub.apis ?? [];
		if (allApis.length === 0) {
			throw new Error(
				'PaperGraph3D: 등록된 구독이 없습니다. 설정 탭에서 API와 검색 조건을 먼저 추가하세요.',
			);
		}

		// targetSubscriptions가 있으면 이번 실행은 그 구독들만 돈다(4번 타겟팅). 선택한
		// 구독이 그 사이 삭제/수정돼 하나도 안 남았으면(신원이 바뀌어 매칭 실패) "구독이
		// 아예 없다"와는 다른 원인이므로 별도 메시지로 구분한다.
		const apis = testOptions?.targetSubscriptions
			? File.filterSubscriptions(allApis, testOptions.targetSubscriptions)
			: allApis;
		if (apis.length === 0) {
			throw new Error(
				'PaperGraph3D: 선택한 구독을 찾을 수 없습니다 — 그 사이 삭제되었거나 조건이 바뀌었을 수 있습니다.',
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
			apis: apis.map((api) => ({
				apiName: api.apiName,
				querys: api.querys.map((q) => `${q.searchType}:${q.query}`),
				updateTime: api.updateTime,
			})),
		});
		this.embedding.resetCircuitBreaker();
		const stats: CollectStats = {
			collected: 0,
			embedFailed: 0,
			embedWaits: 0,
			embedGaveUp: false,
			failedSubscriptions: [],
			skippedEntries: 0,
			anyTruncated: false,
			citationRetryOverflow: 0,
			categoryMismatches: 0,
			droppedInvalidConditions,
		};
		const failures: { citation: Paper[] } = { citation: [] };
		let chunks = 0;
		const { cursorUpdates, subscriptionFailures, skippedRecords } = await this.collect(
			apis,
			mode,
			testOptions,
			stats,
			(chunk) => {
				chunks += 1;
				return this.processChunk(chunk, stats, failures);
			},
			onTotal,
			onApiStart,
			onApiDone,
		);
		stats.failedSubscriptions = subscriptionFailures;
		if (skippedRecords.length > 0) {
			// 7번(부분 재조회)의 임시 로그 — 쓰기 실패는 수집 자체를 막지 않는다(이 파일은
			// 진단/재시도 보조용이지 수집 결과의 일부가 아니다).
			try {
				await this.appendSkippedEntries(skippedRecords);
			} catch (error) {
				Log.error('collect', 'SkippedEntries.json 기록 실패', error);
			}
		}
		if (chunks === 0) {
			// 한 편도 안 걸린 실행에서도 'all'은 빈 배열로 한 번 불린다. 미들웨어가 실행마다
			// 반드시 한 번은 호출된다는 보장이 없으면, 실행 단위로 초기화하는 미들웨어가
			// "논문이 0편인 실행"에서 조용히 건너뛰어진다.
			await this.processChunk([], stats, failures);
		}

		Log.info('collect', '임베딩/저장 완료', stats);
		if (stats.embedFailed > 0) {
			// 조용히 넘어가면 사용자는 벡터가 빈 논문이 쌓인 걸 모른다. 보정으로 복구된다.
			Log.warn('collect', '임베딩에 실패한 논문이 있다 — 보정 패스로 재시도할 수 있다', stats);
		}
		this.lastStats = stats;

		// 구독 격리(collect() 주석 참고) — 일부 구독만 실패했으면 나머지가 정상 진행됐다는
		// 뜻이므로 전체를 실패로 던지지 않는다. 다만 이번 실행에서 시도한 구독이 전부
		// 실패했으면(성공한 구독이 하나도 없으면) 예전처럼 실행 자체를 실패로 던진다 —
		// 그래야 수동 실행 경로(커맨드 팔레트/버튼)의 "실패했습니다" Notice가 여전히 뜬다.
		const firstFailure = subscriptionFailures[0];
		if (firstFailure !== undefined && subscriptionFailures.length === apis.length) {
			// collect()가 이미 구독별로 자세히 로그를 남겼다 — 여기서는 전체 실행을 실패로
			// 던질지만 판단한다. 성공한 구독이 하나라도 있으면 던지지 않는다(부분 성공은
			// 실패가 아니다) — 실패 목록 자체는 stats.failedSubscriptions에 남아 있으니
			// 완료 Notice(6번 작업)가 나중에 그 정보를 읽어 알릴 수 있다.
			const hintText = firstFailure.hint ? ` — ${firstFailure.hint}` : '';
			throw new Error(
				`PaperGraph3D: 모든 구독의 수집이 실패했습니다 — ${firstFailure.apiName}: ${firstFailure.error}${hintText}`,
			);
		}

		// 구독마다 독립 커서라 갱신 대상도 구독마다 다르다 — collect()가 advancesCursor인
		// 구독만 골라 돌려준다(Backfill/테스트 hours로 돈 구독은 여기 안 낀다).
		// 실제 저장은 collect()가 구독이 끝날 때마다 이미 마쳤다(중간에 끊겨도 끝난 구독의
		// 커서는 남는다) — 여기서는 이번 실행의 갱신 내역을 한 줄로 남기기만 한다.
		Log.info('collect', '수집 커서 갱신', {
			updates: cursorUpdates.map((u) => ({
				apiName: u.apiName,
				cursor: new Date(u.cursor).toISOString(),
			})),
		});

		// 3번: 보정 자동화(인용수) — 이번 실행에서 인용수를 못 채운 논문은 이미 메모리에
		// 있으므로(failures.citation), File.readAllPapers()로 코퍼스를 다시 훑지 않고 그
		// 논문들만 바로 재시도한다.
		//
		// enqueue()로 별도 큐 작업을 만들지 않고 여기서 직접 await한다 — repairCitationsBody는
		// private 몸통 메서드라 그 자체는 큐를 안 탄다(순환 대기 위험이 없다. enqueue()를 다시
		// 타는 건 공개 메서드 repairCitations()뿐이다). 예전엔 이걸 fire-and-forget으로
		// 큐 뒤에 줄 세웠는데, 그러면 이 함수가 캡처한 Paper 객체 참조가 나중에(다른 실행이
		// 여러 번 지난 뒤일 수도 있음) 지연 실행되면서 실행 당시 시점과 어긋난 상태로 저장될
		// 여지가 생긴다 — 직접 기다리면 그 문제 자체가 없다.
		//
		// 임베딩 실패는 그래도 여기서 즉시 재시도하지 않는다 — 방금 이 실행에서 서킷브레이커가
		// 이미 몇 번을 기다려보고 포기한 상태일 수 있는데(embedOrReuse), repairEmbeddingsBody가
		// 브레이커를 리셋하고 바로 다시 두드리면 모델이 정말 고장났을 때 트립→리셋→트립을
		// 반복하며 헛수고만 늘린다. 임베딩 재시도는 main.ts의 플러그인 로드 시 1회 전수
		// 보정(더 낮은 빈도)에 맡긴다.
		if (failures.citation.length > 0) {
			const cooldownRemaining = this.lastCitationRepairAllFailedAt
				? CollectAndSave.AUTO_CITATION_REPAIR_COOLDOWN_MS -
					(Date.now() - this.lastCitationRepairAllFailedAt)
				: 0;
			if (cooldownRemaining > 0) {
				Log.info('collect', '자동 인용수 보정 건너뜀 — 직전 시도가 전부 실패해 쿨다운 중', {
					targets: failures.citation.length,
					cooldownRemainingMs: cooldownRemaining,
				});
			} else {
				try {
					const citationRepairStats = await this.repairCitationsBody(failures.citation);
					Log.info('collect', '자동 인용수 보정 완료(이번 실행분)', citationRepairStats);
					this.lastCitationRepairStats = citationRepairStats;
					// 대상은 있었는데 한 건도 못 고쳤으면 S2가 지금 막혀 있다고 보고 쿨다운을
					// 건다. 하나라도 고쳤으면(부분 성공) 서비스가 살아있다는 뜻이라 쿨다운을 안
					// 걸고, 걸려 있던 것도 해제한다.
					this.lastCitationRepairAllFailedAt =
						citationRepairStats.citationsFixed === 0 ? Date.now() : undefined;
				} catch (error) {
					Log.error('collect', '자동 인용수 보정 실패', error);
					this.lastCitationRepairAllFailedAt = Date.now();
				}
			}
		}
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
	// failures는 이번 실행에서 인용수를 못 채운 채 남은 논문을 그대로 모아둔다 —
	// runNow()가 끝난 뒤 이 목록을 바로 재시도용 몸통(repairCitationsBody)에 넘기기
	// 위함이다(3번: 보정 자동화). 방금 처리한 Paper 객체가 이미 메모리에 있으므로, 굳이
	// File.readAllPapers()로 코퍼스를 다시 스캔하지 않고도 "이번에 실패한 것"을 정확히
	// 알 수 있다. 임베딩 실패는 여기 담지 않는다 — runNow() 끝의 주석 참고.
	private async processChunk(
		papers: Paper[],
		stats: CollectStats,
		failures: { citation: Paper[] },
	): Promise<void> {
		await this.runMiddlewares('all', papers);

		for (const paper of papers) {
			// ⚠️ 반드시 순차 실행. embedOrReuse()가 실제로 새 임베딩을 계산할 때
			// embed()는 세션/서킷브레이커 상태를 락 없이 공유하므로 Promise.all 등으로
			// 병렬 호출하면 안 된다 (003 문서 "동시성 가정" 참고).
			await this.embedOrReuse(paper, stats);
			if (!paper.embeddingSucceeded) {
				stats.embedFailed += 1;
			}
			if (!paper.citationsKnown) {
				if (failures.citation.length < MAX_TRACKED_CITATION_FAILURES) {
					failures.citation.push(paper);
				} else {
					stats.citationRetryOverflow += 1;
				}
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
		const stats: CitationRepairStats = { citationsFixed: 0, attempted: 0 };
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
			stats.attempted += targets.length;
			await File.createApi(apiName, [], secret).EnrichCitations(targets);
			for (const paper of targets) {
				if (this.disposed) {
					// 논문 단위 안전 경계 — repairEmbeddingsBody와 같은 원칙. EnrichCitations
					// 호출 자체는 이미 끝났으므로(위), 여기서 멈추는 건 "이미 받아온 결과를
					// 얼마나 저장했는가"의 문제일 뿐이다.
					break;
				}
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

	// 새로고침 몸통 — repairCitationsBody와 같은 API별 순회 구조지만 citationsKnown 필터가
	// 없다(강제 재조회가 목적). 새로고침 로직이 아는 API 표면은 apiName과 Refresh 뿐이다 —
	// 인용수 강제 재조회와 콘텐츠 동기화의 조합은 각 API 구현체(예: ArxivAPI.Refresh) 내부
	// 결정이라 여기서 알지 않는다. Refresh는 optional이라 구현하지 않은 API는 자연히
	// 건너뛴다(출처 중립).
	//
	// "실제로 바뀌었는지"는 Refresh 호출 전후 embeddingSourceOf 스냅샷을 비교해 이 메서드가
	// 직접 판단한다 — API 구현체는 "최신값을 가져와 반영한다"까지만 책임지고, 그 값으로
	// 재임베딩할지는 도메인(CollectAndSave)의 결정이라는 관심사 분리(EnrichCitations가
	// 인용수만 채우고 그걸 어디에 쓸지는 호출부가 정하는 것과 같은 구도).
	//
	// 진행률은 API별이 아니라 코퍼스 전체 논문 수 기준 flat done/total이다 — old
	// PaperGraph3D 프로젝트의 bulkRefresh.ts와 같은 단순한 형태.
	private async refreshAllBody(
		papers: Paper[],
		onProgress?: (done: number, total: number) => void,
	): Promise<RefreshStats> {
		const stats: RefreshStats = {
			citationsRefreshed: 0,
			reembedded: 0,
			embedWaits: 0,
			embedGaveUp: false,
			failedApis: [],
			failedPapers: [],
		};
		if (this.disposed) {
			return stats;
		}
		this.embedding.resetCircuitBreaker();
		const secret = await File.readSecret();
		const total = papers.length;
		let done = 0;
		for (const apiName of File.supportedApiNames()) {
			if (this.disposed) {
				// API(서비스) 경계 — repairCitationsBody와 같은 원칙.
				break;
			}
			const targets = papers.filter((paper) => paper.collectedApis.includes(apiName));
			if (targets.length === 0) {
				continue;
			}
			const api = File.createApi(apiName, [], secret);
			if (!api.Refresh) {
				// 이 출처는 재조회를 지원하지 않는다 — 갱신할 방법이 없으므로 건너뛴다.
				continue;
			}

			// Refresh 호출 전 스냅샷 — 호출 후 이 값과 달라진 논문만 재임베딩한다.
			const before = new Map(
				targets.map((paper) => [paper.sourceId, embeddingSourceOf(paper)]),
			);
			// 제목도 따로 스냅샷한다 — 저장 경로가 title을 포함해서(File.resolvePaperPath),
			// Refresh가 콘텐츠를 재조회해 제목을 바꾸면 저장 경로 자체가 바뀐다. 아래에서
			// 그 변화를 감지해 File.renamePaperFiles로 옛 파일을 새 경로로 옮긴다 —
			// 안 옮기면 새 경로에 처음 보는 파일처럼 새로 만들어져 이력이 고아가 된다.
			const titleBefore = new Map(targets.map((paper) => [paper.sourceId, paper.title]));
			try {
				// ⚠️ API.Refresh는 EnrichCitations와 달리 "절대 안 던진다"는 계약이 없다
				// (인터페이스 주석 참고) — 구현체가 실수로 던질 수 있다는 전제로 collect()와
				// 같은 출처 격리를 여기서도 명시적으로 건다. 이게 없으면 한 출처의 Refresh
				// 실패가 refreshAllBody 전체를 그 자리에서 죽여, 아직 순회하지 않은 나머지
				// 출처는 이번 새로고침에서 아예 시도조차 못 하게 된다.
				await api.Refresh(targets);
			} catch (error) {
				const { code, label, hint } = describeFailure(error);
				const hintText = hint ? ` — ${hint}` : '';
				Log.error(
					'collect',
					`새로고침 실패 [${code}] — [${apiName}] — ${label}${hintText} — 다음 출처로 진행`,
					error,
					{ apiName },
				);
				stats.failedApis.push({ apiName, error: label });
				// 이 출처의 논문들은 이번 새로고침에서 갱신되지 않았다 — done/total에도
				// 반영하지 않는다(citationsRefreshed를 늘리면 "다시 확인했다"는 뜻이 되어
				// 사실과 어긋난다).
				continue;
			}

			for (const paper of targets) {
				if (this.disposed) {
					// 논문 단위 안전 경계 — repairEmbeddingsBody와 같은 원칙(어느 논문에서
					// 멈추든 나머지는 "아직 새로고침 안 된 상태"로 남을 뿐이다). 이 출처의
					// 나머지 논문과, 아직 순회하지 않은 다음 출처는 건너뛴다.
					break;
				}
				const contentChanged = before.get(paper.sourceId) !== embeddingSourceOf(paper);
				if (contentChanged) {
					// embedOrReuse는 embeddingSucceeded가 이미 true면 재계산을 스킵한다 — 이
					// 리셋 한 줄이 곧 "재임베딩 강제 트리거"다. 서킷브레이커 대응(쿨다운
					// 대기/포기)은 embedOrReuse의 기존 로직을 그대로 탄다.
					paper.embeddingSucceeded = false;
					await this.embedOrReuse(paper, stats);
					if (paper.embeddingSucceeded) {
						stats.reembedded += 1;
					}
				}
				try {
					const oldTitle = titleBefore.get(paper.sourceId);
					if (oldTitle !== undefined && oldTitle !== paper.title) {
						const oldPaperSnapshot = Object.assign(new Paper(), paper, { title: oldTitle });
						await File.renamePaperFiles(oldPaperSnapshot, paper);
					}
					await File.writePaper(paper);
				} catch (error) {
					// 구독 격리(collect())·출처 격리(위 api.Refresh)와 같은 원칙을 논문 단위로도
					// 적용한다 — 이 논문 하나가 저장 실패했다고(디스크 문제, 파일명 충돌 등)
					// 나머지 수천 편까지 손도 못 대고 멈추면 안 된다. 실패 목록에 남기고 계속.
					const message = error instanceof Error ? error.message : String(error);
					Log.error('collect', '새로고침 중 논문 저장 실패 — 이 논문만 건너뛰고 계속', error, {
						sourceId: paper.sourceId,
					});
					stats.failedPapers.push({ sourceId: paper.sourceId, error: message });
					done += 1;
					onProgress?.(done, total);
					continue;
				}
				stats.citationsRefreshed += 1;
				done += 1;
				onProgress?.(done, total);
			}
		}
		return stats;
	}

	// 새로고침 전용 진입점 — 대상을 좁히지 않는다(코퍼스 전체). 사용자가 설정 탭/리본
	// 「새로고침」을 누를 때만 실행되는 수동 경로다(repairCitationsNow처럼 수집 후 자동으로
	// 도는 경로가 아니다).
	private async refreshAllNow(onProgress?: (done: number, total: number) => void): Promise<void> {
		const papers = await this.loadRepairTargets();
		const stats = await this.refreshAllBody(papers, onProgress);
		Log.info('collect', '새로고침 완료', stats);
		this.lastRefreshStats = stats;
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

	// ── 7번: skippedEntries 부분 재조회 (임시 기능) ─────────────────────
	//
	// collect()가 이번 실행에서 모은 스킵 레코드를 SkippedEntries.json에 이어 붙인다.
	// 같은 rawId가 여러 번 스킵되면(재스캔 창 안에서 매번 다시 걸림) 마지막 레코드로
	// 덮어써 중복이 쌓이지 않게 한다 — 그 항목이 여전히 스킵되고 있다는 사실은 skippedAt
	// 갱신만으로 충분히 드러난다.
	private async appendSkippedEntries(records: SkippedEntryRecord[]): Promise<void> {
		const existing = await File.readSkippedEntries();
		const byRawId = new Map(existing.map((r) => [r.rawId, r]));
		for (const record of records) {
			byRawId.set(record.rawId, record);
		}
		await File.writeSkippedEntries(Array.from(byRawId.values()));
	}

	// 재조회 몸통 — SkippedEntries.json에서 reason === 'missing-fields'인 레코드만
	// 골라 다시 물어본다('no-id' 레코드는 애초에 재수집 대상을 특정할 수 없어 항상
	// 제외한다). apiName별, 그리고 같은 apiName 안에서도 collectedQuery별로 묶어 각각
	// API.RetryMissingEntries를 호출한다 — collectedQuery가 다르면 복구된 논문에 붙일
	// 출처 조건(paper.collectedQueries)이 달라지므로 하나로 묶어 보내면 안 된다.
	//
	// 복구된 논문은 정상 수집과 같은 처리(임베딩 → 미들웨어 → 저장)를 거친다 — 이 경로로
	// 들어오기 전까지는 한 번도 Paper였던 적이 없으므로, processChunk가 하는 일을 그대로
	// 반복해야 한다(다만 CollectStats/citation 실패 누적 등 run() 전용 부기는 필요 없어
	// processChunk를 직접 재사용하지 않고 이 메서드 안에서 필요한 것만 한다).
	//
	// 공개 진입점이 없다 — repairNow()가 전수 보정(targetSourceIds 없음) 경로에서만
	// 조용히 함께 부른다(main.ts 로드 시 1회 + 커맨드 팔레트). 사용자가 직접 누르는
	// 버튼은 없다(2026-08-13 결정) — 대부분의 missing-fields 스킵은 스스로 다시 물어봐도
	// 같은 응답이 오므로(arXiv 쪽 데이터가 그 시점에 그렇게 생겼을 뿐, 네트워크
	// 재시도로 고쳐지는 종류가 아니다) 즉시 재시도는 의미가 적고, recent 수집의 4일
	// 재스캔 창이 이미 같은 역할을 훨씬 나은 주기로 하고 있다 — 전수 보정만이 그 창을
	// 벗어난(Backfill) 잔여분을 회수하는 유일한 자리다.
	private async retrySkippedEntriesNow(): Promise<void> {
		const all = await File.readSkippedEntries();
		const retryable = all.filter((r) => r.reason === 'missing-fields');
		const stats: RetrySkippedStats = { recovered: 0, stillMissing: 0 };
		if (retryable.length === 0) {
			this.lastRetrySkippedStats = stats;
			return;
		}
		if (!(await this.embedding.isModelInstalled())) {
			throw new Error(
				'PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 모델을 먼저 설치하세요.',
			);
		}
		this.embedding.resetCircuitBreaker();

		// (apiName, collectedQuery) 조합별로 묶는다 — 같은 조합 안에서만 rawId를 함께 물어볼
		// 수 있다.
		const groups = new Map<string, { apiName: string; collectedQuery: SearchQuery; records: SkippedEntryRecord[] }>();
		for (const record of retryable) {
			const key = `${record.apiName}::${JSON.stringify(record.collectedQuery)}`;
			const group = groups.get(key) ?? { apiName: record.apiName, collectedQuery: record.collectedQuery, records: [] };
			group.records.push(record);
			groups.set(key, group);
		}

		const secret = await File.readSecret();
		const stillMissingRecords: SkippedEntryRecord[] = [];
		const embedStats: EmbedBreakerStats = { embedWaits: 0, embedGaveUp: false };
		const groupList = Array.from(groups.values());
		for (const [index, group] of groupList.entries()) {
			if (this.disposed) {
				// 그룹 단위 안전 경계 — 다른 보정 몸통들과 같은 원칙(disposed면 break로 즉시
				// 빠져나간다). 아직 처리 안 한 이 그룹과 나머지 그룹은 레코드를 그대로 남겨
				// 다음 재수집 시도가 이어받게 한다.
				for (const remaining of groupList.slice(index)) {
					stillMissingRecords.push(...remaining.records);
				}
				break;
			}
			const api = File.createApi(group.apiName, [], secret);
			if (!api.RetryMissingEntries) {
				// 이 출처는 부분 재조회를 지원하지 않는다 — 레코드를 그대로 둔다.
				stillMissingRecords.push(...group.records);
				continue;
			}
			const rawIds = group.records.map((r) => r.rawId);
			const { recovered, stillMissingRawIds } = await api.RetryMissingEntries(rawIds, group.collectedQuery);

			// rawId(arXiv id URL)의 로컬 id(sourceId의 ':' 뒤 부분)만 뽑아 매칭한다 —
			// ArxivAPI.extractId/stripVersion과 같은 규칙이지만 그건 private이라, 여기서는
			// "저장 실패한 복구 논문을 원래 레코드로 되짚는" 최소한의 용도로만 따로 둔다.
			const localIdOf = (rawId: string): string | undefined => rawId.split('/abs/')[1]?.replace(/v\d+$/, '');
			const recordByLocalId = new Map(
				group.records
					.map((r): [string, SkippedEntryRecord] | undefined => {
						const localId = localIdOf(r.rawId);
						return localId ? [localId, r] : undefined;
					})
					.filter((entry): entry is [string, SkippedEntryRecord] => entry !== undefined),
			);

			for (const paper of recovered) {
				if (this.disposed) {
					// 논문 단위 안전 경계 — repairEmbeddingsBody와 같은 원칙. 이미
					// RetryMissingEntries로 복구는 됐지만 아직 저장 전인 논문은, 처리하지
					// 않고 넘기면 recovered로도 stillMissing으로도 안 잡혀 SkippedEntries.json
					// 기록에서 조용히 사라진다 — 다음 재수집이 다시 잡을 수 있도록 여기서도
					// stillMissing으로 남긴다.
					const orphaned = recordByLocalId.get(paper.sourceId.split(':')[1] ?? '');
					if (orphaned) {
						stillMissingRecords.push(orphaned);
					}
					continue;
				}
				await this.prefillFromStore([paper]);
				await runQuietly(() => api.EnrichCitations([paper]), 'retrySkippedEntries.EnrichCitations');
				await this.embedOrReuse(paper, embedStats);
				await this.runMiddlewares('all', [paper]);
				await this.runMiddlewares('forEach', paper);
				try {
					await File.writePaper(paper);
					stats.recovered += 1;
				} catch (error) {
					Log.error('collect', '재수집한 논문 저장 실패', error, { sourceId: paper.sourceId });
					// 저장 실패는 복구 실패와 같다 — 이 레코드를 다시 스킵 목록에 남긴다.
					const failedRecord = recordByLocalId.get(paper.sourceId.split(':')[1] ?? '');
					if (failedRecord) {
						stillMissingRecords.push(failedRecord);
					}
				}
			}

			const stillMissingSet = new Set(stillMissingRawIds);
			for (const record of group.records) {
				if (stillMissingSet.has(record.rawId)) {
					stillMissingRecords.push(record);
				}
			}
		}

		stats.stillMissing = stillMissingRecords.length;
		// 'no-id' 레코드(애초에 대상이 아니었던 것)는 그대로 보존한다.
		const untouched = all.filter((r) => r.reason !== 'missing-fields');
		await File.writeSkippedEntries([...untouched, ...stillMissingRecords]);
		Log.info('collect', '스킵 항목 재수집 완료', stats);
		this.lastRetrySkippedStats = stats;
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

		// 7번(부분 재조회) — 특정 논문만 겨냥한 보정(targetSourceIds 지정)에는 끼지 않는다.
		// 이건 논문이 아니라 SkippedEntries.json(코퍼스 전체)을 대상으로 하므로, "이
		// 논문들만 고쳐라"는 좁힌 호출 의도와 안 맞는다. 전수 보정(플러그인 로드/커맨드
		// 팔레트, targetSourceIds 없음)에서만 조용히 같이 돈다 — 실패해도 나머지 보정
		// 결과에 영향 주지 않도록 예외를 삼킨다.
		if (targetSourceIds === undefined) {
			try {
				await this.retrySkippedEntriesNow();
			} catch (error) {
				Log.error('collect', '자동 스킵 항목 재수집 실패', error);
			}
		}
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
		// 이 구독의 이 구간에 저장된 backfill 이어받기 지점(File.findBackfillResumePoint).
		// 없으면 요청한 from부터 훑는다.
		resumeFrom?: number,
	): CollectWindow {
		const now = Date.now();

		if (mode === 'backfill') {
			// backfill(과거 논문 수집)은 "어느 구간을 메울지"가 본질이라 범위 없이는 의미가 없다.
			const from = testOptions?.from;
			const to = testOptions?.to;
			if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
				throw new Error(
					'PaperGraph3D: 과거 논문 수집에는 수집할 구간(from/to)이 필요합니다. 수집 메뉴의 과거 논문 수집 항목에서 범위를 지정해 실행하세요.',
				);
			}
			// from >= to(역순 또는 미래 범위 등)를 그대로 흘려보내면 API.collectWindow가
			// "요청할 게 없다"고 보고 조용히 0편으로 끝낸다(coverage만 채우고 네트워크
			// 요청도 안 나감) — 그 결과 완료 Notice가 "0편 수집 완료했습니다"로 떠서, 입력
			// 자체가 잘못됐다는 걸 사용자가 알 방법이 없었다(실제 재현됨). 여기서 던지면
			// 이 구독(들)의 실패로 잡혀 다른 검증 오류(searchType 오타 등)와 같은 경로로
			// Notice/힌트가 뜬다.
			if (from >= to) {
				throw new Error(
					'PaperGraph3D: 과거 논문 수집 구간이 올바르지 않습니다(시작이 종료보다 뒤이거나 같음) — 날짜를 확인하세요.',
				);
			}
			// 순방향 구간(from < to)이어도 종료일이 미래면 여전히 잘못된 입력이다 —
			// backfill은 "과거 논문을 메운다"는 게 본질인데, 미래 구간은 arXiv에 애초에
			// 존재할 수 없는 논문을 요청하는 것이라 항상 정직하게 0편만 돌아온다(재현됨:
			// "미래-미래"). from>=to와 달리 순서는 맞으니 위 검사는 안 걸리지만, 사용자가
			// 의도한 게 "과거 구간"이 아니라는 점은 똑같다.
			//
			// ⚠️ 단순히 `to > now`로 비교하면 안 된다 — SubscriptionTargetModal이 "종료일
			// 당일 포함"을 위해 선택한 날짜의 다음날 자정을 to로 넘긴다(실사용 확인). 오늘을
			// 종료일로 골라도 to는 항상 "내일 자정"이라 지금 이 순간(now)보다 큰 게 정상이다
			// — 그대로 비교하면 "오늘까지"조차 미래 취급되어 막혀버린다. 실제로 막아야 하는
			// 건 "선택한 종료일 자체가 오늘보다 뒤"인 경우이므로, 내일 자정까지는 허용한다.
			const nowLocal = new Date(now);
			const startOfTomorrow = new Date(
				nowLocal.getFullYear(),
				nowLocal.getMonth(),
				nowLocal.getDate() + 1,
			).getTime();
			if (to > startOfTomorrow) {
				throw new Error(
					'PaperGraph3D: 과거 논문 수집 구간의 종료일이 미래입니다 — 오늘 이전 날짜로 지정하세요.',
				);
			}
			// 지난 실행이 남긴 지점부터 이어받는다 — 그 앞 구간의 논문은 이미 저장까지
			// 끝났다. resumeFrom은 findBackfillResumePoint가 구간 안쪽임을 이미 확인한
			// 값이라 여기서 다시 검사하지 않는다.
			if (resumeFrom !== undefined) {
				Log.info('collect', 'backfill 이어받기 — 지난 실행이 멈춘 지점부터 훑는다', {
					apiName: api.apiName,
					requestedFrom: new Date(from).toISOString(),
					resumeFrom: new Date(resumeFrom).toISOString(),
					to: new Date(to).toISOString(),
				});
				return { from: resumeFrom, to, advancesCursor: false, requestedFrom: from };
			}
			return { from, to, advancesCursor: false, requestedFrom: from };
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
	// 요청 간격 권고를 깨뜨린다.
	//
	// 구독 격리: 한 구독의 수집 실패([1] 정책)는 그 구독만 건너뛰고 나머지 구독은 계속
	// 진행한다 — 예전에는 한 구독이 throw하면 이 함수 전체가 예외로 끝나 이미 처리한
	// 구독의 cursorUpdates까지 호출자에게 도달하지 못했다. 문제는 arXiv "쿼리 거부됨"
	// 같은 실패는 일시적 장애가 아니라 그 구독의 설정 자체가 잘못됐다는 뜻이라, 자동
	// 실행(스케줄러)에서는 매번 같은 지점에서 죽어 나머지 정상 구독까지 영구히 막혔다.
	// 실패한 구독은 cursorUpdates에서 빠지므로(advancesCursor 여부와 무관하게 아예 안
	// 올라간다) 다음 실행이 같은 구간을 다시 시도한다 — 실패를 봤다고 커서를 전진시키지
	// 않는 원칙은 그대로 지킨다. 실패 목록은 실패자(runNow)가 로그/Notice로 알린다.
	//
	// 논문을 모아서 받지 않고 청크가 나올 때마다 onChunk로 처리한다 — processChunk 주석 참고.
	private async collect(
		apis: API[],
		mode: 'recent' | 'backfill',
		testOptions: CollectTestOptions | undefined,
		stats: CollectStats,
		onChunk: (papers: Paper[]) => Promise<void>,
		onTotal?: (subtotal: number) => void,
		onApiStart?: (api: API, index: number, total: number) => void,
		onApiDone?: (api: API, index: number, total: number) => void,
	): Promise<{
		cursorUpdates: { apiName: string; querys: SearchQuery[]; cursor: number }[];
		subscriptionFailures: {
			apiName: string;
			querys: SearchQuery[];
			error: string;
			hint: string;
			range?: { from: number; to: number };
		}[];
		skippedRecords: SkippedEntryRecord[];
	}> {
		// backfill 이어받기 지점은 실행 시작 시 한 번만 읽는다 — 이 실행이 도는 동안
		// 쓰는 쪽도 여기(아래 onRoundComplete)뿐이라, 매 구독마다 다시 읽을 이유가 없다.
		const backfillProgress = mode === 'backfill' ? await File.readBackfillProgress() : [];
		const cursorUpdates: { apiName: string; querys: SearchQuery[]; cursor: number }[] = [];
		const subscriptionFailures: {
			apiName: string;
			querys: SearchQuery[];
			error: string;
			hint: string;
			range?: { from: number; to: number };
		}[] = [];
		// 7번(부분 재조회)용 원자재 — CollectStats에는 안 넣는다(그 인터페이스는 이 기능이
		// 없어져도 남아야 하는 핵심 통계라 임시 기능과 섞지 않는다). runNow()가 이 배열을
		// 그대로 SkippedEntries.json에 append한다.
		const skippedRecords: SkippedEntryRecord[] = [];

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
			// 이 구독이 실제로 몇 편을 내놓든(0편이어도) "지금 이 구독을 시작/종료했다"는
			// 사실 자체를 직접 알린다 — 예전에는 Paper.collectedApis를 청크에서 역추론했는데,
			// 그 방식은 결과가 0편인 구독의 시작/종료가 UI에 아예 안 잡히는 문제가 있었다
			// (2번: 구독별 독립 진행 표시의 선행 조건).
			onApiStart?.(api, index, apis.length);
			// 지금 어느 구독(apiName + 조건)이 도는지 명시적으로 남긴다 — 이게 없으면
			// 로그만 보고는 "수집 중"이라는 사실만 알 뿐 무엇을 수집하는지 알 수 없다.
			Log.info('collect', '구독 수집 시작', {
				index: `${index + 1}/${apis.length}`,
				apiName: api.apiName,
				querys: api.querys.map((q) => `${q.searchType}:${q.query}`),
			});
			let window: CollectWindow | undefined;
			try {
				window = this.resolveWindow(
					mode,
					testOptions,
					api,
					mode === 'backfill' && testOptions?.from !== undefined && testOptions.to !== undefined
						? File.findBackfillResumePoint(
								backfillProgress,
								api.apiName,
								api.querys,
								testOptions.from,
								testOptions.to,
							)
						: undefined,
				);
				const requestedFrom = window.requestedFrom;
				const requestedTo = window.to;
				const options: CollectOptions = {
					prefill: (papers) => this.prefillFromStore(papers),
					onChunk,
					onTotal,
					// backfill만 진행 지점을 남긴다. recent는 구독 커서(updateTime)가 같은
					// 역할을 이미 하고 있어 두 벌로 관리할 이유가 없다.
					onRoundComplete:
						requestedFrom === undefined
							? undefined
							: (coveredThrough) =>
									File.saveBackfillProgress({
										apiName: api.apiName,
										querys: api.querys,
										from: requestedFrom,
										to: requestedTo,
										coveredThrough,
										updatedAt: Date.now(),
									}),
				};
				if (window.hours === undefined) {
					await api.Backfill(window.from, window.to, options);
				} else {
					await api.SearchRecentPaper(window.hours, options);
				}
				// 요청 구간을 끝까지 훑었으면 이어받기 기록은 필요 없다. 남겨두면 같은
				// 구간을 다시 요청했을 때 "이미 끝난 지점"에서 시작해 0편으로 끝난다.
				// 커서 정체 등으로 잘린 채(truncated) 끝났으면 기록을 남겨 다음 실행이
				// 그 지점부터 다시 시도하게 둔다.
				if (requestedFrom !== undefined && api.lastCoverage?.truncated !== true) {
					await runQuietly(
						() => File.clearBackfillProgress(api.apiName, api.querys),
						'collect.clearBackfillProgress',
					);
				}
				onApiDone?.(api, index, apis.length);
				Log.info('collect', '구독 수집 완료', {
					apiName: api.apiName,
					querys: api.querys.map((q) => `${q.searchType}:${q.query}`),
				});
				// 이 구독이 남긴 coverage를 실행 전체 집계에 얹는다 — [2] 정책으로 건너뛴
				// 항목과 truncated 여부는 논문 하나하나가 아니라 구독(수집 구간) 단위로
				// 나오므로, processChunk가 아니라 여기서만 읽을 수 있다.
				const coverage = api.lastCoverage;
				if (coverage !== undefined) {
					stats.skippedEntries += coverage.skippedEntries;
					if (coverage.truncated) {
						stats.anyTruncated = true;
					}
					skippedRecords.push(...coverage.skipped);
					stats.categoryMismatches += coverage.categoryMismatches;
				}
				if (window.advancesCursor) {
					const update = {
						apiName: api.apiName,
						querys: api.querys,
						cursor: CollectAndSave.resolveCursor(api, window.to),
					};
					cursorUpdates.push(update);
					// 구독이 끝나는 즉시 저장한다. 예전에는 실행이 전부 끝난 뒤 한 번에
					// 썼는데, 그러면 구독 3개 중 2개가 끝난 상태에서 기기가 꺼지면 이미
					// 끝난 2개의 커서까지 같이 날아가 다음 실행이 같은 구간을 다시 훑었다.
					await File.updateApiCursors([update]);
				}
			} catch (error) {
				// 이 구독은 실패로 남기고 다음 구독으로 넘어간다 — 이미 이 구독이 emit한
				// 청크(onChunk를 통해 processChunk가 저장까지 끝낸 논문)는 그대로 유효하다.
				// 실패했다고 그 논문들을 되돌리지 않는다. 커서만 안 올라가 다음 실행이
				// 같은 구간을 다시 훑는다.
				onApiDone?.(api, index, apis.length);
				// describeFailure가 짧은 사유(코드/상태코드) + "그래서 뭘 확인하면 되는지"
				// 힌트까지 함께 준다 — HttpRequestError의 원래 message는 요청 URL 전체
				// (검색어 인코딩 포함)를 담고 있어 Notice/로그 한 줄에 넣기엔 너무 길고
				// 잡음이 많다. 전체 스택은 Log.error의 error 인자로 이미 따로 남는다.
				const { code, label, hint } = describeFailure(error);
				// backfill이 실패하면 어느 구간이 안 끝났는지 사용자가 알아야 재입력할 수
				// 있다 — window가 resolveWindow까지 성공한 뒤(즉 range 자체는 유효했는데
				// 네트워크 등으로 중단된 경우)에만 채워진다. window가 없으면(범위 검증
				// 자체가 실패) 이미 error 메시지가 원인을 설명하므로 range는 생략한다.
				// 사용자에게는 "요청한 구간 중 어디가 안 끝났는지"를 보여준다 — 이어받기로
				// 앞당겨진 window.from이 아니라 원래 요청한 구간이 기준이다.
				const range =
					mode === 'backfill' && window !== undefined
						? { from: window.requestedFrom ?? window.from, to: window.to }
						: undefined;
				subscriptionFailures.push({
					apiName: api.apiName,
					querys: api.querys,
					error: label,
					hint,
					range,
				});
				// 메시지 문자열 자체에 "어느 구독이 왜 죽었는지, 뭘 확인해야 하는지"가 다
				// 들어가야 한다 — 로그를 죽 훑을 때 매 줄 뒤의 JSON을 펼쳐보지 않고도 원인과
				// 대응을 바로 알 수 있게. code를 대괄호로 붙이는 건 이 코드베이스가 이미
				// [1]/[2]/[3] 정책 태그를 쓰는 관례를 그대로 따른 것 — grep 한 번으로 같은
				// 종류의 실패를 모아볼 수 있다.
				const querysText = api.querys.map((q) => `${q.searchType}:${q.query}`).join(' AND ');
				const hintText = hint ? ` — ${hint}` : '';
				const rangeText = range
					? ` — 미완료 구간 ${CollectAndSave.formatDate(range.from)}~${CollectAndSave.formatDate(range.to)}`
					: '';
				Log.error(
					'collect',
					`구독 수집 실패 [${code}] — [${api.apiName}] ${querysText} — ${label}${hintText}${rangeText} — 다음 구독으로 진행`,
					error,
					{ apiName: api.apiName, querys: api.querys.map((q) => `${q.searchType}:${q.query}`) },
				);
			}
		}
		return { cursorUpdates, subscriptionFailures, skippedRecords };
	}

	// 실패 메시지에 넣을 사람이 읽는 날짜(YYYY-MM-DD). 시각까지는 필요 없다 — backfill
	// 범위는 항상 날짜 단위로 고른다(SubscriptionTargetModal).
	private static formatDate(ms: number): string {
		return new Date(ms).toISOString().slice(0, 10);
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
			// 미들웨어가 붙여둔 값(요약·클러스터 라벨 등)도 같이 되살린다. API에서 갓 받아온
			// Paper의 extra는 비어 있어서, 이게 없으면 재스캔에 걸린 논문마다 미들웨어가
			// "아직 요약이 없다"고 보고 매번 다시 만든다 — 위 인용수/임베딩을 되살리는 이유와
			// 같다. 위 둘과 달리 조건이 없는 것은, extra에는 "쓸모 있는 값인가"를 뜻하는
			// 플래그가 없기 때문이다(미들웨어마다 채워졌다는 기준이 다르다). 저장본에 아무것도
			// 없으면 빈 ExtraData가 되어 지금과 같다.
			paper.extra = Object.assign(new ExtraData(), stored.extra);
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
