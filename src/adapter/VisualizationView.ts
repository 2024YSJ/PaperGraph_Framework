import { ItemView, WorkspaceLeaf } from 'obsidian';
import type PaperGraph3D from '../main';
import { PCAError } from '../visualize/PCA';

export const VIEW_TYPE_PAPERGRAPH3D = 'papergraph3d-visualization-view';

// 시각화 뷰. 열리면 그래프용 컨테이너를 만들어 setContainer로 등록하고, 바로
// VisualizationFlow.run()을 돌려 그래프를 그린다 (설계: docs/devLog/007.md, 008.md).
// run이 논문 로드 → PCA → init → 미들웨어 → render를 한 번에 처리한다.
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
		// 뷰를 화면 크기에 꽉 맞추고 스크롤바가 안 생기게 한다(styles.css).
		contentEl.addClass('papergraph3d-view');

		// 그래프를 그릴 컨테이너 — 뷰를 열 때마다 새로 만들어 등록한다(DOM 수명 = 뷰 수명).
		const container = contentEl.createDiv({ cls: 'papergraph3d-graph' });
		this.plugin.visualflow.visual.setContainer(container);

		// 열리면 바로 시각화를 그린다.
		try {
			await this.plugin.visualflow.run();
		} catch (error) {
			// PCAError(유효 논문 부족 등)는 메시지를 그대로 보여준다.
			container.setText(
				error instanceof PCAError
					? `시각화 실패: ${error.message}`
					: `시각화 오류: ${String(error)}`,
			);
		}
	}

	async onClose(): Promise<void> {
		this.contentEl.removeClass('papergraph3d-view');
		this.contentEl.empty();
	}
}
