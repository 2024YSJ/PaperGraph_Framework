import { App, Menu, Notice } from 'obsidian';
import type PaperGraph3D from '../main';
import type { API } from '../collect/API';
import { Log } from '../common/Log';
import { SubscriptionTargetModal, type SubscriptionTarget } from './SubscriptionTargetModal';
import {
	CollectDoneMiddleware,
	CollectFoundMiddleware,
	formatSubscriptionProgress,
	type CollectProgressSink,
	type CollectProgressState,
	type SubscriptionProgressEntry,
} from './CollectMiddlewares';

// timestamp -> <input type="date">가 받는 "YYYY-MM-DD". Backfill 범위 입력의 기본값 계산용.
function isoDateInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// 사람이 읽을 실행 라벨을 고른 구독으로부터 만든다 — 큐/Notice에 "최근 논문 수집" 같은
// 뭉뚱그린 이름 대신 "arXiv 딥러닝 논문 수집"처럼 무엇을 수집하는지 바로 드러나는 이름을
// 쓰기 위함(5번: 대기열 항목을 자연어로). 구독을 여럿 골랐으면 첫 번째 것 + "외 N건"으로
// 줄인다 — 전부 나열하면 오히려 길어서 읽기 어렵다.
function describeTargets(mode: string, targets: SubscriptionTarget[]): string {
	const first = targets[0];
	if (!first) {
		return mode;
	}
	const describe = (t: SubscriptionTarget): string =>
		`${t.apiName} ${t.querys.map((q) => q.query).join('/')}`;
	const summary =
		targets.length === 1 ? describe(first) : `${describe(first)} 외 ${targets.length - 1}건`;
	return `${summary} ${mode}`;
}

// 수집/보정 버튼 공용 실행기. run()/repair()는 실패 시 사용자가 무엇을 해야 하는지 담아
// throw하므로(모델 미설치, 구독 없음 등) 그 메시지를 그대로 Notice로 보여준다.
// 실행 중 버튼을 잠그는 이유: run()도 repair()도 embed()를 순차 호출한다는 계약 위에
// 서 있는데, 버튼 연타로 두 실행이 겹치면 그 계약이 실행 단위에서 깨진다.
//
// action()이 문자열을 돌려주면 "N편 수집" 같은 요약을 Notice에 덧붙인다. run()은
// void를 반환해 몇 편을 처리했는지 자체적으로 알려주지 않으므로(다이어그램 계약),
// 호출부가 진단용 미들웨어로 건수를 따로 관측해 넘긴다 — 조건에 맞는 논문이 0편이라
// 정상 종료된 것과 실제 오류를 구분하지 못하면 "성공 Notice는 떴는데 파일이 없다"는
// 혼란이 생긴다.
// 수집 계열 실행 하나를 요청한다. 실행 자체는 CollectAndSave의 직렬 큐가 맡으므로
// 여기서는 잠그지 않는다 — 이미 다른 수집이 돌고 있으면 거절하는 대신 줄을 서고, 그
// 사실만 사용자에게 알린다.
async function runCollectFlow(
	label: string,
	busy: boolean,
	action: () => Promise<string | void>,
): Promise<void> {
	if (busy) {
		new Notice(`${label} — 대기열에 넣었습니다. 진행 중인 작업이 끝나면 실행됩니다.`);
	}
	Log.info('ui', `${label} 요청`, { queued: busy });
	try {
		const detail = await action();
		new Notice(`${label} — 완료했습니다.${detail ? ` (${detail})` : ''}`);
		Log.info('ui', `${label} 완료`, { detail });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		new Notice(`${label} — 실패했습니다: ${message}`);
		Log.error('ui', `${label} 실패`, e);
	}
}

// 수집 요청 하나의 진행 상태. 큐 때문에 "요청했지만 아직 시작 안 한" 흐름이 동시에 여러 개
// 있을 수 있어서, 인스턴스 필드가 아니라 요청마다 하나씩 만든다(runWithProgress 주석 참고).
interface ProgressFlow {
	label: string;
	started: boolean; // 큐에서 빠져나와 실제로 실행이 시작됐는가
	// 전체 처리 편수 — CollectDoneMiddleware가 채운다. CollectProgressState 계약상
	// 필요하지만, 화면에는 더 이상 안 쓴다(구독별 독립 표기로 바뀌면서 전체 합계
	// 표시 자체가 필요 없어졌다 — subscriptions[i].done이 그 자리를 대신한다).
	done: number;
	collected: number | undefined; // 'all' 미들웨어가 알려준 수집 편수
	notice: Notice | undefined;
	// 이번 실행에서 시작된 구독들의 진행 상태 — CollectAndSave.run의 onApiStart/onApiDone이
	// 채운다. 구독별 독립 표기(2번)의 핵심: 예전처럼 전체를 하나의 N/M 합계로 뭉뚱그리지
	// 않고, 구독마다 자기 몫만 보여준다.
	subscriptions: SubscriptionProgressEntry[];
	currentIndex: number | undefined;
}

// SettingTab 등 다른 UI가 읽는 읽기 전용 투영 — ProgressFlow의 Notice/started 같은 UI 전용
// 필드는 밖으로 내보내지 않는다.
export type CollectSubscriptionProgress = SubscriptionProgressEntry;

// 수집 실행(최근/Backfill/보정)과 진행률 표시를 한 곳에 모은 컨트롤러.
//
// 이전에는 이 로직이 SettingTab에 묶여 있었는데, 설정 탭을 안 거치고 리본 아이콘에서
// 바로 수집을 실행할 수 있게 하면서 옮겼다 — 진행률 Notice·진단 미들웨어는 "지금 실행
// 중인 흐름 하나"를 공유해야 하므로, 어느 진입점(설정 탭 버튼/리본 아이콘)에서 실행하든
// 같은 컨트롤러를 거쳐야 상태가 어긋나지 않는다. 미들웨어 등록은 플러그인 인스턴스당
// 이 컨트롤러가 하나만 만들어진다는 전제로 생성자에서 한 번만 한다(main.ts.init 참고).
export class CollectController implements CollectProgressSink {
	private activeFlow: ProgressFlow | undefined;
	private progressListeners: (() => void)[] = [];

	constructor(private readonly plugin: PaperGraph3D) {
		this.registerDiagnostics();
	}

	// CollectProgressSink 구현 — CollectFoundMiddleware/CollectDoneMiddleware가 ProgressFlow/
	// Notice 등 이 클래스 내부 구조를 몰라도 진행 상태를 읽고 갱신을 알릴 수 있게 한다.
	getActiveFlow(): CollectProgressState | undefined {
		return this.activeFlow;
	}

	notifyUpdated(): void {
		if (this.activeFlow) {
			this.updateProgress(this.activeFlow);
		}
		this.notifyProgress();
	}

	// 이번 실행에서 지금까지 시작된 구독들의 진행 상태. 대기열 표시(SettingTab)가 이 값을
	// 읽는다 — 없으면(유휴 상태, 보정 실행 중, 또는 아직 첫 구독도 시작 안 한 시점) 빈 배열.
	get activeSubscriptions(): CollectSubscriptionProgress[] {
		return this.activeFlow?.subscriptions ?? [];
	}

	// queueState의 onQueueChange와 같은 패턴 — 대기열 박스가 여기 구독해서 API별 진행이
	// 바뀔 때마다 다시 그린다(onQueueChange는 큐 멤버십 변화만 알리므로 이 신호가 따로
	// 필요하다).
	onProgressChange(listener: () => void): void {
		this.progressListeners.push(listener);
	}

	private notifyProgress(): void {
		for (const listener of this.progressListeners) {
			try {
				listener();
			} catch (error) {
				Log.error('ui', '진행률 리스너 실패', error);
			}
		}
	}

	// 클릭 위치에 "최근 논문 수집"/"Backfill" 선택 메뉴를 띄운다. 설정 탭의 「수집」
	// 버튼과 리본 아이콘이 이 메서드 하나를 공유한다.
	openCollectMenu(evt: MouseEvent, app: App): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('최근 논문 수집')
				.setIcon('download')
				.onClick(() => this.runRecent(app)),
		);
		menu.addItem((item) =>
			item
				.setTitle('Backfill — 과거 구간 수집')
				.setIcon('calendar-range')
				.onClick(() => this.openBackfillModal(app)),
		);
		menu.showAtMouseEvent(evt);
	}

	// 실행 전 SubscriptionTargetModal로 "이번엔 어느 구독만 돌릴지" 먼저 고른다(4번
	// 타겟팅) — 기본은 전체 선택이라 아무것도 안 바꾸면 예전과 동일하게 전체를 돈다.
	// isBusy 체크는 모달을 여는 시점이 아니라 사용자가 실제로 「실행」을 누른 시점에
	// 해야 한다 — 그 사이 다른 수집이 시작/종료될 수 있다.
	runRecent(app: App): void {
		new SubscriptionTargetModal(app, '최근 논문 수집 — 구독 선택', false, (targets) => {
			const label = describeTargets('최근 논문 수집', targets);
			void runCollectFlow(label, this.plugin.collectflow.isBusy, () =>
				this.runWithProgress(label, (onStart, onTotal, onApiStart, onApiDone) =>
					this.plugin.collectflow.run(
						'recent',
						{ targetSubscriptions: targets },
						onStart,
						onTotal,
						onApiStart,
						onApiDone,
					),
				),
			);
		}).open();
	}

	openBackfillModal(app: App): void {
		new SubscriptionTargetModal(
			app,
			'Backfill — 과거 구간 수집 · 구독 선택',
			true,
			(targets, range) => {
				// needsDateRange=true일 때만 열리는 창이라 range는 항상 온다 — 타입 좁히기용 가드.
				if (!range) {
					return;
				}
				const label = describeTargets('Backfill', targets);
				void runCollectFlow(label, this.plugin.collectflow.isBusy, () =>
					this.runWithProgress(label, (onStart, onTotal, onApiStart, onApiDone) =>
						this.plugin.collectflow.run(
							'backfill',
							{ from: range.from, to: range.to, targetSubscriptions: targets },
							onStart,
							onTotal,
							onApiStart,
							onApiDone,
						),
					),
				);
			},
			// 기본 2주 — 좁은 구간을 고르면 100건 미만이라 페이지네이션이 한 번도 안 돌아
			// 검증이 안 된다.
			isoDateInput(Date.now() - 14 * 24 * 60 * 60 * 1000),
			isoDateInput(Date.now()),
		).open();
	}

	// 스케줄러(자동 수집)·명령어 팔레트("최근 논문 수집 실행")가 쓰는 경로 — 백그라운드
	// 실행이라 SubscriptionTargetModal로 구독을 고르게 할 수 없으니 항상 등록된 구독
	// 전체를 대상으로 한다. runWithProgress(silent=true)를 그대로 써서 activeFlow가
	// 수동 실행과 같은 자리(단일 진실 공급원)에 쌓이게 한다 — Notice만 안 만든다.
	// runCollectFlow는 쓰지 않는다 — 그건 실패를 삼키고 Notice로만 알리는데, 이 경로는
	// 원래 실패를 그대로 던져 호출자가 처리하는 계약이었다(main.ts의 두 호출부가 각자
	// 다르게 반응한다 — Scheduler는 로그만 남기고, 명령어 팔레트는 자기 Notice를 띄운다).
	// 대안(CollectController를 거치지 않고 별도 sink를 하나 더 등록하는 방식)도 검토했으나
	// activeFlow가 두 곳으로 갈라져 "활성 흐름은 항상 하나"라는 이 클래스의 전제가 깨지고
	// (runWithProgress의 onStart 주석 참고), 대기열 표시 로직이 두 곳에 중복되는 문제가
	// 있어 기각했다 — devLog(010) 참고.
	runRecentAuto(): Promise<string | void> {
		const label = '최근 논문 수집';
		return this.runWithProgress(
			label,
			(onStart, onTotal, onApiStart, onApiDone) =>
				this.plugin.collectflow.run('recent', undefined, onStart, onTotal, onApiStart, onApiDone),
			true,
		);
	}

	// 수집 요청 하나를 진행률과 함께 실행한다. silent=true면 Notice를 만들지 않는다
	// (스케줄러/명령어 팔레트처럼 원래 조용히 도는 게 설계 의도인 실행용 — runRecentAuto
	// 참고) — activeFlow/구독별 진행(SettingTab이 읽는 단일 진실 공급원)은 silent 여부와
	// 무관하게 항상 채워진다.
	//
	// 큐 때문에 "요청했지만 아직 시작 안 한" 상태가 생기므로, 진행 상태는 인스턴스 필드가
	// 아니라 요청마다 만드는 ProgressFlow에 담는다. 필드 하나를 공유하면 두 번째 요청이
	// 첫 번째의 진행 상태를 서로 덮어쓴다.
	//
	// CollectAndSave에는 이 존재가 전달되지 않는다 — 도메인은 Obsidian을 몰라야 한다
	// (001 합의). 작업이 실제로 시작됐다는 사실만 onStart 콜백으로, 구독 시작/종료는
	// onApiStart/onApiDone 콜백으로 되돌려받는다.
	private async runWithProgress(
		label: string,
		action: (
			onStart: () => void,
			onTotal: (subtotal: number) => void,
			onApiStart: (api: API, index: number, total: number) => void,
			onApiDone: (api: API, index: number, total: number) => void,
		) => Promise<void>,
		silent = false,
	): Promise<string | void> {
		const flow: ProgressFlow = {
			label,
			started: false,
			done: 0,
			collected: undefined,
			notice: undefined,
			subscriptions: [],
			currentIndex: undefined,
		};
		if (!silent) {
			flow.notice = new Notice(this.renderProgress(flow), 0);
		}
		try {
			await action(
				() => {
					flow.started = true;
					// 지금 실행되는 큐 작업이 항상 하나이므로, 시작한 흐름이 곧 미들웨어가
					// 갱신할 대상이다.
					this.activeFlow = flow;
					this.updateProgress(flow);
					this.notifyProgress();
				},
				// API.CollectOptions.onTotal — "지금 활성 구독이 이번 구간에 실제로 몇 편을
				// 갖고 있는지"를 구독마다 최대 한 번씩 알려준다(CollectAndSave.run 주석
				// 참고). found를 분모로 쓰면 페이지(청크)가 도착할 때마다 분모 자체가 같이
				// 늘어나 "0/100 -> 101/200"처럼 실제 진행률처럼 안 보였다 — 진짜 총량인
				// 이 값을 받아 그 구독의 total에 채운다.
				(subtotal) => {
					if (flow.currentIndex !== undefined) {
						const entry = flow.subscriptions[flow.currentIndex];
						if (entry) {
							entry.total = subtotal;
						}
					}
					this.updateProgress(flow);
					this.notifyProgress();
				},
				(api, index, total) => {
					flow.subscriptions[index] = {
						apiName: api.apiName,
						conditionsText: api.querys.map((q) => q.query).join('·'),
						status: 'running',
						found: 0,
						done: 0,
						total: -1,
						index,
						subscriptionCount: total,
						pageCount: 0,
					};
					flow.currentIndex = index;
					this.updateProgress(flow);
					this.notifyProgress();
				},
				(_api, index) => {
					const entry = flow.subscriptions[index];
					if (entry) {
						entry.status = 'done';
					}
					this.updateProgress(flow);
					this.notifyProgress();
				},
			);
		} finally {
			flow.notice?.hide();
			flow.notice = undefined;
			if (this.activeFlow === flow) {
				this.activeFlow = undefined;
				// 대기열 보조 줄(activeSubscriptions)이 남아있지 않도록 실행이 끝났다는
				// 사실도 알린다.
				this.notifyProgress();
			}
		}
		if (flow.collected === undefined) {
			return undefined;
		}
		// 임베딩 실패는 수집을 멈추지 않으므로, 알리지 않으면 사용자는 벡터가 빈 논문이
		// 쌓인 걸 모른다. 3번(보정 자동화) 이후로는 수동 버튼이 없고, 임베딩 재시도는 이번
		// 실행 안에서 하지 않는다 — 서킷브레이커를 막 리셋하고 바로 다시 두드리는 헛수고를
		// 피하려고 다음 플러그인 로드 때의 전수 보정으로 미뤘다(CollectAndSave.runNow 끝
		// 주석 참고). 그러니 여기서는 "지금 몇 편 실패했다"만 사실대로 알리고, 언제
		// 복구되는지도 같이 말한다.
		const failed = this.plugin.collectflow.lastStats?.embedFailed ?? 0;
		return failed > 0
			? `${flow.collected}편 수집, 그중 ${failed}편 임베딩 실패 — 다음 플러그인 로드 때 자동으로 재시도됩니다`
			: `${flow.collected}편 수집`;
	}

	// run()의 'all'/'forEach' 미들웨어로 수집 건수와 진행률을 관측한다. run() 자체는
	// 다이어그램 계약상 void만 반환하고 Notice/DOM을 전혀 모르므로(CollectAndSave는
	// Obsidian을 몰라야 한다 — 001 합의), 관측은 항상 미들웨어를 경유한다. UI(Notice
	// 생성·표시 문자열)는 이 안이 아니라 renderProgress()에만 있다. 미들웨어 구현 자체는
	// CollectMiddlewares.ts(src/visualize/VisualMiddlewares.ts와 같은 자리)에 있고, 여기서는
	// 이 컨트롤러를 CollectProgressSink로 넘겨 등록만 한다.
	//
	// 이 컨트롤러가 플러그인 인스턴스당 하나만 생성된다는 전제로 생성자에서 한 번만
	// 등록한다 — 여러 번 만들면 'all' 미들웨어가 쌓여 같은 run() 호출에 대해
	// lastCollectedCount가 여러 번(마지막 값은 같아도) 덮어써진다.
	private registerDiagnostics(): void {
		this.plugin.collectflow.setMiddleware(new CollectFoundMiddleware(this));
		this.plugin.collectflow.setMiddleware(new CollectDoneMiddleware(this));
	}

	private updateProgress(flow: ProgressFlow): void {
		flow.notice?.setMessage(this.renderProgress(flow));
	}

	// 구독별 독립 표기(2번) — 예전처럼 전체를 하나의 N/M 합계로 뭉뚱그리지 않고, 시작된
	// 구독마다 한 줄씩 자기 몫만 보여준다. 결과가 0편인 구독도 onApiStart 시점에 이미
	// 줄이 하나 생기므로(collect() 참고) 화면에서 사라지지 않는다.
	private renderProgress(flow: ProgressFlow): DocumentFragment {
		return createFragment((el) => {
			if (!flow.started) {
				el.createDiv({ text: `${flow.label} — 대기 중... (진행 중인 작업이 끝나면 시작합니다)` });
				return;
			}
			if (flow.subscriptions.length === 0) {
				el.createDiv({ text: `${flow.label} — 준비 중...` });
				return;
			}
			for (const sub of flow.subscriptions) {
				el.createDiv({ text: formatSubscriptionProgress(sub) });
			}
		});
	}
}
