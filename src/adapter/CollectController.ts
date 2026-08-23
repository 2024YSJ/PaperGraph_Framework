import { App, Menu, Notice } from 'obsidian';
import type PaperGraph3D from '../main';
import type { API } from '../collect/API';
import type { SearchQuery } from '../collect/SearchQuery';
import { Log } from '../common/Log';
import { FailureNotifier } from '../common/Notify';
import { SubscriptionTargetModal, type SubscriptionTarget } from './SubscriptionTargetModal';
import {
	CollectDoneMiddleware,
	CollectFoundMiddleware,
	formatSubscriptionProgress,
	type CollectProgressSink,
	type CollectProgressState,
	type SubscriptionProgressEntry,
} from './CollectMiddlewares';

// timestamp -> <input type="date">가 받는 "YYYY-MM-DD". 과거 논문 수집 범위 입력의 기본값 계산용.
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
	// busy일 때 여기서 Notice를 따로 띄우지 않는다 — action()이 부르는 runWithProgress가
	// 곧바로 "○○ — 대기 중..." 상태 Notice를 띄우는데(renderProgress), 둘이 똑같은
	// 내용을 거의 동시에 두 번 보여줘서 정신없었다(실제 재현됨). 그쪽 Notice는 실행이
	// 시작되면 진행률로 계속 바뀌는 살아있는 표시라 이 일회성 토스트보다 정보량이 많다.
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

// 수집 실행(최근/과거 논문 수집/보정)과 진행률 표시를 한 곳에 모은 컨트롤러.
//
// 이전에는 이 로직이 SettingTab에 묶여 있었는데, 설정 탭을 안 거치고 리본 아이콘에서
// 바로 수집을 실행할 수 있게 하면서 옮겼다 — 진행률 Notice·진단 미들웨어는 "지금 실행
// 중인 흐름 하나"를 공유해야 하므로, 어느 진입점(설정 탭 버튼/리본 아이콘)에서 실행하든
// 같은 컨트롤러를 거쳐야 상태가 어긋나지 않는다. 미들웨어 등록은 플러그인 인스턴스당
// 이 컨트롤러가 하나만 만들어진다는 전제로 생성자에서 한 번만 한다(main.ts.init 참고).
export class CollectController implements CollectProgressSink {
	private activeFlow: ProgressFlow | undefined;
	private progressListeners: (() => void)[] = [];

	// silent 실행(스케줄러/명령어 팔레트)은 완료 Notice가 없어서, buildPartialFailureSuffix가
	// 만드는 문구가 아무한테도 안 보인다 — 그런데 그 문구가 다루는 신호 중 "구조적 실패"
	// (우연이 아니라 계속 반복될 성격의 실패)는 silent 여부와 무관하게 알려야 한다.
	// FailureNotifier로 이유가 바뀔 때만 알려 스팸 없이 이 공백을 메운다(checkStructuralFailures
	// 참고).
	//
	// 스킵 비율 이상치는 여기 없다(2026-08-13 검토 후 제외) — 원인(arXiv 응답 자체가
	// 이상했다)에 대해 사용자가 할 수 있는 조치가 없고, recent 수집의 작은 표본에서는
	// 비율이 우연히도 쉽게 튀어 노이즈가 크다는 판단.
	private readonly citationRepairFailureNotifier = new FailureNotifier();

	// citationRetryOverflow(500편 상한 초과)도 같은 이유로 별도 알림이 필요하다 —
	// 2000~3000편 규모 backfill에서는 예외가 아니라 일상적으로 발생 가능한데(청크 6개만
	// 실패해도 상한을 넘김), buildPartialFailureSuffix에만 있으면 silent 실행(자동 backfill
	// 등)에서는 아무도 못 본다.
	private readonly citationOverflowNotifier = new FailureNotifier();

	// categoryMismatches(8번: 요청-응답 category 불일치, 프록시 변조 재현 사례)도 같은
	// 이유로 silent 실행에서 새는 신호다 — 자동 스케줄러가 도는 동안 요청이 변조돼도
	// buildPartialFailureSuffix만으로는 아무도 못 본다. 보안과 관련된 신호라 매 실행마다
	// 뜨는 스팸을 감수하기보다는(반복되는 동안은 조용히) 최초 발생/재발생 시점만 확실히
	// 알리는 이 코드베이스의 기존 절충을 그대로 따른다.
	private readonly categoryMismatchNotifier = new FailureNotifier();

	// 인용수 보정이 "시도는 했는데 하나도 못 고쳤다"고 판단할 최소 시도 편수. 1~2편은
	// 그 논문들이 우연히 S2에 없었을 뿐일 수 있어 노이즈가 크다 — 몇 편 이상 전부
	// 실패해야 "키/네트워크 문제"라는 구조적 신호로 본다.
	private static readonly CITATION_REPAIR_MIN_ATTEMPTED = 3;

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

	// 클릭 위치에 "최근 논문 수집"/"과거 논문 수집" 선택 메뉴를 띄운다. 설정 탭의 「수집」
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
				.setTitle('과거 논문 수집')
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
		new SubscriptionTargetModal(app, '최근 논문 수집 — 구독 선택', false, (targets, _range, allSelected) => {
			const label = describeTargets('최근 논문 수집', targets);
			// 「전체 선택」 상태로 실행하면 targetSubscriptions를 아예 넘기지 않는다 —
			// 스케줄러/명령어 팔레트(runRecentAuto)가 "대상 없음(undefined)"으로 같은
			// 요청을 표현하는 것과 동일한 키가 되게 맞춘다. 그렇지 않으면 리본 메뉴로 고른
			// "명시적 전체 목록"과 자동 실행의 "undefined"가 의미는 같아도 키가 달라 서로
			// 합쳐지지 않고 대기열에 각자 쌓인다(실제 재현된 문제).
			const testOptions = allSelected ? undefined : { targetSubscriptions: targets };
			// run()은 내부적으로 동일 요청을 합쳐주지만(pendingRuns), 그걸 모르고 여기서
			// 매번 새 runWithProgress를 부르면 클릭마다 새 진행률 Notice가 또 생겨 실제로는
			// 하나로 합쳐진 실행인데도 화면에는 여러 개가 쌓인 것처럼 보인다(57번과 같은
			// 근본 원인 — UI는 항상 도메인의 합침 여부를 먼저 확인해야 한다). 이미 같은
			// 요청이 대기 중이면 새 진행률 UI를 만들지 않는다. Notice는 따로 안 띄운다 —
			// 이미 첫 요청이 띄운 상태 Notice("대기 중...")가 화면에 떠 있는 상태라, 여기서
			// 또 띄우면 같은 내용이 2번 보인다(실제 재현됨).
			if (this.plugin.collectflow.hasPendingRun('recent', testOptions)) {
				Log.info('ui', `${label} — 이미 대기 중`);
				return;
			}
			void runCollectFlow(label, this.plugin.collectflow.isBusy, () =>
				this.runWithProgress(label, (onStart, onTotal, onApiStart, onApiDone) =>
					this.plugin.collectflow.run(
						'recent',
						testOptions,
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
			'과거 논문 수집 · 구독 선택',
			true,
			(targets, range) => {
				// needsDateRange=true일 때만 열리는 창이라 range는 항상 온다 — 타입 좁히기용 가드.
				if (!range) {
					return;
				}
				const label = describeTargets('과거 논문 수집', targets);
				const testOptions = { from: range.from, to: range.to, targetSubscriptions: targets };
				// runRecent와 같은 이유 — Notice는 안 띄운다(이미 뜬 상태 Notice와 중복).
				if (this.plugin.collectflow.hasPendingRun('backfill', testOptions)) {
					Log.info('ui', `${label} — 이미 대기 중`);
					return;
				}
				void runCollectFlow(label, this.plugin.collectflow.isBusy, () =>
					this.runWithProgress(label, (onStart, onTotal, onApiStart, onApiDone) =>
						this.plugin.collectflow.run(
							'backfill',
							testOptions,
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

	// 신규 구독 등록 직후, 방금 등록한 구독 하나만 대상으로 자동 수집한다. runRecentAuto와
	// 마찬가지로 silent(Notice 없음) — 등록 성공 Notice가 이미 떴으므로 별도 안내가
	// 필요 없고, activeFlow/대기열 표시는 그대로 채워진다.
	runRecentOneAuto(target: { apiName: string; querys: SearchQuery[] }): Promise<string | void> {
		const label = describeTargets('최근 논문 수집', [target]);
		return this.runWithProgress(
			label,
			(onStart, onTotal, onApiStart, onApiDone) =>
				this.plugin.collectflow.run(
					'recent',
					{ targetSubscriptions: [target] },
					onStart,
					onTotal,
					onApiStart,
					onApiDone,
				),
			true,
		);
	}

	// 전체 코퍼스 강제 새로고침(인용수 재조회 + 콘텐츠 동기화 + 조건부 재임베딩) — 설정 탭
	// 「새로고침」 버튼과 리본 아이콘이 부른다. runWithProgress(구독별 ProgressFlow.subscriptions
	// 배열 전제)를 재사용하지 않는다 — refreshAll의 진행은 API/구독 단위가 아니라 코퍼스
	// 전체 논문 수 기준 flat done/total이라 그 배열 구조와 안 맞는다. 대신 Notice 하나를
	// 직접 갱신하는 가벼운 전용 처리를 쓴다 — Backfill/최근수집이 쓰는 "N/총M편" 어휘를
	// 그대로 맞춘다.
	async refreshAllAuto(): Promise<string | void> {
		const label = '새로고침';
		// refreshAll()은 이미 대기 중인 요청과 내부적으로 합쳐지지만(57번), 그걸 모르고
		// 여기서 매번 새 "준비 중..." Notice를 띄우면 실제로는 하나로 합쳐진 실행인데도
		// 화면에는 여러 개가 쌓인 것처럼 보인다 — runRecent/openBackfillModal과 같은 이유로
		// 여기서도 먼저 확인한다. Notice는 안 띄운다 — 먼저 큐에 들어간 요청의 "준비
		// 중.../처리 중" Notice가 이미 떠 있어서, 여기서 또 띄우면 중복이다.
		if (this.plugin.collectflow.hasPendingRefresh) {
			Log.info('ui', `${label} — 이미 대기 중`);
			return undefined;
		}
		// "준비 중" 단계는 File.readAllPapers()로 볼트 전체를 스캔하는 구간이라 총량을 미리
		// 몰라 진행률(%)을 못 낸다 — 그래서 오래 걸려도 멈춘 것처럼 보이지 않도록, 최소한
		// 왜 오래 걸릴 수 있는지는 문구로 설명한다(정확한 진행률은 readAllPapers에 콜백을
		// 추가하는 더 큰 작업이 필요해 이번엔 범위 밖으로 둔다).
		const notice = new Notice(
			`${label} — 준비 중... (파일을 읽는 중이라 코퍼스가 클수록 오래 걸릴 수 있습니다)`,
			0,
		);
		try {
			await this.plugin.collectflow.refreshAll(undefined, (done, total) => {
				notice.setMessage(`${label} — 처리 중 (${done}/${total}편)`);
			});
			const stats = this.plugin.collectflow.lastRefreshStats;
			// 출처 하나가 실패해도 나머지는 계속 새로고침되므로(CollectAndSave.refreshAllBody의
			// 출처 격리), 그 사실을 완료 문구에서 조용히 감추지 않는다 — collect()의
			// failedSubscriptions를 buildPartialFailureSuffix가 알리는 것과 같은 이유.
			// 논문 저장 실패(failedPapers)도 이제 전체를 죽이지 않고 목록으로만 남으므로
			// (refreshAllBody의 논문 단위 격리), 같은 이유로 조용히 감추지 않는다.
			const failedApisText =
				stats && stats.failedApis.length > 0
					? ` — ${stats.failedApis.map((f) => f.apiName).join(', ')} 실패`
					: '';
			const failedPapersText =
				stats && stats.failedPapers.length > 0 ? ` — ${stats.failedPapers.length}편 저장 실패` : '';
			const detail = stats
				? `${stats.citationsRefreshed}편 확인, ${stats.reembedded}편 재임베딩${failedApisText}${failedPapersText}`
				: undefined;
			new Notice(`${label} — 완료했습니다.${detail ? ` (${detail})` : ''}`);
			Log.info('ui', `${label} 완료`, { detail });
			return detail;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			new Notice(`${label} — 실패했습니다: ${message}`);
			Log.error('ui', `${label} 실패`, e);
		} finally {
			notice.hide();
		}
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
		// silent 여부·수집 편수와 무관하게 항상 확인한다 — 구조적 실패는 "0편 수집"으로
		// 끝난 실행에서도 일어날 수 있다.
		this.checkStructuralFailures();
		if (flow.collected === undefined) {
			return undefined;
		}
		// 임베딩 실패는 수집을 멈추지 않으므로, 알리지 않으면 사용자는 벡터가 빈 논문이
		// 쌓인 걸 모른다. 3번(보정 자동화) 이후로는 수동 버튼이 없고, 임베딩 재시도는 이번
		// 실행 안에서 하지 않는다 — 서킷브레이커를 막 리셋하고 바로 다시 두드리는 헛수고를
		// 피하려고 다음 플러그인 로드 때의 전수 보정으로 미뤘다(CollectAndSave.runNow 끝
		// 주석 참고). 그러니 여기서는 "지금 몇 편 실패했다"만 사실대로 알리고, 언제
		// 복구되는지도 같이 말한다.
		//
		// embedFailed 외에도 "부분 성공"을 나타내는 신호가 더 있다(CollectAndSave.CollectStats
		// 참고) — 조용히 넘어가면 사용자는 완료 Notice만 보고 전부 다 됐다고 오해한다.
		// 전부 정상이면(추가 신호가 하나도 없으면) 예전처럼 편수만 보여준다 — 매번 문구가
		// 늘어나면 정작 이상이 있을 때 눈에 덜 띈다.
		return `${flow.collected}편 수집${this.buildPartialFailureSuffix()}`;
	}

	// CollectStats의 부분 실패 신호들을 사람이 읽을 문구로 이어붙인다. 신호가 하나도
	// 없으면 빈 문자열 — 정상 실행에서는 완료 Notice가 예전 그대로("N편 수집")로 보이게
	// 한다.
	private buildPartialFailureSuffix(): string {
		const stats = this.plugin.collectflow.lastStats;
		if (!stats) {
			return '';
		}
		const parts: string[] = [];
		if (stats.embedFailed > 0) {
			parts.push(`${stats.embedFailed}편 임베딩 실패 — 다음 플러그인 로드 때 자동으로 재시도됩니다`);
		}
		if (stats.citationRetryOverflow > 0) {
			// 이번 실행의 자동 재시도(500편 상한)에서 빠진 것뿐, 유실은 아니다 — 다음
			// 플러그인 로드 때의 전수 보정이 결국 잡는다(MAX_TRACKED_CITATION_FAILURES 주석).
			parts.push(`${stats.citationRetryOverflow}편은 인용수 재시도 대상이 너무 많아 이번엔 건너뜀`);
		}
		if (stats.skippedEntries > 0) {
			parts.push(`${stats.skippedEntries}건은 데이터 형식이 맞지 않아 건너뜀`);
		}
		if (stats.anyTruncated) {
			parts.push('일부 구간은 다 훑지 못해 다음 실행에서 이어집니다');
		}
		if (stats.categoryMismatches > 0) {
			// 정상 상황에서는 절대 발생하지 않는 신호다 — arXiv는 요청한 category로 이미
			// 걸러 응답하므로, 어긋난 게 있다면 수집 도중 요청이 변조됐거나(8번, 프록시로
			// 재현된 사례) 응답 자체가 이상했다는 뜻이다. API.ts가 이런 항목은 애초에
			// 저장하지 않으므로(무결성 위반, 사용자 요청) 여기 숫자는 "걸렀다"는 뜻이지
			// "잘못 저장됐다"는 뜻이 아니다.
			parts.push(
				`${stats.categoryMismatches}건은 요청한 분류(category)와 실제 응답이 어긋나 저장을 거부함 — ` +
					`수집 경로(프록시 등)를 확인하세요`,
			);
		}
		if (stats.failedSubscriptions.length > 0) {
			// 사유(f.error, CollectAndSave.collect의 describeFailure — "HTTP 503" 등 짧은
			// 형태)와 힌트(f.hint — "그래서 뭘 확인하면 되는지")까지 같이 보여준다. 어느
			// 구독인지만 알아서는 왜 실패했는지, 내가 뭘 할 수 있는지(예: 401이면 키 문제,
			// 503이면 기다리면 됨) 알 수 없다 — 힌트가 빈 문자열이면(원인을 특정 못 함)
			// 사유만 보여준다.
			const detail = stats.failedSubscriptions
				.map((f) => {
					// backfill 실패는 어느 구간이 안 끝났는지 보여줘야 사용자가 그 범위로
					// 「과거 논문 수집」을 다시 열어 재입력할 수 있다 — 조용히 사라지면
					// 영영 모른 채 넘어가는 것을 막는다(recent는 커서가 있어 다음 자동
					// 실행이 알아서 이어가지만, backfill은 그 안전망이 없다).
					const rangeText = f.range
						? ` — 미완료 구간 ${isoDateInput(f.range.from)}~${isoDateInput(f.range.to)}`
						: '';
					return `${f.apiName}(${f.error}${f.hint ? ` — ${f.hint}` : ''}${rangeText})`;
				})
				.join(', ');
			parts.push(`${detail} 구독 수집 실패 — 다른 구독은 정상 진행됨`);
		}
		return parts.length > 0 ? `, ${parts.join(', ')}` : '';
	}

	// buildPartialFailureSuffix가 다루는 신호들은 완료 Notice에 딸려가는 문구라 silent
	// 실행(스케줄러 등)에서는 아무도 못 본다. 그중 "우연이 아니라 계속 반복될 성격"인
	// 신호만 silent 여부와 무관하게 별도 Notice로 알린다 — 나머지(임베딩 실패 몇 편,
	// 스킵 몇 건 등)는 자동 복구되거나 애초에 흔한 일이라 완료 Notice로 충분하다.
	//
	// 이유가 바뀔 때만 알리므로(FailureNotifier) 같은 원인이 반복되는 동안은 조용하다 —
	// 스케줄러가 몇 시간마다 도는데 매번 뜨면 그 자체가 스팸이 된다.
	private checkStructuralFailures(): void {
		const citationStats = this.plugin.collectflow.lastCitationRepairStats;
		if (citationStats && citationStats.attempted >= CollectController.CITATION_REPAIR_MIN_ATTEMPTED) {
			if (citationStats.citationsFixed === 0) {
				this.citationRepairFailureNotifier.notifyFailure(
					'citation-repair-empty',
					() =>
						`PaperGraph3D: 인용수 보정이 ${citationStats.attempted}편을 시도했지만 하나도 ` +
						`성공하지 못했습니다 — Semantic Scholar 키/네트워크 상태를 확인하세요.`,
				);
			} else {
				this.citationRepairFailureNotifier.notifySuccess();
			}
		}

		const stats = this.plugin.collectflow.lastStats;
		if (stats && stats.citationRetryOverflow > 0) {
			const overflow = stats.citationRetryOverflow;
			this.citationOverflowNotifier.notifyFailure(
				'citation-retry-overflow',
				() =>
					`PaperGraph3D: 이번 수집에서 인용수 재시도 대상이 너무 많아 ${overflow}편을 건너뛰었습니다 ` +
					`— 다음 플러그인 로드 때 자동으로 보정됩니다.`,
			);
		} else {
			this.citationOverflowNotifier.notifySuccess();
		}

		if (stats && stats.categoryMismatches > 0) {
			const mismatches = stats.categoryMismatches;
			this.categoryMismatchNotifier.notifyFailure(
				'category-mismatch',
				() =>
					`PaperGraph3D: 요청한 분류(category)와 실제 응답이 어긋나 ${mismatches}건의 저장을 ` +
					`거부했습니다 — 수집 요청이 중간에 변조됐을 수 있습니다. 네트워크/프록시 설정을 확인하세요.`,
			);
		} else {
			this.categoryMismatchNotifier.notifySuccess();
		}
		// droppedInvalidConditions(9번/69번 화이트리스트로 걸러진 구독 조건)는 여기서
		// 더 이상 Notice로 안 띄운다(사용자 요청) — 걸러진 구독은 이미 File 계층에서
		// 완전히 삭제되고, SubscriptionTargetModal/ApiManagementModal이 그 창을 여는
		// 시점에 이미 알린다(notifyDroppedConditions). 자동 수집(silent 실행)까지 매번
		// 알리는 건 과했다는 판단 — stats에는 계속 실어 보낸다(로그로는 남아 디버깅에
		// 쓸 수 있다), UI 알림만 없앤다.
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
