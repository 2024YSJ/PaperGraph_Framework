import { ItemView, WorkspaceLeaf, Notice, ButtonComponent } from 'obsidian';
import type PaperGraph3D from '../main';
import { PCAError, type PCABasis, type PCAResult } from '../visualize/PCA';
import { Paper } from '../collect/Paper';

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
		this.renderPcaSection(contentEl);

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

	// ─────────────────────────────────────────────────────────────
	// PCA 테스트 칸 (스펙 6절 — 이 칸은 PCA 담당이 채운다)
	//
	// ⚠️ 합성 데이터 관련 코드(생성기·덩어리 검증·재사용 검증)는 전부 임시다 (스펙 7절).
	// 임베딩(Embedding)이 실제 벡터를 만들기 시작하면 그쪽과 붙여 확인한 뒤 삭제한다.
	// 지표 표시(describePcaResult)는 실데이터에서도 계속 쓴다.
	// ─────────────────────────────────────────────────────────────

	private pcaResultEl: HTMLElement | null = null;
	private lastPcaPapers: Paper[] = []; // 임시 — 재사용 검증에서 기존 코퍼스로 쓴다
	private lastPcaResult: PCAResult | null = null;
	private lastPcaBasis: PCABasis | null = null;

	private renderPcaSection(contentEl: HTMLElement): void {
		contentEl.createEl('p', {
			text: '합성 벡터로 PCA를 실행하고 검증 지표를 확인합니다. (임시 — 임베딩 구현 전까지)',
		});
		new ButtonComponent(contentEl).setButtonText('합성 데이터로 실행 (60편)').onClick(() => {
			this.runPcaSynthetic();
		});
		new ButtonComponent(contentEl).setButtonText('덩어리 검증 (3덩어리)').onClick(() => {
			this.runPcaClusterCheck();
		});
		new ButtonComponent(contentEl).setButtonText('재사용 검증 (basis)').onClick(() => {
			this.runPcaReuseCheck();
		});
		this.pcaResultEl = contentEl.createEl('pre', { text: '아직 실행하지 않았습니다.' });
	}

	// 기본 실행: 합성 60편으로 fit — 지표가 정상 범위인지 본다
	private runPcaSynthetic(): void {
		const papers = makeSyntheticPapers(60, 3, 1);
		const started = performance.now();
		try {
			const result = this.plugin.visualflow.pca.run(papers);
			const elapsed = performance.now() - started;
			// 재사용 검증이 이어서 쓸 수 있게 보관해 둔다
			this.lastPcaPapers = papers;
			this.lastPcaResult = result;
			this.lastPcaBasis = result.basis;
			this.showPcaText(describePcaResult(result, elapsed));
		} catch (error) {
			this.showPcaText(describePcaError(error));
		}
	}

	// 덩어리 검증: 정답(3덩어리)을 아는 입력을 넣고 결과도 3덩어리로 갈라지는지 수치로 확인 (스펙 7절)
	private runPcaClusterCheck(): void {
		const papers = makeSyntheticPapers(60, 3, 2);
		const started = performance.now();
		try {
			const result = this.plugin.visualflow.pca.run(papers);
			const elapsed = performance.now() - started;
			const separation = describeClusterSeparation(result);
			this.showPcaText(describePcaResult(result, elapsed) + '\n\n' + separation);
		} catch (error) {
			this.showPcaText(describePcaError(error));
		}
	}

	// 재사용 검증: 논문을 20% 미만으로 추가하고 basis를 넘겨, 기존 좌표가 고정되는지 확인 (스펙 9절)
	private runPcaReuseCheck(): void {
		if (this.lastPcaResult === null || this.lastPcaBasis === null) {
			new Notice("먼저 '합성 데이터로 실행'을 눌러 basis를 만들어 주세요");
			return;
		}
		// 5편 추가 = 60편 대비 8.3% 증가 → 재사용 경로를 탄다 (20% 이상이면 refit이 정상)
		const extra = makeSyntheticPapers(5, 3, 3, this.lastPcaPapers.length);
		const combined = [...this.lastPcaPapers, ...extra];
		const started = performance.now();
		try {
			const result = this.plugin.visualflow.pca.run(combined, this.lastPcaBasis);
			const elapsed = performance.now() - started;
			const shift = maxCoordinateShift(this.lastPcaResult, result);
			const lines = [
				describePcaResult(result, elapsed),
				'',
				`재사용 검증: 논문 ${extra.length}편 추가 후 기존 좌표 최대 이동 = ${shift.toExponential(2)}`,
				shift < 1e-9 ? '→ 기존 점 고정 확인 ✅' : '→ 좌표가 움직였습니다 — basis 재사용 경로 확인 필요 ❌',
			];
			this.showPcaText(lines.join('\n'));
		} catch (error) {
			this.showPcaText(describePcaError(error));
		}
	}

	private showPcaText(text: string): void {
		this.pcaResultEl?.setText(text);
	}
}

// ─────────────────────────────────────────────────────────────
// PCA 결과 표시 (스펙 6절) — 실데이터에서도 계속 쓴다
// ─────────────────────────────────────────────────────────────

function describePcaResult(result: PCAResult, elapsedMs: number): string {
	const ex = result.excluded;
	const validCount = result.points.length;
	const excludedTotal = ex.malformed + ex.embeddingFailed + ex.modelMismatch + ex.invalidVector + ex.duplicateId;
	const m = result.metrics;
	const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
	const samples = result.points
		.slice(0, 3)
		.map((p) => `  ${p.sourceId}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)})`)
		.join('\n');
	return [
		`입력 ${validCount + excludedTotal}편 → 유효 ${validCount}편`,
		`제외: malformed ${ex.malformed} · embeddingFailed ${ex.embeddingFailed} · modelMismatch ${ex.modelMismatch} · invalidVector ${ex.invalidVector} · duplicateId ${ex.duplicateId}`,
		`기준 모델: ${result.usedModel} (${result.dimension}차원)`,
		`설명 분산: 1축 ${percent(m.explainedAxis1)} + 2축 ${percent(m.explainedAxis2)} = ${percent(m.explainedTotal)}`,
		`직교성: ${m.orthogonality.toExponential(2)} (0에 가까워야 정상)`,
		`결과 평균: x ${m.meanX.toExponential(2)} · y ${m.meanY.toExponential(2)}`,
		`수렴: ${m.converged ? '완료' : '상한 도달'} (${m.iterations}회 반복)`,
		`basis: ${result.didFit ? 'fit 수행' : '재사용'} (${result.fitReason})`,
		`좌표 앞 3건:\n${samples}`,
		`실행 시간: ${elapsedMs.toFixed(1)}ms`,
	].join('\n');
}

function describePcaError(error: unknown): string {
	if (error instanceof PCAError) {
		const ex = error.excluded;
		return [
			`PCA 에러: ${error.message}`,
			`입력 ${error.inputCount}편 → 유효 ${error.validCount}편 (기준 모델: ${error.usedModel || '없음'})`,
			`제외: malformed ${ex.malformed} · embeddingFailed ${ex.embeddingFailed} · modelMismatch ${ex.modelMismatch} · invalidVector ${ex.invalidVector} · duplicateId ${ex.duplicateId}`,
		].join('\n');
	}
	return `예상하지 못한 오류: ${String(error)}`;
}

// ─────────────────────────────────────────────────────────────
// ⚠️ 임시(삭제 예정) — 합성 데이터 생성과 검증 (스펙 7절)
// 임베딩이 실제 벡터를 만들면 이 블록 전체를 삭제한다.
// ─────────────────────────────────────────────────────────────

// 합성 논문 생성기. 시드가 고정돼 매 실행 같은 데이터가 나온다 (결과 비교가 가능해야 검증이 된다)
function makeSyntheticPapers(
	count: number,
	clusterCount: number,
	seedOffset: number,
	startIndex = 0,
): Paper[] {
	const DIMENSION = 768; // 합성 전용 값 — PCA 본체는 차원을 데이터에서 읽는다
	const random = mulberry32(20260804 + seedOffset * 7919);

	// 덩어리 중심: 시드 기반 무작위 방향 (차원이 높아 서로 거의 직교 = 충분히 멀다).
	// 덩어리마다 중심 크기를 다르게 둔다 — 크기가 같으면 1·2축 분산이 비등해져 수렴이 늦어진다
	const centers: Float64Array[] = [];
	for (let c = 0; c < clusterCount; c++) {
		const center = new Float64Array(DIMENSION);
		const scale = 1 + c * 0.8;
		for (let d = 0; d < DIMENSION; d++) {
			center[d] = gaussian(random) * scale;
		}
		centers.push(center);
	}

	const papers: Paper[] = [];
	for (let i = 0; i < count; i++) {
		const cluster = i % clusterCount;
		const center = centers[cluster]!;
		const embedding: number[] = new Array<number>(DIMENSION);
		for (let d = 0; d < DIMENSION; d++) {
			embedding[d] = center[d]! + gaussian(random) * 0.25;
		}

		const index = startIndex + i;
		const paper = new Paper();
		// sourceId는 자릿수를 고정한다 — 사전순 정렬에서 test-10이 test-2보다 앞서는 함정 방지 (스펙 7절)
		paper.sourceId = `syn-c${cluster}-${String(index).padStart(3, '0')}`;
		paper.title = `합성 논문 ${index}`;
		paper.authors = [];
		paper.abstract = '';
		paper.references = [];
		paper.publicationDate = `202${index % 5}-0${(index % 9) + 1}-15`;
		paper.citationCount = 0;
		paper.citationsKnown = false;
		paper.collectedApi = 'synthetic';
		paper.collectedQuery = { searchType: 'keyword', query: 'synthetic' };
		paper.embedding = embedding;
		paper.embeddingModel = 'synthetic-test';
		paper.embeddingSource = 'synthetic';
		paper.embeddingSucceeded = true;
		papers.push(paper);
	}
	return papers;
}

// 덩어리 분리 확인: sourceId에 심어둔 정답 라벨(syn-c0-…)로 안/밖 거리를 비교한다
function describeClusterSeparation(result: PCAResult): string {
	// 덩어리별 중심 좌표
	const sums = new Map<string, { x: number; y: number; count: number }>();
	for (const point of result.points) {
		const label = point.sourceId.split('-')[1] ?? '?';
		const entry = sums.get(label) ?? { x: 0, y: 0, count: 0 };
		entry.x += point.x;
		entry.y += point.y;
		entry.count++;
		sums.set(label, entry);
	}
	const centroids = new Map<string, { x: number; y: number }>();
	for (const [label, entry] of sums) {
		centroids.set(label, { x: entry.x / entry.count, y: entry.y / entry.count });
	}

	// 안: 각 점에서 자기 덩어리 중심까지의 평균 거리
	let intraSum = 0;
	for (const point of result.points) {
		const label = point.sourceId.split('-')[1] ?? '?';
		const centroid = centroids.get(label);
		if (centroid) {
			intraSum += Math.hypot(point.x - centroid.x, point.y - centroid.y);
		}
	}
	const intra = intraSum / result.points.length;

	// 밖: 덩어리 중심끼리의 최소 거리
	const centroidList = [...centroids.values()];
	let inter = Infinity;
	for (let i = 0; i < centroidList.length; i++) {
		for (let j = i + 1; j < centroidList.length; j++) {
			const a = centroidList[i]!;
			const b = centroidList[j]!;
			inter = Math.min(inter, Math.hypot(a.x - b.x, a.y - b.y));
		}
	}

	const ratio = inter / intra;
	return [
		`덩어리 검증: 중심 간 최소 거리 ${inter.toFixed(3)} ÷ 덩어리 안 평균 거리 ${intra.toFixed(3)} = ${ratio.toFixed(1)}배`,
		ratio >= 2 ? '→ 덩어리 분리 확인 ✅' : '→ 분리가 약합니다 — 계산 확인 필요 ❌',
	].join('\n');
}

// 재사용 검증: 두 결과에서 같은 sourceId의 좌표가 얼마나 움직였는지 (최댓값)
function maxCoordinateShift(before: PCAResult, after: PCAResult): number {
	const beforeMap = new Map(before.points.map((p) => [p.sourceId, p]));
	let maxShift = 0;
	for (const point of after.points) {
		const old = beforeMap.get(point.sourceId);
		if (old) {
			maxShift = Math.max(maxShift, Math.abs(point.x - old.x), Math.abs(point.y - old.y));
		}
	}
	return maxShift;
}

// 시드 고정 난수 (mulberry32) — Math.random은 시드를 줄 수 없어 검증에 부적합하다
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// 표준정규분포 난수 (Box-Muller)
function gaussian(random: () => number): number {
	const u = Math.max(random(), 1e-12); // log(0) 방지
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
