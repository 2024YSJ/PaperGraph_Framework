import { Notice, Plugin } from 'obsidian';
import { CollectAndSave } from './collect/CollectAndSave';
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
import { EventListener } from './common/EventListener';
import { TaskManager } from './common/TaskManager';
import { Task } from './common/Task';
import { Scheduler } from './common/Scheduler';
import { File } from './common/File';
import { Log } from './common/Log';
import { SettingTab } from './adapter/SettingTab';
import { ApiManagementModal } from './adapter/ApiManagementModal';
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
		void this.collectflow.repair().catch((error) => {
			Log.error('collect', '로드 시 자동 보정 실패', error);
		});

		this.registerView(
			VIEW_TYPE_PAPERGRAPH3D,
			(leaf) => new VisualizationView(leaf, this),
		);

		this.addSettingTab(new SettingTab(this.app, this));

		// 6번: 자동 수집 스케줄링 — 5분마다 설정(Schedule.json)을 다시 읽어 "지금이
		// 실행할 때인가"를 판단한다(Scheduler.tick). 매번 다시 읽으므로 설정 탭에서 주기를
		// 바꿔도 재시작 없이 다음 tick부터 반영된다. registerInterval로 등록해야 플러그인이
		// 언로드될 때 Obsidian이 알아서 타이머를 치운다 — 직접 clearInterval을 관리하면
		// onunload에서 빼먹었을 때 언로드 후에도 백그라운드에서 수집이 계속 걸린다.
		this.registerInterval(
			window.setInterval(() => {
				void this.scheduler.tick().catch((error) => {
					Log.error('scheduler', '자동 수집 확인 실패', error);
				});
			}, 5 * 60 * 1000),
		);
		// 로드 직후에도 한 번 확인한다 — 마지막 자동 실행 이후 플러그인이 오래 꺼져
		// 있었다면 다음 tick(최대 5분 뒤)까지 기다리지 않고 바로 따라잡는다.
		void this.scheduler.tick().catch((error) => {
			Log.error('scheduler', '자동 수집 확인 실패', error);
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

		// Backfill 커맨드는 두지 않는다 — 어느 구간을 메울지(from/to)가 필수인 작업이라
		// 인자를 못 받는 커맨드 팔레트에서는 항상 실패한다. 설정 탭의 Backfill 버튼이
		// 날짜 입력을 받아 run('backfill', {from, to})로 실행하는 것이 유일한 경로다.

		this.addCommand({
			id: 'collect-repair',
			name: '보정 실행 (임베딩·인용수 재시도)',
			callback: async () => {
				try {
					await this.eventListener.checking('ui:collect-repair');
				} catch (e) {
					new Notice(`보정 실패: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		this.addRibbonIcon('network', '시각화 열기', () => {
			void this.activateVisualizationView();
		});

		this.addRibbonIcon('download', '수집', (evt) => {
			this.collectController.openCollectMenu(evt, this.app);
		});

		this.addCommand({
			id: 'open-subscription-manager',
			name: '구독 관리 열기',
			callback: () => {
				new ApiManagementModal(this.app).open();
			},
		});

		this.addRibbonIcon('rss', '구독 관리', () => {
			new ApiManagementModal(this.app).open();
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

		const collectRecentTask = new Task();
		collectRecentTask.taskName = 'collect:recent';
		// collectflow.run()을 진행률 콜백 없이 부르면 대기열 박스에 구독별 진행(순번 포함)이
		// 하나도 안 뜬다 — CollectController.runRecentAuto()를 거쳐 수동 실행과 같은 자리
		// (activeFlow)에 진행 상태가 쌓이게 한다. Notice는 안 뜬다(runRecentAuto가 silent로
		// 돈다 — 자동 수집/명령어 팔레트는 원래 조용히 도는 게 설계 의도였다). 왜 별도 sink로
		// 우회하지 않고 CollectController를 거치는 쪽을 택했는지는 devLog(010) 참고.
		collectRecentTask.func = () => this.collectController.runRecentAuto();
		this.taskManager.setTask(collectRecentTask);

		const collectRepairTask = new Task();
		collectRepairTask.taskName = 'collect:repair';
		collectRepairTask.func = () => this.collectflow.repair();
		this.taskManager.setTask(collectRepairTask);

		this.eventListener.setEventListener('ui:collect-recent', 'collect:recent');
		this.eventListener.setEventListener('ui:collect-repair', 'collect:repair');
		// 6번: 스케줄러도 같은 'collect:recent' 작업을 탄다 — 자동이든 수동이든 "최근 논문
		// 수집"은 하나의 작업이고, 스케줄러는 그걸 언제 부를지만 결정한다.
		this.eventListener.setEventListener('scheduler:collect-recent', 'collect:recent');
		this.scheduler = new Scheduler(this.eventListener);
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
		this.collectflow?.dispose();
		// ⚠️ 임시 진단 코드 — 삭제 예정. flush 타이머가 안 치워지면 언로드 후에도 타이머가
		// 남아 다음 로드 때 두 개의 타이머가 같은 파일을 두고 경쟁하게 된다.
		Log.dispose();
	}
}
