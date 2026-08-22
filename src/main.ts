import { Notice, Plugin } from 'obsidian';
import type { SearchQuery } from './collect/SearchQuery';
import { CollectAndSave } from './collect/CollectAndSave';
import { shouldRunLoadRepair } from './common/ScheduleSettings';
import { Embedding } from './collect/Embedding';
import { VisualizationFlow } from './visualize/VisualizationFlow';
import { PCA } from './visualize/PCA';
import { Visualization } from './visualize/Visualization';
import {
	CitationColorMiddleware,
	CitationEdgeMiddleware,
	ClusterColorMiddleware,
	EdgeToggleMiddleware,
	OpenNoteOnClickMiddleware,
} from './visualize/VisualMiddlewares';
import { PersonalNoteMiddleware } from './visualize/PersonalNoteMiddleware';
import { EventListener } from './common/EventListener';
import { TaskManager } from './common/TaskManager';
import { Task } from './common/Task';
import { Scheduler } from './common/Scheduler';
import { File } from './common/File';
import { Log } from './common/Log';
import { SettingTab } from './adapter/SettingTab';
import { ApiManagementModal } from './adapter/ApiManagementModal';
import { ScheduleModal } from './adapter/ScheduleModal';
import { CollectController } from './adapter/CollectController';
import { VisualizationView, VIEW_TYPE_PAPERGRAPH3D } from './adapter/VisualizationView';

export default class PaperGraph3D extends Plugin {
	collectflow!: CollectAndSave;
	visualflow!: VisualizationFlow;
	eventListener!: EventListener;
	taskManager!: TaskManager;
	collectController!: CollectController;
	scheduler!: Scheduler;

	async onload() {
		this.init();

		// 3번: 보정 자동화 — 매 수집 직후의 자동 보정(CollectAndSave.runNow)은 그 실행에서
		// 실패한 논문만 메모리로 즉시 재시도해 디스크 전수 스캔이 없지만, 그 방식으로는
		// "예전 세션에서 실패한 채 방치된 논문"(sourceId -> 경로 인덱스가 없어 달리 찾을
		// 방법이 없다)을 못 잡는다. 그 방치분은 로드 1회에만 전수 스캔으로 훑어 되살린다 —
		// 수집마다가 아니라 로드마다이므로 빈도가 훨씬 낮다. 모델 미설치 등으로 실패해도
		// 플러그인 시작 자체를 막지 않는다(fire-and-forget).
		//
		// 재시작 간 쿨다운(shouldRunLoadRepair): 이 보정은 인용수 재조회(S2 API)까지
		// 포함한다. Obsidian을 자주 껐다 켜면(테스트 중 등) 쿨다운 없이는 매번 즉시 S2를
		// 두드려, 이미 rate limit(429)에 걸린 상태를 재시작마다 계속 악화시킨다(2026-08
		// 재현 확인). CollectAndSave는 로드마다 새로 만들어져 인메모리 쿨다운이 재시작을
		// 못 버티므로, Schedule.json에 실행 시각을 먼저 기록해(Scheduler.runNow와 같은
		// 순서 — 중간에 죽어도 다음 재시작이 무한 재시도하지 않도록) 디스크에 남긴다.
		// 설정 탭의 수동 「보정」 버튼(ui:collect-repair 이벤트 경로)은 이 쿨다운을 안
		// 탄다 — 사용자가 명시적으로 다시 해보라는 요청은 존중한다.
		void (async () => {
			const settings = await File.readScheduleSettings();
			if (!shouldRunLoadRepair(settings.lastLoadRepairAt, Date.now())) {
				Log.info('collect', '로드 시 자동 보정 건너뜀 — 쿨다운 중', {
					lastLoadRepairAt: settings.lastLoadRepairAt,
				});
				return;
			}
			await File.writeScheduleSettings({ ...settings, lastLoadRepairAt: Date.now() });
			await this.collectflow.repair();
		})().catch((error) => {
			Log.error('collect', '로드 시 자동 보정 실패', error);
		});

		this.registerView(
			VIEW_TYPE_PAPERGRAPH3D,
			(leaf) => new VisualizationView(leaf, this),
		);

		this.addSettingTab(new SettingTab(this.app, this));

		// 6번: 자동 수집 스케줄링 — 폴링 없이 "다음 목표 시각까지 남은 시간"을 한 번
		// 계산해 정확히 그 시점에 실행되는 타이머를 건다(Scheduler.scheduleNext). 로드
		// 시점에 오늘 목표 시각을 이미 지났는데 아직 실행 안 됐으면(그 시각에 앱이 꺼져
		// 있었다는 뜻) 캐치업으로 즉시 1회 실행한다(Scheduler.start 참고). 타이머 자체는
		// Scheduler가 스스로(재귀 재예약) 관리하므로 registerInterval에 등록하지 않고,
		// onunload에서 명시적으로 stop()한다.
		void this.scheduler.start().catch((error) => {
			Log.error('scheduler', '자동 수집 스케줄러 시작 실패', error);
		});

		this.addCommand({
			id: 'collect-recent',
			name: '최근 논문 수집 실행',
			callback: async () => {
				try {
					await this.eventListener.checking('ui:collect-recent');
				} catch (e) {
					new Notice(`최근 논문 수집 실패: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		// 과거 논문 수집 커맨드는 두지 않는다 — 어느 구간을 메울지(from/to)가 필수인 작업이라
		// 인자를 못 받는 커맨드 팔레트에서는 항상 실패한다. 수집 메뉴(리본 아이콘/설정 탭)의
		// 과거 논문 수집 항목이 날짜 입력을 받아 run('backfill', {from, to})로 실행하는 것이
		// 유일한 경로다.

		// "보정 실행" 커맨드는 없앴다(2026-08 팀 합의) — 보정은 사용자가 몰라도 되는
		// 백그라운드 작업으로 설계됐는데(로드 시 자동 보정, main.ts 아래), 이 커맨드만
		// 사용자가 직접 커맨드 팔레트에서 찾아 실행해야 하는 예외였고, 성공해도 Notice가
		// 없어 반쪽짜리였다(실패만 알림). 「새로고침」이 force:true로 인용수를 이미 전부
		// 다시 확인하고 있어(API.Refresh) 이 커맨드의 실질적 니즈(쿨다운 기다리지 않고
		// 지금 당장 다시 확인)를 이미 포괄한다 — 순수 중복이라 판단해 제거.
		// (collectflow.repair() 자체는 로드 시 자동 보정이 계속 쓰므로 그대로 남는다.)

		this.addRibbonIcon('network', '시각화 열기', () => {
			void this.activateVisualizationView();
		});

		this.addRibbonIcon('download', '수집', (evt) => {
			this.collectController.openCollectMenu(evt, this.app);
		});

		// 새로고침(전체 코퍼스 강제 재조회)은 지금까지 설정 탭 버튼으로만 접근할 수
		// 있었다 — 수집/구독 관리처럼 자주 쓰는 진입점이라 왼쪽 리본에도 바로가기를
		// 추가한다. 실행 로직은 설정 탭 버튼과 동일하게 'ui:collect-refresh' 이벤트를
		// 그대로 재사용한다(SettingTab.ts 참고).
		this.addRibbonIcon('refresh-cw', '새로고침', () => {
			void this.eventListener.checking('ui:collect-refresh').catch((e) => {
				new Notice(`새로고침 실패: ${e instanceof Error ? e.message : String(e)}`);
			});
		});

		this.addCommand({
			id: 'open-subscription-manager',
			name: '구독 관리 열기',
			callback: () => {
				new ApiManagementModal(this.app, this).open();
			},
		});

		this.addRibbonIcon('rss', '구독 관리', () => {
			new ApiManagementModal(this.app, this).open();
		});

		// 자동 수집 설정(켜기/끄기·실행 시각)도 구독 관리와 같은 이유로 설정 탭을
		// 거치지 않고 바로 열 수 있게 한다 — ScheduleModal.ts 참고.
		this.addCommand({
			id: 'open-schedule-manager',
			name: '자동 수집 관리 열기',
			callback: () => {
				new ScheduleModal(this.app, this).open();
			},
		});

		this.addRibbonIcon('clock', '자동 수집 관리', () => {
			new ScheduleModal(this.app, this).open();
		});
	}

	// 다이어그램의 PaperGraph3D.init() — collectflow/visualflow/eventListener/
	// taskManager를 생성하고 연결한다. File은 static이라 인스턴스 없이 init()으로
	// vault 참조만 등록한다. Embedding은 인스턴스 필드지만 vault/플러그인 폴더 참조는
	// 마찬가지로 init()에서 한 번만 등록한다 (동기 + I/O 없음 — 모델 확인은 지연 계산).
	// 등록 계열 함수만 호출하므로 안전하게 완료된다.
	init(): void {
		this.collectflow = new CollectAndSave();
		this.collectflow.embedding = new Embedding();
		this.visualflow = new VisualizationFlow();
		this.visualflow.pca = new PCA();
		this.visualflow.visual = new Visualization();
		// 피인용수에 따라 노드 색(파랑/주황)을 칠하는 시각화 미들웨어 등록.
		this.visualflow.setMiddleware(new CitationColorMiddleware());
		// 노드 클릭 시 해당 논문 .md 노트를 여는 시각화 미들웨어 등록.
		this.visualflow.setMiddleware(new OpenNoteOnClickMiddleware(this.app));
		// 논문 간 인용 관계를 엣지로 그리는 시각화 미들웨어 등록.
		this.visualflow.setMiddleware(new CitationEdgeMiddleware());
		// vault의 개인 노트를 임베딩해 논문 노드와 같은 그래프에 얹는 시각화 미들웨어 등록.
		// 다른 시각화 미들웨어의 등록 여부/순서에 의존하지 않으므로 순서는 상관없다.
		this.visualflow.setMiddleware(
			new PersonalNoteMiddleware(this.app, this.collectflow.embedding, () =>
				this.visualflow.run(),
			),
		);
		// 엣지를 껐다 켜는 스위치 UI 시각화 미들웨어 등록.
		this.visualflow.setMiddleware(new EdgeToggleMiddleware());
		// 클러스터 색칠 미들웨어. 기본 꺼짐이고 자체 스위치 UI로 켠다. CitationColor 뒤에
		// 등록해야, 켜졌을 때 paint()가 인용 색을 previousColors로 기억하고 그 위에 덩어리
		// 색을 덮는다(끄면 인용 색으로 복원).
		this.visualflow.setMiddleware(new ClusterColorMiddleware());
		File.init(this.app.vault, this.manifest.dir ?? '');
		// ⚠️ 임시 진단 코드 — 삭제 예정(src/common/Log.ts 상단 참고). 이 한 줄을 빼면
		// 로그는 콘솔로만 나가고 vault에는 아무것도 안 남는다.
		Log.init(this.app.vault, this.manifest.dir ?? '');
		this.collectflow.embedding.init(this.app.vault, this.manifest.dir ?? '');
		// collectflow가 준비된 뒤에 만들어야 한다 — 생성자에서 바로 진단 미들웨어를
		// collectflow에 등록한다(CollectController 참고).
		this.collectController = new CollectController(this);
		this.eventListener = new EventListener();
		this.taskManager = new TaskManager();
		// checking()이 taskName -> 실제 실행으로 이어지려면 TaskManager가 있어야 한다 —
		// 이벤트 등록(setEventListener)과 TaskManager 생성이 여기 같은 자리에서 동시에
		// 새로 만들어져 생성자로는 서로를 받을 수 없다.
		this.eventListener.bindTaskManager(this.taskManager);

		// Task는 인터페이스라(src/common/Task.ts) `new Task()`로 만들 수 없다 — 객체
		// 리터럴로 taskName/func을 채워 넘긴다.
		const collectRecentTask: Task = {
			taskName: 'collect:recent',
			// collectflow.run()을 진행률 콜백 없이 부르면 대기열 박스에 구독별 진행(순번 포함)이
			// 하나도 안 뜬다 — CollectController.runRecentAuto()를 거쳐 수동 실행과 같은 자리
			// (activeFlow)에 진행 상태가 쌓이게 한다. Notice는 안 뜬다(runRecentAuto가 silent로
			// 돈다 — 자동 수집/명령어 팔레트는 원래 조용히 도는 게 설계 의도였다). 왜 별도 sink로
			// 우회하지 않고 CollectController를 거치는 쪽을 택했는지는 devLog(010) 참고.
			func: () => this.collectController.runRecentAuto(),
		};
		this.taskManager.setTask(collectRecentTask);

		// 신규 구독 등록 직후 그 구독 하나만 자동으로 1회 수집하기 위한 별도 작업.
		// 'collect:recent'(전체 대상, 무인자)와 계약이 다르므로 이름을 따로 둔다 — 인자를
		// 받아 분기하면 runTask(taskName, ...args)가 unknown[]이라 타입 안전성이 없어진다.
		const collectRecentOneTask: Task = {
			taskName: 'collect:recent-one',
			func: (...args: unknown[]) => {
				const target = args[0] as { apiName: string; querys: SearchQuery[] };
				return this.collectController.runRecentOneAuto(target);
			},
		};
		this.taskManager.setTask(collectRecentOneTask);

		// 'collect:repair' 태스크/'ui:collect-repair' 이벤트는 없앴다 — "보정 실행" 커맨드가
		// 유일한 호출부였는데 그 커맨드 자체를 제거했다(위 참고). collectflow.repair()는
		// 로드 시 자동 보정(main.ts onload)이 계속 직접 호출한다.

		// 전체 코퍼스 강제 새로고침(인용수 강제 재조회 + arXiv 개정판 감지) — 설정 탭/리본
		// 「새로고침」 전용. repair와 달리 실패한 것만이 아니라 전부 다시 확인하므로 별도
		// 작업/이벤트로 둔다.
		const collectRefreshTask: Task = {
			taskName: 'collect:refresh',
			func: () => this.collectController.refreshAllAuto(),
		};
		this.taskManager.setTask(collectRefreshTask);

		this.eventListener.setEventListener('ui:collect-recent', 'collect:recent');
		this.eventListener.setEventListener('ui:collect-recent-one', 'collect:recent-one');
		this.eventListener.setEventListener('ui:collect-refresh', 'collect:refresh');
		// 6번: 스케줄러도 같은 'collect:recent' 작업을 탄다 — 자동이든 수동이든 "최근 논문
		// 수집"은 하나의 작업이고, 스케줄러는 그걸 언제 부를지만 결정한다.
		this.eventListener.setEventListener('scheduler:collect-recent', 'collect:recent');
		// registerTimer 콜백으로 Plugin.registerInterval을 넘긴다 — Scheduler는 Obsidian을
		// 직접 import하지 않지만, 이 콜백을 통해 "타이머는 Plugin이 언로드 시 자동으로
		// 치운다"는 보장을 그대로 받는다(Scheduler.ts 상단 주석 참고).
		this.scheduler = new Scheduler(this.eventListener, (id) => this.registerInterval(id));
	}

	async activateVisualizationView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_PAPERGRAPH3D)[0];
		if (!leaf) {
			// 사이드 패널이 아니라 현재(메인) 탭에서 연다.
			leaf = workspace.getLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_PAPERGRAPH3D, active: true });
		}

		await workspace.revealLeaf(leaf);
	}

	// 플러그인이 꺼지거나 리로드될 때. 이미 나간 requestUrl 호출은 취소할 수 없지만
	// (CollectAndSave.dispose 주석 참고), 그 뒤로 큐에서 새 작업을 시작하거나 다음
	// 구독으로 넘어가는 것은 여기서 멈춘다 — 안 그러면 언로드 후에도 백그라운드에서
	// 수집이 계속 돈다.
	onunload() {
		// 재귀 재예약(Scheduler.scheduleNext)이라 registerInterval로는 못 정리한다 —
		// 명시적으로 멈추지 않으면 다음 목표 시각에 언로드된 플러그인이 여전히 타이머를
		// 울릴 수 있다.
		this.scheduler?.stop();
		this.collectflow?.dispose();
		// ⚠️ 임시 진단 코드 — 삭제 예정. flush 타이머가 안 치워지면 언로드 후에도 타이머가
		// 남아 다음 로드 때 두 개의 타이머가 같은 파일을 두고 경쟁하게 된다.
		Log.dispose();
	}
}
