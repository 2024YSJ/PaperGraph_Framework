import { ItemView, WorkspaceLeaf, Notice, ButtonComponent } from 'obsidian';
import type PaperGraph3D from '../main';

export const VIEW_TYPE_PAPERGRAPH3D = 'papergraph3d-visualization-view';

// 시각화용 임시 뷰. VisualizationFlow.run()이 아직 미구현이므로 지금은
// placeholder 안내문 + "지금 실행" 버튼만 보여준다.
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
		contentEl.createEl('p', { text: '시각화 준비 중 — VisualizationFlow.run()이 아직 구현되지 않았습니다.' });

		new ButtonComponent(contentEl).setButtonText('지금 실행').onClick(async () => {
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
