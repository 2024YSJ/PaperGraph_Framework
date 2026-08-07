import { Subscriptions } from './Subscriptions';
import { Embedding } from './Embedding';
import { Middleware } from '../common/Middleware';
import { File } from '../common/File';
import { API } from './API';
import { Paper } from './Paper';

// run()의 실제 수집 범위는 원래 Subscriptions(API별 SearchQuery)에서 읽어와야 하지만,
// 그게 구현되기 전까지 설정탭의 테스트 버튼이 직접 범위를 넘겨볼 수 있도록 임시로 받는
// 옵션. hours는 API.SearchRecentPaper(hours), from/to는 API.Backfill(from, to)와
// 대응한다 (2026-08-02).
export interface CollectTestOptions {
	hours?: number;
	from?: number;
	to?: number;
}

// 이번 실행이 훑을 구간. hours가 있으면 SearchRecentPaper로, 없으면 Backfill로 부른다.
// advancesCursor는 "이 실행 결과를 Subscriptions.updateTime에 반영해도 되는가" —
// 테스트 경로(직접 범위를 준 경우)가 운영 커서를 오염시키지 않게 구분한다.
interface CollectWindow {
	hours?: number;
	from: number;
	to: number;
	advancesCursor: boolean;
}

export class CollectAndSave {
	sub!: Subscriptions;
	embedding!: Embedding;
	middlewares: Middleware[] = [];

	// 등록 계열: 안전하게 동작한다.
	setMiddleware(mw: Middleware): void {
		this.middlewares.push(mw);
	}

	// 실행 계열.
	//
	// 흐름 (다이어그램 명시):
	//   전체 데이터 수집 -> 미들웨어(all) -> loop { 임베딩 -> 미들웨어(forEach) -> 데이터 저장 }
	// 이 흐름 제어는 run() 안에서만 하고, 세부 함수가 미들웨어를 직접 호출하지 않는다.
	// mode로 backfill과 최근 논문 수집을 구분해 run() 내부 if문으로 분기한다.
	async run(mode: 'recent' | 'backfill', testOptions?: CollectTestOptions): Promise<void> {
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

		const window = this.resolveWindow(mode, testOptions, apis);
		const papers = await this.collect(apis, window);

		// 'all' 미들웨어는 수집 결과 전체를 한 번 받는다. 받는 배열은 아래 루프가 그대로
		// 쓰는 바로 그 배열이라, 미들웨어가 in-place로 항목을 덜어내면(splice 등) 이후
		// 임베딩·저장 단계가 줄어든 목록을 본다 — 중복 제거가 이 자리에 미들웨어로 붙는다.
		// (Middleware.run은 void를 반환하므로 새 배열을 돌려주는 방식은 쓸 수 없다.)
		await this.runMiddlewares('all', papers);

		this.embedding.resetCircuitBreaker();
		for (const paper of papers) {
			// ⚠️ 반드시 순차 실행. embedOrReuse()가 실제로 새 임베딩을 계산할 때
			// embed()는 세션/서킷브레이커 상태를 락 없이 공유하므로 Promise.all 등으로
			// 병렬 호출하면 안 된다 (003 문서 "동시성 가정" 참고).
			await this.embedOrReuse(paper);
			await this.runMiddlewares('forEach', paper);
			await File.writePaper(paper);
		}

		if (window.advancesCursor) {
			await this.advanceCursor(apis, window.to);
		}
	}

	// 보정 패스 — run()과 별개의 사이클. 저장된 논문 전체를 훑어 실패 플래그가 선 것만
	// 다시 시도한다: embeddingSucceeded=false는 재임베딩, citationsKnown=false는 S2 재보강.
	//
	// 큐를 두지 않는 이유: 실패 논문이 이미 디스크에 플래그로 남아 있어 파일 자체가 재시도
	// 목록이다. 별도 큐를 들고 있으면 큐와 디스크가 어긋나는 동기화 문제만 새로 생긴다.
	//
	// 미들웨어는 돌리지 않는다 — 다이어그램의 미들웨어 흐름은 수집(run) 경로에 대한 정의고,
	// 보정은 저장된 값의 필드 몇 개를 고치는 작업이라 범위 밖으로 둔다.
	async repair(): Promise<void> {
		// 재임베딩이 섞여 있으므로 run()과 같은 사전 체크 — 모델이 없으면 대상 논문 수만큼
		// 조용히 실패만 반복하게 된다(CollectAndSave.run의 같은 체크 주석 참고).
		if (!(await this.embedding.isModelInstalled())) {
			throw new Error(
				'PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 모델을 먼저 설치하세요.',
			);
		}

		const papers = await File.readAllPapers();
		const changed = new Set<Paper>();

		// 1) 재임베딩. embed()는 순차 호출만 안전하다 — run()과 같은 계약.
		this.embedding.resetCircuitBreaker();
		for (const paper of papers) {
			if (paper.embeddingSucceeded) {
				continue;
			}
			try {
				Object.assign(paper, await this.embedding.embed(paper.title, paper.abstract));
				changed.add(paper);
			} catch {
				// 또 실패 — 값이 이미 빈 상태 그대로이므로 다시 쓸 것도 없다. 플래그는
				// false로 남아 다음 보정에서 또 시도된다.
			}
		}

		// 2) 재보강. 논문이 수집된 API별로 묶어 각 구현체의 EnrichCitations에 맡긴다
		// (citationsKnown 필터는 그 안에 있다). 실패해도 throw하지 않는 [3] 정책 그대로.
		const secret = await File.readSecret();
		for (const apiName of File.supportedApiNames()) {
			const targets = papers.filter(
				(paper) => !paper.citationsKnown && paper.collectedApis.includes(apiName),
			);
			if (targets.length === 0) {
				continue;
			}
			await File.createApi(apiName, [], secret).EnrichCitations(targets);
			for (const paper of targets) {
				if (paper.citationsKnown) {
					changed.add(paper);
				}
			}
		}

		// 3) 실제로 값이 바뀐 논문만 재저장 — 전체 재저장은 updatedAt만 더럽힌다.
		for (const paper of changed) {
			await File.writePaper(paper);
		}
	}

	// ── 수집 범위 ──────────────────────────────────────────────────

	private resolveWindow(
		mode: 'recent' | 'backfill',
		testOptions: CollectTestOptions | undefined,
		apis: API[],
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

		// "최근"의 실제 폭 = 구독된 API들의 색인 지연 중 가장 보수적인 값(recentRescanWindowMs
		// 최댓값). 이 값을 API 계층으로 옮긴 이유는 API.ts의 recentRescanWindowMs 주석 참고.
		// 커서가 없는 첫 실행도 같은 폭을 쓴다 — "최근"은 이제 24시간이 아니라 이 값이라는
		// 개념 정정이다(코드만 반영, UI 문구·사용자 공지는 별도).
		const recentWindowMs = Math.max(...apis.map((api) => api.recentRescanWindowMs));
		const cursor = this.sub.updateTime;
		const hasCursor = typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0;
		const referencePoint = hasCursor ? cursor : now;
		return { from: referencePoint - recentWindowMs, to: now, advancesCursor: true };
	}

	// API를 순차로 돌며 수집한다. 병렬로 부르면 같은 호스트에 동시 요청이 나가 arXiv의
	// 요청 간격 권고를 깨뜨린다. 수집 자체의 실패([1] 정책)는 그대로 전파한다.
	//
	// knownCitations를 수집 전에 한 번 읽어 모든 API 호출에 넘긴다 — 재스캔이 이전에 이미
	// 보강을 끝낸 논문을 다시 잡아와도 S2 등 외부 API를 다시 두드리지 않게 하려는 목적이다
	// (API.ts의 knownCitations 계약 참고).
	private async collect(apis: API[], window: CollectWindow): Promise<Paper[]> {
		const knownCitations = await File.readKnownCitations();
		const collected: Paper[] = [];
		for (const api of apis) {
			const papers =
				window.hours === undefined
					? await api.Backfill(window.from, window.to, knownCitations)
					: await api.SearchRecentPaper(window.hours, knownCitations);
			collected.push(...papers);
		}
		return collected;
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
				console.error(`[PaperGraph3D] '${type}' 미들웨어 실패 — 계속 진행합니다.`, error);
			}
		}
	}

	// ── 논문 한 편 ─────────────────────────────────────────────────

	// 저장된 논문이 이미 임베딩에 성공했으면 그 벡터를 재사용하고, 아니면 새로 임베딩한다.
	// 재스캔 창(resolveWindow의 recentRescanWindowMs) 때문에 recent 수집은 매번 최근
	// 논문을 다시 훑는데, 이 확인이 없으면 같은 논문을 실행마다 다시 임베딩하게 된다 —
	// 파이프라인에서 가장 비싼 단계라 낭비가 크다. File.writePaperAt의 보존 규칙과
	// 별개로(그건 안전망), 여기서 건너뛰어야 애초에 비용 자체가 안 든다.
	private async embedOrReuse(paper: Paper): Promise<void> {
		const stored = await File.readStoredPaper(paper);
		if (stored?.embeddingSucceeded) {
			paper.embedding = stored.embedding;
			paper.embeddingModel = stored.embeddingModel;
			paper.embeddingSource = stored.embeddingSource;
			paper.embeddingSucceeded = true;
			return;
		}
		await this.embedOne(paper);
	}

	private async embedOne(paper: Paper): Promise<void> {
		try {
			// EmbeddingResult의 4필드가 Paper의 임베딩 4필드와 이름까지 대응하도록
			// 설계돼 있어 그대로 얹으면 된다 (003 문서).
			Object.assign(paper, await this.embedding.embed(paper.title, paper.abstract));
		} catch {
			// 실패해도 저장은 한다. 스킵하면 "이 논문이 임베딩에 실패했다"는 사실이 어디에도
			// 남지 않아 나중에 재임베딩 대상을 찾을 수 없다 — SettingTab의 테스트 버튼이 내린
			// 것과 같은 판단((b) 선택, 003 문서). 가짜 벡터는 만들지 않는다.
			paper.embedding = [];
			paper.embeddingModel = '';
			paper.embeddingSource = '';
			paper.embeddingSucceeded = false;
		}
	}

	// ── 커서 ───────────────────────────────────────────────────────

	// 잘린(truncated) API가 하나라도 있으면 그 지점까지만 인정한다. 요청한 구간의 끝(to)을
	// 그대로 저장하면 실제로 못 본 구간을 봤다고 기록해 영구 누락이 된다 (004 문서).
	private async advanceCursor(apis: API[], to: number): Promise<void> {
		let cursor = to;
		for (const api of apis) {
			const coverage = api.lastCoverage;
			if (coverage !== undefined && coverage.truncated && coverage.coveredThrough < cursor) {
				cursor = coverage.coveredThrough;
			}
		}
		this.sub.updateTime = cursor;
		await File.writeSubscriptions(this.sub);
	}
}
