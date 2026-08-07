import { Notice, Plugin } from 'obsidian';
import { CollectAndSave } from './collect/CollectAndSave';
import { Embedding } from './collect/Embedding';
import { VisualizationFlow } from './visualize/VisualizationFlow';
import { PCA } from './visualize/PCA';
import { Visualization } from './visualize/Visualization';
import { EventListener } from './common/EventListener';
import { TaskManager } from './common/TaskManager';
import { Task } from './common/Task';
import { File } from './common/File';
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

		// ⚠️ 두 커맨드 모두 EventListener.checking()/TaskManager.runTask()가 아직 스텁이라
		// (둘 다 항상 throw — 담당자 미배정, 8/1 회의록 역할분담에 없음) run()/repair()에
		// 도달하지 못한다. 이벤트 배선이 구현되기 전까지는 설정 탭의 수집/보정 버튼이
		// collectflow를 직접 호출하는 유일한 실동작 경로다.

		this.addCommand({
			id: 'collect-recent',
			name: '최근 논문 수집 실행',
			callback: async () => {
				try {
					await this.eventListener.checking('ui:collect-recent');
				} catch {
					new Notice('아직 구현되지 않음: 최근 논문 수집');
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
				} catch {
					new Notice('아직 구현되지 않음: 보정');
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
		File.init(this.app.vault, this.manifest.dir ?? '');
		this.collectflow.embedding.init(this.app.vault, this.manifest.dir ?? '');
		this.eventListener = new EventListener();
		this.taskManager = new TaskManager();

		const collectRecentTask = new Task();
		collectRecentTask.taskName = 'collect:recent';
		collectRecentTask.func = () => this.collectflow.run('recent');
		this.taskManager.setTask(collectRecentTask);

		const collectRepairTask = new Task();
		collectRepairTask.taskName = 'collect:repair';
		collectRepairTask.func = () => this.collectflow.repair();
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

	onunload() {}
}
