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

		this.addCommand({
			id: 'collect-backfill',
			name: 'Backfill 실행',
			callback: async () => {
				try {
					await this.eventListener.checking('ui:collect-backfill');
				} catch {
					new Notice('아직 구현되지 않음: Backfill');
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

		const collectBackfillTask = new Task();
		collectBackfillTask.taskName = 'collect:backfill';
		collectBackfillTask.func = () => this.collectflow.run('backfill');
		this.taskManager.setTask(collectBackfillTask);

		this.eventListener.setEventListener('ui:collect-recent', 'collect:recent');
		this.eventListener.setEventListener('ui:collect-backfill', 'collect:backfill');
	}

	async activateVisualizationView(): Promise<void> {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_PAPERGRAPH3D)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await rightLeaf.setViewState({ type: VIEW_TYPE_PAPERGRAPH3D, active: true });
			leaf = rightLeaf;
		}

		await workspace.revealLeaf(leaf);
	}

	onunload() {}
}
