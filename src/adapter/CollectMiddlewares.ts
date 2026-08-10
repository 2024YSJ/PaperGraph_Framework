// 수집(collect) 진단 미들웨어 모음. CollectAndSave.run이 청크마다('all') 논문마다
// ('forEach') 이 미들웨어들의 run(context)을 호출한다. 새 수집 진단 미들웨어는 이 파일에
// 추가한다 — src/visualize/VisualMiddlewares.ts와 같은 자리.
import { Middleware, MiddlewareType } from '../common/Middleware';
import { Paper } from '../collect/Paper';

// 이 미들웨어들이 실제로 읽고 쓰는 진행 상태만 노출한 좁은 인터페이스. CollectController의
// ProgressFlow(Notice/label 등 UI 전용 필드 포함)를 그대로 넘기지 않고 이 타입으로만 본다.
export interface CollectProgressState {
	collected: number | undefined;
	done: number;
	// 지금 청크를 보내고 있는 API(구독)의 정보 — CollectFoundMiddleware가 채운다.
	apiName: string | undefined;
	apiConditionsText: string | undefined;
	apiFound: number;
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
export class CollectFoundMiddleware implements Middleware {
	type: MiddlewareType = 'all';

	constructor(private readonly sink: CollectProgressSink) {}

	run(context: unknown): void {
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
					flow.apiDone = 0;
				}
			}
			flow.apiFound += papers.length;
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
