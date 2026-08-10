import { App, Menu, Notice } from 'obsidian';
import type PaperGraph3D from '../main';
import { Log } from '../common/Log';
import { PipelineTestModal } from './PipelineTestModal';
import {
	CollectDoneMiddleware,
	CollectFoundMiddleware,
	type CollectProgressSink,
	type CollectProgressState,
} from './CollectMiddlewares';

// 날짜 입력(YYYY-MM-DD)을 timestamp(ms)로 변환. 비어있거나 잘못된 값이면 undefined.
function parseDateInput(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

// timestamp -> <input type="date">가 받는 "YYYY-MM-DD". Backfill 범위 입력의 기본값 계산용.
function isoDateInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
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
		new Notice(`${label}을(를) 대기열에 넣었습니다. 진행 중인 작업이 끝나면 실행됩니다.`);
	}
	Log.info('ui', `${label} 요청`, { queued: busy });
	try {
		const detail = await action();
		new Notice(`${label}을(를) 마쳤습니다.${detail ? ` (${detail})` : ''}`);
		Log.info('ui', `${label} 완료`, { detail });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		new Notice(`${label} 실패: ${message}`);
		Log.error('ui', `${label} 실패`, e);
	}
}

// 수집 요청 하나의 진행 상태. 큐 때문에 "요청했지만 아직 시작 안 한" 흐름이 동시에 여러 개
// 있을 수 있어서, 인스턴스 필드가 아니라 요청마다 하나씩 만든다(runWithProgress 주석 참고).
interface ProgressFlow {
	label: string;
	total: number; // -1이면 아직 모름
	done: number;
	started: boolean; // 큐에서 빠져나와 실제로 실행이 시작됐는가
	collected: number | undefined; // 'all' 미들웨어가 알려준 수집 편수
	notice: Notice | undefined;
	// 지금 청크를 보내고 있는 API(구독)의 정보. CollectAndSave.ts는 건드리지 않고, 'all'
	// 미들웨어가 받는 Paper.collectedApis/collectedQueries에서 읽어낸다 — API들이 항상
	// 순차 처리되므로(collect() 참고) 한 청크는 늘 같은 API·조건에서 나온다는 전제 위에
	// 있다. apiName만으로는 "같은 API, 다른 조건의 구독 두 개가 연달아 돈다"를 구분 못
	// 하므로, apiName+조건 문자열을 합친 키가 바뀔 때만 리셋한다(renderQueueStatus에서
	// SettingTab이 이 값을 그대로 보여준다).
	apiName: string | undefined;
	apiConditionsText: string | undefined;
	apiFound: number; // 이 API(조건)에서 지금까지 추려진(도착한) 논문 수
	apiDone: number; // 이 API(조건)에서 지금까지 처리(임베딩+저장 직전)한 논문 수
}

// SettingTab 등 다른 UI가 읽는 읽기 전용 투영 — ProgressFlow의 Notice/started 같은 UI 전용
// 필드는 밖으로 내보내지 않는다.
export interface CollectApiProgress {
	apiName: string;
	conditionsText: string;
	found: number;
	done: number;
}

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

	// 지금 도는 API(구독)의 진행 상태. 대기열 표시(SettingTab)가 이 값을 읽는다 — 없으면
	// (유휴 상태, 보정 실행 중, 또는 첫 청크가 아직 안 온 시점) undefined.
	get currentApiProgress(): CollectApiProgress | undefined {
		const flow = this.activeFlow;
		if (!flow || flow.apiName === undefined || flow.apiConditionsText === undefined) {
			return undefined;
		}
		return {
			apiName: flow.apiName,
			conditionsText: flow.apiConditionsText,
			found: flow.apiFound,
			done: flow.apiDone,
		};
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
				.onClick(() => this.runRecent()),
		);
		menu.addItem((item) =>
			item
				.setTitle('Backfill — 과거 구간 수집')
				.setIcon('calendar-range')
				.onClick(() => this.openBackfillModal(app)),
		);
		menu.showAtMouseEvent(evt);
	}

	runRecent(): void {
		void runCollectFlow('최근 논문 수집', this.plugin.collectflow.isBusy, () =>
			this.runWithProgress('최근 논문 수집', (onStart, onTotal) =>
				this.plugin.collectflow.run('recent', undefined, onStart, onTotal),
			),
		);
	}

	openBackfillModal(app: App): void {
		new PipelineTestModal(
			app,
			'Backfill — 과거 구간 수집',
			[
				{
					key: 'from',
					label: '시작일',
					type: 'date',
					// 기본 2주 — 좁은 구간을 고르면 100건 미만이라 페이지네이션이
					// 한 번도 안 돌아 검증이 안 된다.
					defaultValue: isoDateInput(Date.now() - 14 * 24 * 60 * 60 * 1000),
				},
				{
					key: 'to',
					label: '종료일 (당일 포함)',
					type: 'date',
					defaultValue: isoDateInput(Date.now()),
				},
			],
			async (values) => {
				const from = parseDateInput(values.from ?? '');
				const toMidnight = parseDateInput(values.to ?? '');
				if (from === undefined || toMidnight === undefined) {
					new Notice('시작일/종료일을 올바르게 입력하세요');
					return;
				}
				// 날짜 입력은 자정(00:00)으로 파싱되므로 그대로 넘기면 종료일 당일이
				// 통째로 빠지고, 시작일=종료일이면 빈 구간이 된다. 하루를 더해
				// "종료일 당일 포함"으로 맞춘다.
				const to = toMidnight + 24 * 60 * 60 * 1000;
				await runCollectFlow('Backfill', this.plugin.collectflow.isBusy, () =>
					this.runWithProgress('Backfill', (onStart, onTotal) =>
						this.plugin.collectflow.run('backfill', { from, to }, onStart, onTotal),
					),
				);
			},
		).open();
	}

	runRepair(): void {
		void runCollectFlow('보정', this.plugin.collectflow.isBusy, async () => {
			await this.plugin.collectflow.repair();
			return this.formatRepairDetail();
		});
	}

	// 수집 요청 하나를 진행률 Notice와 함께 실행한다.
	//
	// 큐 때문에 "요청했지만 아직 시작 안 한" 상태가 생기므로, 진행 상태는 인스턴스 필드가
	// 아니라 요청마다 만드는 ProgressFlow에 담는다. 필드 하나를 공유하면 두 번째 요청이
	// 첫 번째의 총계를 0으로 리셋해 "29/0편" 같은 표시가 나온다.
	//
	// CollectAndSave에는 이 존재가 전달되지 않는다 — 도메인은 Obsidian을 몰라야 한다
	// (001 합의). 작업이 실제로 시작됐다는 사실만 onStart 콜백으로, 총계는 onTotal
	// 콜백으로 되돌려받는다.
	private async runWithProgress(
		label: string,
		action: (onStart: () => void, onTotal: (subtotal: number) => void) => Promise<void>,
	): Promise<string | void> {
		const flow: ProgressFlow = {
			label,
			// -1 = "총계 미정". run()이 onTotal로 알려주기 전까지는 분모를 아는 척하지
			// 않는다 — 0으로 두면 아직 안 온 총계를 실제 값처럼 "N/0편"으로 찍게 된다.
			total: -1,
			done: 0,
			started: false,
			collected: undefined,
			notice: undefined,
			apiName: undefined,
			apiConditionsText: undefined,
			apiFound: 0,
			apiDone: 0,
		};
		flow.notice = new Notice(this.renderProgress(flow), 0);
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
				(subtotal) => {
					// 구독마다 최대 한 번씩 불린다 — 값을 더해야 여러 구독을 합친 전체
					// 총계가 된다(청크 도착 순서에 상관없이 각자 자기 몫만 보고한다).
					flow.total = (flow.total < 0 ? 0 : flow.total) + subtotal;
					this.updateProgress(flow);
					this.notifyProgress();
				},
			);
		} finally {
			flow.notice?.hide();
			flow.notice = undefined;
			if (this.activeFlow === flow) {
				this.activeFlow = undefined;
				// 대기열 보조 줄(currentApiProgress)이 남아있지 않도록 실행이 끝났다는
				// 사실도 알린다.
				this.notifyProgress();
			}
		}
		if (flow.collected === undefined) {
			return undefined;
		}
		// 임베딩 실패는 수집을 멈추지 않으므로, 알리지 않으면 사용자는 벡터가 빈 논문이
		// 쌓인 걸 모른다. 복구 방법(보정)까지 같이 말한다.
		const failed = this.plugin.collectflow.lastStats?.embedFailed ?? 0;
		return failed > 0
			? `${flow.collected}편 수집, 그중 ${failed}편 임베딩 실패 — 「보정」으로 재시도하세요`
			: `${flow.collected}편 수집`;
	}

	// 보정은 진행률 Notice가 없어 runWithProgress를 안 거치므로, 완료 문구는 여기서 따로
	// 만든다. lastRepairStats는 repair()가 void를 반환하는 대신 인스턴스에 남겨두는 값이다
	// (run()의 lastStats와 같은 이유).
	private formatRepairDetail(): string | undefined {
		const stats = this.plugin.collectflow.lastRepairStats;
		if (!stats) {
			return undefined;
		}
		const parts: string[] = [];
		if (stats.reembedded > 0) {
			parts.push(`재임베딩 ${stats.reembedded}편`);
		}
		if (stats.citationsFixed > 0) {
			parts.push(`인용수 보강 ${stats.citationsFixed}편`);
		}
		if (parts.length === 0) {
			return '고칠 것 없음';
		}
		if (stats.reembedFailed > 0) {
			parts.push(`${stats.reembedFailed}편은 여전히 실패`);
		}
		return parts.join(', ');
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

	// 세 단계로 다르게 말한다: 큐에서 대기 중 / 받아오는 중(총계 미정) / 처리 중(N/M).
	// 총계를 모르는 동안 분모를 아는 척하지 않는 게 핵심이다.
	private renderProgress(flow: ProgressFlow): DocumentFragment {
		const known = flow.total >= 0;
		return createFragment((el) => {
			let text: string;
			if (!flow.started) {
				text = `${flow.label} — 대기 중... (진행 중인 작업이 끝나면 시작합니다)`;
			} else if (!known) {
				// API 이름을 하드코딩하지 않는다 — arXiv 외 다른 API가 추가돼도 그대로 맞다.
				text = `${flow.label} — 수집 중... (총 편수는 아직 알 수 없습니다)`;
			} else {
				text = `${flow.label} — 수집한 논문 처리 중... (${flow.done}/${flow.total}편)`;
			}
			el.createDiv({ text });
			// max가 0/음수면 <progress>는 부정형(indeterminate)이 된다 — 총계를 모르는
			// 동안 정확히 그 표시를 원한다.
			el.createEl('progress', {
				attr: known ? { value: flow.done, max: Math.max(flow.total, 1) } : {},
			});
		});
	}
}
