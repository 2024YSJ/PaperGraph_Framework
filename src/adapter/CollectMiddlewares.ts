// 수집(collect) 진단 미들웨어 모음. CollectAndSave.run이 청크마다('all') 논문마다
// ('forEach') 이 미들웨어들의 run(context)을 호출한다. 새 수집 진단 미들웨어는 이 파일에
// 추가한다 — src/visualize/VisualMiddlewares.ts와 같은 자리.
import { Middleware, MiddlewareType } from '../common/Middleware';
import { Paper } from '../collect/Paper';

// 구독 하나의 진행 상태. CollectController가 CollectAndSave.run의 onApiStart/onApiDone으로
// 만들고(순서·이름·조건은 여기서 확정), 이 미들웨어들은 지금 활성 구독(currentIndex)의
// found/done만 채운다 — "몇 번째 구독인가"는 청크의 내용을 몰라도 이미 알고 있으므로
// Paper.collectedApis를 다시 읽어 추론할 필요가 없다.
export interface SubscriptionProgressEntry {
	apiName: string;
	conditionsText: string;
	status: 'running' | 'done';
	found: number;
	done: number;
	// 이 구독이 이번 구간에 실제로 몇 편을 갖고 있는지(API.CollectOptions.onTotal이
	// 알려주는 값) — CollectController가 채운다. -1이면 아직 모름. found를 분모로 쓰면
	// 페이지(청크)가 도착할 때마다 분모 자체가 같이 늘어나(예: 0/100 -> 101/200처럼) 실제
	// 진행률처럼 안 보이는 문제가 있었다 — total은 API가 알려준 실제 총 편수라 페이지가
	// 넘어가도 그대로다.
	total: number;
	// 이번 실행에서 몇 번째 구독인지(0-based)와 전체 구독 수 — CollectAndSave.collect()가
	// onApiStart/onApiDone에 이미 넘겨주는 index/total을 CollectController가 그대로
	// 옮겨 담는다(6번: 여러 구독 중 몇 번째인지 표시).
	index: number;
	subscriptionCount: number;
	// 지금까지 도착한 청크(=페이지) 수. CollectFoundMiddleware가 'all' 호출마다 1씩
	// 늘린다 — 페이지 하나가 곧 청크 하나이므로 별도 API 콜백 없이 기존 훅만으로 얻는다.
	// "처리 중 (147/320편)"이 실제로는 페이지 단위(PAGE_SIZE=100, 페이지 사이 3초)로
	// 뭉쳐서 올라가 마치 멈췄다 점프하는 것처럼 보이는 문제(7번)를, 지금 몇 번째 묶음을
	// 받고 있는지 같이 보여줘서 설명 가능하게 만든다.
	pageCount: number;
}

// 이 미들웨어들이 실제로 읽고 쓰는 진행 상태만 노출한 좁은 인터페이스. CollectController의
// ProgressFlow(Notice/label 등 UI 전용 필드 포함)를 그대로 넘기지 않고 이 타입으로만 본다.
export interface CollectProgressState {
	collected: number | undefined;
	done: number;
	// 이번 실행에서 시작된 구독들 — 등장 순서대로 쌓인다. index는 currentIndex와 맞춰
	// CollectAndSave.collect()가 넘기는 인덱스와 같다.
	subscriptions: SubscriptionProgressEntry[];
	// 지금 청크/논문이 어느 구독 것인지 — subscriptions의 인덱스. 시작 전(undefined)이면
	// 미들웨어는 아무것도 갱신하지 않는다.
	currentIndex: number | undefined;
}

// 지금 활성 흐름을 읽고, 갱신됐다는 사실을 알리는 창구. CollectController가 구현해서
// 미들웨어에 넘긴다 — 미들웨어는 ProgressFlow/Notice 같은 CollectController 내부 구조를
// 몰라도 된다(OpenNoteOnClickMiddleware가 App만 받고 VisualizationView 내부를 모르는
// 것과 같은 이유).
export interface CollectProgressSink {
	getActiveFlow(): CollectProgressState | undefined;
	notifyUpdated(): void;
}

// 수집 진단 미들웨어: 청크(all) 단위로 수집 건수를 센다. "어느 구독의 청크인가"는
// currentIndex(CollectController가 onApiStart에서 세팅)로 이미 정해져 있으므로, 이
// 미들웨어는 그 구독의 found만 누적한다.
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

		if (flow.currentIndex !== undefined) {
			const entry = flow.subscriptions[flow.currentIndex];
			if (entry) {
				entry.found += papers.length;
				entry.pageCount += 1;
			}
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
		if (flow.currentIndex !== undefined) {
			const entry = flow.subscriptions[flow.currentIndex];
			if (entry) {
				entry.done += 1;
			}
		}
		this.sink.notifyUpdated();
	}
}

// 구독 하나의 진행 상태를 사람이 읽을 한 줄로 요약한다. CollectController의 Notice와
// SettingTab의 대기열 박스가 예전엔 이 로직을 각자 따로 조립했는데(문구가 갈라지기
// 쉬움), 한 곳으로 모아 둘 다 이 함수를 쓴다.
//
// 순번(N/M번째 구독) 접두어는 구독이 둘 이상일 때만 붙인다 — 구독 하나짜리 보통의
// 실행에도 "(1/1번째 구독)"을 붙이면 오히려 문구만 길어져 "너무 길다"는 기존 피드백을
// 반복하게 된다.
export function formatSubscriptionProgress(sub: SubscriptionProgressEntry): string {
	const ordinal = sub.subscriptionCount > 1 ? `(${sub.index + 1}/${sub.subscriptionCount}번째 구독) ` : '';
	const name = `${sub.apiName} ${sub.conditionsText}`;
	if (sub.status === 'done') {
		return `✓ ${ordinal}${name} 논문 수집 완료 (${sub.found}편)`;
	}
	if (sub.total < 0) {
		return `→ ${ordinal}${name} 논문 수집 중... (총 편수 확인 중)`;
	}
	// 페이지(=청크)가 3초 간격으로 도착해 done/total이 100편 단위로 뭉쳐 오르는 것처럼
	// 보일 수 있다 — 지금 몇 번째 묶음을 받고 있는지 같이 보여줘 그 점프를 설명한다.
	return `→ ${ordinal}${name} 논문 처리 중 (${sub.done}/${sub.total}편 · ${sub.pageCount}번째 묶음 확인)`;
}
