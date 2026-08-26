import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type PaperGraph3D from '../main';
import { PCAError, type PCAExcluded } from '../visualize/PCA';
import { File } from '../common/File';

export const VIEW_TYPE_PAPERGRAPH3D = 'papergraph3d-visualization-view';

// 시각화 뷰. 열리면 그래프용 컨테이너를 만들어 setContainer로 등록하고, 바로
// VisualizationFlow.run()을 돌려 그래프를 그린다 (설계: docs/devLog/007.md, 008.md).
// run이 논문 로드 → PCA → init → 미들웨어 → render를 한 번에 처리한다.
export class VisualizationView extends ItemView {
	// 그래프를 그리는 컨테이너 — onOpen에서 만들고, 컨텍스트 손실 후 재렌더에서 재사용한다.
	private graphContainer?: HTMLElement;
	// 지금 webglcontextlost 리스너를 건 canvas. 재렌더 때마다 새 canvas가 생기므로 추적해
	// 이전 canvas에서 리스너를 뗀다.
	private trackedCanvas?: HTMLCanvasElement;
	// 백그라운드 탭으로 밀려나 WebGL 컨텍스트를 잃었는가. 이 탭이 다시 활성화될 때 이 값이
	// true면 다시 그린다.
	private contextLost = false;

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
		this.graphContainer = container;
		this.plugin.visualflow.visual.setContainer(container);

		// 열리면 바로 시각화를 그린다.
		await this.renderWithRepairRetry(container);
		this.trackCanvas();

		// 노드를 클릭해 노트를 새 탭에 열면 이 뷰가 백그라운드로 밀려나고, Obsidian이 그
		// DOM을 떼어내면서 canvas의 WebGL 컨텍스트가 사라진다(three.js는 자동 복원하지
		// 않아 돌아오면 흰 화면이 된다). 이 탭이 다시 활성화될 때 컨텍스트를 잃은 상태였다면
		// 다시 그린다. render()가 시작 시 dispose()를 부르고 PCA 축은 캐시되므로, 재렌더는
		// 컨텍스트를 새로 만들되 노드 위치는 그대로 유지한다.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf === this.leaf && this.contextLost) {
					void this.rerenderAfterContextLoss();
				}
			}),
		);
	}

	async onClose(): Promise<void> {
		this.untrackCanvas();
		// 3d-force-graph/WebGL 컨텍스트를 정리한다 — 안 하면 재오픈·플러그인 리로드마다
		// 컨텍스트가 쌓여 한도를 넘겨 시각화가 안 뜬다.
		this.plugin.visualflow.visual.dispose();
		this.graphContainer = undefined;
		this.contentEl.removeClass('papergraph3d-view');
		this.contentEl.empty();
	}

	// 컨텍스트를 잃은 뒤 이 탭이 다시 활성화됐을 때 그래프를 다시 그린다. 재렌더가 새
	// canvas를 만들므로 리스너도 그 canvas에 다시 건다.
	private async rerenderAfterContextLoss(): Promise<void> {
		const container = this.graphContainer;
		if (!container) {
			return;
		}
		// 재렌더 자체가 dispose()로 옛 canvas의 컨텍스트를 강제 반납하며 contextlost를
		// 다시 쏘므로, 그 이벤트가 이 플래그를 되살리지 않도록 먼저 리스너를 떼고 내린다.
		this.untrackCanvas();
		this.contextLost = false;
		await this.renderWithRepairRetry(container);
		this.trackCanvas();
	}

	// 지금 컨테이너 안의 canvas에 webglcontextlost 리스너를 건다. preventDefault로 브라우저가
	// 컨텍스트를 영구 손실로 못박지 않게 하고, 플래그만 세워 재활성화 시점에 재렌더한다.
	private trackCanvas(): void {
		const canvas = this.graphContainer?.querySelector('canvas') ?? undefined;
		if (!canvas) {
			return;
		}
		this.trackedCanvas = canvas;
		canvas.addEventListener('webglcontextlost', this.handleContextLost);
	}

	private untrackCanvas(): void {
		this.trackedCanvas?.removeEventListener('webglcontextlost', this.handleContextLost);
		this.trackedCanvas = undefined;
	}

	// 화살표 함수 필드라 add/removeEventListener가 같은 참조를 가리킨다(정상적으로 해제됨).
	private readonly handleContextLost = (event: Event): void => {
		event.preventDefault();
		this.contextLost = true;
	};

	// PCA가 needsReembedding(임베딩이 안 됐거나 깨진 논문)을 신호로 주면, 그 논문들만
	// collectflow.repairEmbeddings()로 재임베딩한 뒤 파이프라인을 한 번 더 돌린다. 인용수는
	// 건드리지 않는다 — PCA는 임베딩만 신경 쓰므로 시각화를 열 때마다 불필요한 S2 호출이
	// 딸려가면 안 된다(인용수 재보강은 수집 직후 CollectAndSave.runNow가 따로 자동으로 돈다).
	// retried를 둬서 재시도는 딱 한 번만 — repairEmbeddings 뒤에도 여전히 실패하는 논문이
	// 있으면(원인 불명) 여기서 무한 왕복하지 않고 남은 실패를 그대로 보여준다.
	private async renderWithRepairRetry(container: HTMLElement, retried = false): Promise<void> {
		try {
			await this.plugin.visualflow.run();
			// malformed/duplicateId는 needsReembedding에 안 잡힌다(재임베딩으로 못 고치는
			// 구조적 손상이라 — sourceId가 없거나 다른 논문과 겹침) — 그래서 위 재시도
			// 경로를 안 타고 조용히 그래프에서 빠진 채로 남았다(무알림, 실사용에서 지적됨).
			// PCA는 이미 이유별 제외 수를 계산해두므로(PCAResult.excluded), 여기서 읽어
			// 알리기만 하면 된다 — PCA 쪽 계산 로직은 그대로 둔다.
			this.notifyPermanentExclusions(this.plugin.visualflow.lastResult?.excluded);
			this.notifySkippedFiles();
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
			// PCAError(유효 논문 부족 등)는 메시지를 그대로 보여준다. 그래프 자체를 못
			// 그린 상황에서도 malformed/duplicateId로 빠진 게 있으면 같이 알린다 —
			// needsReembedding 재시도 대상이 아니라서 위 분기를 안 거치고 여기로 오므로.
			this.notifyPermanentExclusions(error instanceof PCAError ? error.excluded : undefined);
			this.notifySkippedFiles();
			container.setText(
				error instanceof PCAError
					? `시각화 실패: ${error.message}`
					: `시각화 오류: ${String(error)}`,
			);
		}
	}

	// malformed(sourceId 없음/해석 불가)·duplicateId(같은 sourceId 중복)로 제외된 논문은
	// 재임베딩으로 고칠 방법이 없어(needsReembedding에 안 잡힘) 이전엔 완전히 무알림이었다
	// (excluded 값 자체는 PCA가 이미 정확히 계산해두고 있었는데, 읽는 쪽이 없었을 뿐).
	// 어느 논문인지(sourceId)까지는 PCAExcluded가 안 갖고 있어 편수만 알린다 — 구체적인
	// 원인 조사는 콘솔 로그/직접 코퍼스 확인이 필요하다는 걸 문구에 명시한다.
	private notifyPermanentExclusions(excluded: PCAExcluded | undefined): void {
		if (!excluded) {
			return;
		}
		const parts: string[] = [];
		if (excluded.malformed > 0) {
			parts.push(`sourceId 없음/해석 불가 ${excluded.malformed}편`);
		}
		if (excluded.duplicateId > 0) {
			parts.push(`sourceId 중복 ${excluded.duplicateId}편`);
		}
		if (parts.length === 0) {
			return;
		}
		new Notice(
			`PaperGraph3D: 그래프에서 영구히 제외된 논문이 있습니다 (${parts.join(', ')}) ` +
				`— 재임베딩으로 고칠 수 없는 구조적 손상이라, 콘솔 로그나 코퍼스를 직접 확인해야 합니다.`,
		);
	}

	// 콘텐츠 트리 규격을 벗어난 파일(달력에 없는 날짜 폴더, 미래 날짜, 연도 폴더 바로 밑
	// 저장 등 — QA 12/15/18번)은 File이 스캔에서 조용히 걸러낸다. 그대로 두면 "분명
	// 파일을 넣었는데 안 보인다"가 되므로, 걸러진 게 있을 때만 한 번 알린다. 어느
	// 파일인지는 개수가 많을 수 있어 콘솔 로그(File 쪽 Log.warn)로 넘긴다.
	private notifySkippedFiles(): void {
		const skipped = File.lastScanSkipped;
		if (skipped.count === 0) {
			return;
		}
		new Notice(
			`PaperGraph3D: 저장 규격에 맞지 않는 논문 파일 ${skipped.count}개를 건너뛰었습니다 ` +
				`(PaperGraph3D/<연>/<월>/<일>/ 아래의 정상 날짜 폴더만 읽습니다) — 경로는 콘솔 로그를 확인하세요.`,
		);
	}
}
