import { Notice, Plugin } from 'obsidian';
import { CollectAndSave } from './collect/CollectAndSave';
import { Embedding } from './collect/Embedding';
import { VisualizationFlow } from './visualize/VisualizationFlow';
import { PCA } from './visualize/PCA';
import { Visualization } from './visualize/Visualization';
import {
	CitationColorMiddleware,
	CitationEdgeMiddleware,
	OpenNoteOnClickMiddleware,
} from './visualize/VisualMiddlewares';
import { EventListener } from './common/EventListener';
import { TaskManager } from './common/TaskManager';
import { Task } from './common/Task';
import { File } from './common/File';
import { Log } from './common/Log';
import { SettingTab } from './adapter/SettingTab';
import { VisualizationView, VIEW_TYPE_PAPERGRAPH3D } from './adapter/VisualizationView';

export default class PaperGraph3D extends Plugin {
	collectflow!: CollectAndSave;
	visualflow!: VisualizationFlow;
	eventListener!: EventListener;
	taskManager!: TaskManager;

	async onload() {
		this.init();

		this.registerView(
			VIEW_TYPE_PAPERGRAPH3D,
			(leaf) => new VisualizationView(leaf, this),
		);

		this.addSettingTab(new SettingTab(this.app, this));

		// EventListener.checking()/TaskManager.runTask()가 구현됨(009 devLog) — 두 커맨드
		// 모두 실제로 collectflow.run()/repair()까지 도달한다. catch는 더 이상 "미구현"을
		// 뜻하지 않으므로 실제 에러 메시지를 보여준다(SettingTab.ts의 Notice 관례와 동일).

		this.addCommand({
			id: 'collect-recent',
			name: '최근 논문 수집 실행',
			callback: async () => {
				try {
					await this.eventListener.checking('ui:collect-recent');
					new Notice('최근 논문 수집을 마쳤습니다.');
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					new Notice(`최근 논문 수집 실패: ${message}`);
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
					new Notice('보정을 마쳤습니다.');
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					new Notice(`보정 실패: ${message}`);
				}
			},
		});

		this.addRibbonIcon('network', '시각화 열기', () => {
			void this.activateVisualizationView();
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
		File.init(this.app.vault, this.manifest.dir ?? '');
		// ⚠️ 임시 진단 코드 — 삭제 예정(src/common/Log.ts 상단 참고). 이 한 줄을 빼면
		// 로그는 콘솔로만 나가고 vault에는 아무것도 안 남는다.
		Log.init(this.app.vault, this.manifest.dir ?? '');
		this.collectflow.embedding.init(this.app.vault, this.manifest.dir ?? '');
		this.eventListener = new EventListener();
		this.taskManager = new TaskManager();
		this.eventListener.setTaskManager(this.taskManager);

		const collectRecentTask: Task = {
			taskName: 'collect:recent',
			func: () => this.collectflow.run('recent'),
		};
		this.taskManager.setTask(collectRecentTask);

		const collectRepairTask: Task = {
			taskName: 'collect:repair',
			func: () => this.collectflow.repair(),
		};
		this.taskManager.setTask(collectRepairTask);

		this.eventListener.setEventListener('ui:collect-recent', 'collect:recent');
		this.eventListener.setEventListener('ui:collect-repair', 'collect:repair');
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
