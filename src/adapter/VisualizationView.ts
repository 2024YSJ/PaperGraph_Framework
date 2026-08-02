import { ItemView, WorkspaceLeaf, Notice, ButtonComponent } from 'obsidian';
import type PaperGraph3D from '../main';

export const VIEW_TYPE_PAPERGRAPH3D = 'papergraph3d-visualization-view';

// 시각화용 임시 뷰. VisualizationFlow.run()이 PCA -> 초기화 -> 렌더링을 한 번에
// 묶어서 돌리기 때문에, 담당자별로 각 단계가 구현되는 대로 따로 확인할 수 있도록
// 단계별 버튼(PCA/초기화/렌더링)과 전체 파이프라인 버튼을 나눠서 둔다.
export class VisualizationView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PaperGraph3D,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PAPERGRAPH3D;
	}

	getDisplayText(): string {
		return 'PaperGraph3D 시각화';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'PaperGraph3D 시각화' });
		contentEl.createEl('p', {
			text: '단계별로 구현되는 대로 아래 버튼으로 각각 확인할 수 있습니다.',
		});

		contentEl.createEl('h4', { text: '1. PCA' });
		contentEl.createEl('p', { text: 'PCA 클래스에 아직 함수가 정의되지 않아 단계 테스트 버튼이 없습니다.' });

		contentEl.createEl('h4', { text: '2. 시각화 초기화' });
		new ButtonComponent(contentEl).setButtonText('init() 실행').onClick(async () => {
			try {
				this.plugin.visualflow.visual.init();
			} catch {
				new Notice('아직 구현되지 않음: Visualization.init');
			}
		});

		contentEl.createEl('h4', { text: '3. 그래프 렌더링' });
		new ButtonComponent(contentEl).setButtonText('render() 실행').onClick(async () => {
			try {
				this.plugin.visualflow.visual.render();
			} catch {
				new Notice('아직 구현되지 않음: Visualization.render');
			}
		});

		contentEl.createEl('h4', { text: '전체 파이프라인' });
		new ButtonComponent(contentEl).setButtonText('run() 전체 실행').onClick(async () => {
			try {
				await this.plugin.visualflow.run();
			} catch {
				new Notice('아직 구현되지 않음: 시각화 실행');
			}
		});
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
