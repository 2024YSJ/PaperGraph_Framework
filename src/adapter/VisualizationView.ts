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
		await this.renderWithRepairRetry(container);
	}

	async onClose(): Promise<void> {
		// 3d-force-graph/WebGL 컨텍스트를 정리한다 — 안 하면 재오픈·플러그인 리로드마다
		// 컨텍스트가 쌓여 한도를 넘겨 시각화가 안 뜬다.
		this.plugin.visualflow.visual.dispose();
		this.contentEl.removeClass('papergraph3d-view');
		this.contentEl.empty();
	}

	// PCA가 needsReembedding(임베딩이 안 됐거나 깨진 논문)을 신호로 주면, 그 논문들만
	// collectflow.repairEmbeddings()로 재임베딩한 뒤 파이프라인을 한 번 더 돌린다. 인용수는
	// 건드리지 않는다 — PCA는 임베딩만 신경 쓰므로 시각화를 열 때마다 불필요한 S2 호출이
	// 딸려가면 안 된다(인용수 재보강은 수집 직후 CollectAndSave.runNow가 따로 자동으로 돈다).
	// retried를 둬서 재시도는 딱 한 번만 — repairEmbeddings 뒤에도 여전히 실패하는 논문이
	// 있으면(원인 불명) 여기서 무한 왕복하지 않고 남은 실패를 그대로 보여준다.
	private async renderWithRepairRetry(container: HTMLElement, retried = false): Promise<void> {
		try {
			await this.plugin.visualflow.run();
		} catch (error) {
			if (error instanceof PCAError && error.needsReembedding.length > 0 && !retried) {
				container.setText(
					`임베딩이 안 된 논문 ${error.needsReembedding.length}편을 재시도하는 중...`,
				);
				try {
					await this.plugin.collectflow.repairEmbeddings(error.needsReembedding);
				} catch (repairError) {
					container.setText(
						`보정 실패: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
					);
					return;
				}
				await this.renderWithRepairRetry(container, true);
				return;
			}
			// PCAError(유효 논문 부족 등)는 메시지를 그대로 보여준다.
			container.setText(
				error instanceof PCAError
					? `시각화 실패: ${error.message}`
					: `시각화 오류: ${String(error)}`,
			);
		}
	}
}
