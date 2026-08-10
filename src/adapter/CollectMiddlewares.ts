// 수집(collect) 진단 미들웨어 모음. CollectAndSave.run이 청크마다('all') 논문마다
// ('forEach') 이 미들웨어들의 run(context)을 호출한다. 새 수집 진단 미들웨어는 이 파일에
// 추가한다 — src/visualize/VisualMiddlewares.ts와 같은 자리.
import { Middleware, MiddlewareType } from '../common/Middleware';
import { Paper } from '../collect/Paper';
import { File } from '../common/File';

// 이 미들웨어들이 실제로 읽고 쓰는 진행 상태만 노출한 좁은 인터페이스. CollectController의
// ProgressFlow(Notice/label 등 UI 전용 필드 포함)를 그대로 넘기지 않고 이 타입으로만 본다.
export interface CollectProgressState {
	collected: number | undefined;
	done: number;
	// 지금 청크를 보내고 있는 API(구독)의 정보 — CollectFoundMiddleware가 채운다.
	apiName: string | undefined;
	apiConditionsText: string | undefined;
	apiFound: number; // 이 창(재스캔 포함)에 도착한 전체 논문 수
	apiNewFound: number; // 그중 저장소에 없던(신규) 논문 수
	apiDone: number;
}

// 지금 활성 흐름을 읽고, 갱신됐다는 사실을 알리는 창구. CollectController가 구현해서
// 미들웨어에 넘긴다 — 미들웨어는 ProgressFlow/Notice 같은 CollectController 내부 구조를
// 몰라도 된다(OpenNoteOnClickMiddleware가 App만 받고 VisualizationView 내부를 모르는
// 것과 같은 이유).
export interface CollectProgressSink {
	getActiveFlow(): CollectProgressState | undefined;
	notifyUpdated(): void;
}

// 수집 진단 미들웨어: 청크(all) 단위로 수집 건수를 세고, 지금 도는 API·조건을 관측한다.
//
// "어떤 API·조건에서 나온 청크인가"는 CollectAndSave.ts를 건드리지 않고 Paper.collectedApis/
// collectedQueries에서 읽는다 — API들은 항상 순차 처리되므로(CollectAndSave.collect() 참고)
// 한 청크의 논문은 전부 같은 API·조건에서 나온다. prefillFromStore(인용수/임베딩 보강)는
// 이 필드들을 안 건드리므로, 이 미들웨어가 받는 시점엔 아직 다른 구독과 병합되기 전
// 원본 그대로다.
//
// "추려진 논문 수"가 곧 "신규 논문 수"는 아니다 — 최근 수집은 색인 지연에 대응하려고
// recentRescanWindowMs(4일, API.ts)만큼 항상 겹치는 구간을 다시 훑으므로, 이미 저장된
// 논문도 매번 이 청크에 다시 걸린다. File.readStoredPaper로 저장 여부를 확인해 신규만
// 따로 센다 — CollectAndSave.ts는 안 건드리고 File(정적 유틸리티)을 직접 호출한다.
// prefillFromStore가 같은 목적의 조회를 이미 하므로 완전히 새로운 비용은 아니지만, 페이지당
// (최대 100편) 읽기가 한 번 더 늘어난다 — 코퍼스 전체를 훑는 비용은 아니라 감수할 만하다.
export class CollectFoundMiddleware implements Middleware {
	type: MiddlewareType = 'all';

	constructor(private readonly sink: CollectProgressSink) {}

	async run(context: unknown): Promise<void> {
		const papers = context as Paper[];
		const flow = this.sink.getActiveFlow();
		if (!flow) {
			return;
		}
		flow.collected = (flow.collected ?? 0) + papers.length;

		const first = papers[0];
		if (first) {
			const apiName = first.collectedApis[0];
			const conditionsText = first.collectedQueries[0]?.query;
			if (apiName !== undefined && conditionsText !== undefined) {
				// apiName만으로는 "같은 API, 다른 조건의 구독 두 개가 연달아 돈다"를 구분
				// 못 한다 — 조건까지 합친 키가 바뀔 때만 새 구독으로 보고 리셋한다.
				const key = `${apiName}::${conditionsText}`;
				const prevKey =
					flow.apiName === undefined ? undefined : `${flow.apiName}::${flow.apiConditionsText ?? ''}`;
				if (key !== prevKey) {
					flow.apiName = apiName;
					flow.apiConditionsText = conditionsText;
					flow.apiFound = 0;
					flow.apiNewFound = 0;
					flow.apiDone = 0;
				}
			}
			flow.apiFound += papers.length;

			// CollectAndSave는 청크(페이지)를 항상 순차로 await하며 처리하므로(collect()가
			// 다음 페이지를 요청하기 전에 이 run()이 끝까지 끝난다), 이 await 도중 다른
			// 청크·다른 실행이 flow를 바꿔치기할 일은 없다 — flow를 그대로 계속 써도 된다.
			const stored = await Promise.all(papers.map((paper) => File.readStoredPaper(paper)));
			flow.apiNewFound += stored.filter((existing) => existing === null).length;
		}

		this.sink.notifyUpdated();
	}
}

// 수집 진단 미들웨어: 논문 한 편(forEach)마다 처리 개수를 누적한다.
export class CollectDoneMiddleware implements Middleware {
	type: MiddlewareType = 'forEach';

	constructor(private readonly sink: CollectProgressSink) {}

	run(): void {
		const flow = this.sink.getActiveFlow();
		if (!flow) {
			return;
		}
		flow.done += 1;
		flow.apiDone += 1;
		this.sink.notifyUpdated();
	}
}
