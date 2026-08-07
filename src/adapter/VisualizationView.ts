import { ItemView, WorkspaceLeaf, Notice, ButtonComponent } from 'obsidian';
import type PaperGraph3D from '../main';
import { PCAError, type PCAResult } from '../visualize/PCA';
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
	// 임베딩(Embedding)이 dev에 머지되면 실제 벡터로 확인하는 버튼을 여기에 붙이고,
	// 수집 파이프라인이 완성되면 이 블록 전체를 삭제한다.
	// 지표 표시(describePcaResult)는 실데이터에서도 계속 쓴다.
	// ─────────────────────────────────────────────────────────────

	private pcaResultEl: HTMLElement | null = null;

	private renderPcaSection(contentEl: HTMLElement): void {
		contentEl.createEl('p', {
			text: 'PCA를 실행하고 검증 지표를 확인합니다. 합성 데이터 관련 항목은 임시입니다.',
		});
		new ButtonComponent(contentEl).setButtonText('덩어리 검증 (3덩어리)').onClick(() => {
			this.runPcaClusterCheck();
		});
		new ButtonComponent(contentEl).setButtonText('재사용 검증 (basis)').onClick(() => {
			this.runPcaReuseCheck();
		});
		// 임베딩(003)이 dev에 머지되면 아래 두 줄과 runPcaWithRealEmbedding()·makeRealisticPapers()의
		// 주석을 풀면 된다. 지금 dev의 Embedding에는 embed()가 없어 컴파일되지 않으므로 막아둔다.
		// new ButtonComponent(contentEl).setButtonText('실제 임베딩으로 실행 (21편)').onClick(() => {
		// 	void this.runPcaWithRealEmbedding();
		// });
		// 긴 줄이 잘리지 않도록 줄바꿈 — 스타일은 styles.css의 클래스로 둔다 (인라인 스타일은 린트가 막는다)
		this.pcaResultEl = contentEl.createEl('pre', {
			text: '아직 실행하지 않았습니다.',
			cls: 'papergraph3d-pca-result',
		});
	}

	// 덩어리 검증: 정답(3덩어리)을 아는 입력을 넣고 결과도 3덩어리로 갈라지는지 수치로 확인 (스펙 7절)
	private runPcaClusterCheck(): void {
		const papers = makeSyntheticPapers(60, 3, 2);
		// 다른 코퍼스다 — 이전 축을 물려받으면 "PCA가 덩어리를 가르는가"를 확인하는 게 아니게 된다
		this.plugin.visualflow.pca.resetBasis();
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

	// 재사용 검증: 같은 코퍼스로 fit한 뒤 논문을 20% 미만으로 추가해 다시 돌려,
	// 기존 좌표가 그대로인지 확인한다 (스펙 9절). 축은 PCA가 내부 캐시로 들고 있으므로
	// 넘길 것이 없다. 앞서 어떤 버튼을 눌렀든 결과가 같도록 기준을 여기서 직접 만든다.
	private runPcaReuseCheck(): void {
		const pca = this.plugin.visualflow.pca;
		const base = makeSyntheticPapers(60, 3, 1);
		// 5편 추가 = 60편 대비 8.3% 증가 → 재사용 경로를 탄다 (20% 이상이면 refit이 정상)
		const extra = makeSyntheticPapers(5, 3, 3, base.length);
		try {
			pca.resetBasis();
			const before = pca.run(base);
			const started = performance.now();
			const after = pca.run([...base, ...extra]);
			const elapsed = performance.now() - started;
			const shift = maxCoordinateShift(before, after);
			const lines = [
				describePcaResult(after, elapsed),
				'',
				`재사용 검증: 논문 ${extra.length}편 추가 후 기존 좌표 최대 이동 = ${shift.toExponential(2)}`,
				shift < 1e-9 ? '→ 기존 점 고정 확인 ✅' : '→ 좌표가 움직였습니다 — 재사용 경로 확인 필요 ❌',
			];
			this.showPcaText(lines.join('\n'));
		} catch (error) {
			this.showPcaText(describePcaError(error));
		}
	}

	// ── 003 머지 후 주석 해제 ──────────────────────────────────────
	// 실제 임베딩으로 PCA를 돌려 전 구간이 이어지는지 확인하는 버튼이다.
	// dev의 Embedding에는 아직 embed()가 없어 컴파일되지 않으므로 주석으로 둔다.
	// // 실제 임베딩 연결 확인: 제목·초록을 Embedding.embed()에 통과시킨 뒤 그 벡터로 PCA를 돌린다.
	// // 모델이 설치돼 있으면 768차원 SPECTER2 벡터가 나오고, 없거나 실패하면 embed()가 throw한다 —
	// // 그 논문은 빈 값 + embeddingSucceeded=false로 남아 PCA가 걸러낸다 (스펙 8절 4번).
	// private async runPcaWithRealEmbedding(): Promise<void> {
	// const embedding = this.plugin.collectflow.embedding;
	// const papers = makeRealisticPapers(21, 3);
	// // 합성 데이터와는 다른 코퍼스이므로 이전 축을 버린다
	// this.plugin.visualflow.pca.resetBasis();
	//
	// let installed = false;
	// try {
	// installed = await embedding.isModelInstalled();
	// } catch {
	// // 확인이 실패해도 계속 진행한다 — 어차피 embed()가 논문마다 성공/실패를 알려준다
	// }
	// this.showPcaText(
	// `임베딩 모델: ${installed ? '설치됨' : '미설치 — 임베딩이 전부 실패해 PCA에서 제외됩니다'}\n임베딩 중...`,
	// );
	//
	// const embedStarted = performance.now();
	// let embedFailed = 0;
	// for (let i = 0; i < papers.length; i++) {
	// const paper = papers[i]!;
	// // embed()는 실패하면 throw한다 (003, 2026-08-06 계약 변경 — 이전에는 폴백 벡터를 돌려줬다).
	// // 한 편이 실패해도 나머지는 계속 임베딩하고, 실패한 논문은 빈 값 + embeddingSucceeded=false로
	// // 남겨 PCA가 걸러내게 한다. 순차 호출만 안전하므로 병렬로 돌리지 않는다.
	// try {
	// Object.assign(paper, await embedding.embed(paper.title, paper.abstract));
	// } catch {
	// embedFailed++;
	// paper.embedding = [];
	// paper.embeddingModel = '';
	// paper.embeddingSource = '';
	// paper.embeddingSucceeded = false;
	// }
	// this.showPcaText(`임베딩 중... ${i + 1}/${papers.length}편`);
	// }
	// const embedMs = performance.now() - embedStarted;
	//
	// const header = [
	// `임베딩 모델: ${installed ? '설치됨' : '미설치'}${embedFailed > 0 ? ` — ${embedFailed}편 실패` : ''}`,
	// `임베딩 소요: ${(embedMs / 1000).toFixed(1)}초 (${papers.length}편, 편당 ${(embedMs / papers.length).toFixed(0)}ms)`,
	// '',
	// ].join('\n');
	//
	// const pcaStarted = performance.now();
	// try {
	// const result = this.plugin.visualflow.pca.run(papers);
	// const elapsed = performance.now() - pcaStarted;
	// const separation = describeClusterSeparation(result);
	// this.showPcaText(header + describePcaResult(result, elapsed) + '\n\n' + separation);
	// } catch (error) {
	// this.showPcaText(header + describePcaError(error));
	// }
	// }
	// ────────────────────────────────────────────────────────────

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
	// 평균은 fit 실행에서만 0에 가까워야 한다. 재사용 실행은 fit 당시의 평균으로 중심을 잡으므로,
	// 그 뒤 논문이 늘거나 줄면 0에서 벗어나는 것이 정상이다 (스펙 5절). 안내를 안 붙이면 버그로 오해받는다
	const meanNote = result.didFit
		? '(0에 가까워야 정상)'
		: '(재사용 실행이라 0에서 벗어나는 것이 정상 — 데이터가 fit 시점에서 이동한 정도)';
	return [
		`입력 ${validCount + excludedTotal}편 → 유효 ${validCount}편`,
		`제외: malformed ${ex.malformed} · embeddingFailed ${ex.embeddingFailed} · modelMismatch ${ex.modelMismatch} · invalidVector ${ex.invalidVector} · duplicateId ${ex.duplicateId}`,
		`기준 모델: ${result.usedModel} (${result.dimension}차원)`,
		`설명 분산: 1축 ${percent(m.explainedAxis1)} + 2축 ${percent(m.explainedAxis2)} = ${percent(m.explainedTotal)}`,
		`직교성: ${m.orthogonality.toExponential(2)} (0에 가까워야 정상)`,
		`결과 평균: x ${m.meanX.toExponential(2)} · y ${m.meanY.toExponential(2)} ${meanNote}`,
		`수렴: ${describeConvergence(m.converged, m.iterations, result.didFit)}`,
		...(result.didFit ? [] : [`축 낡음: 설명 분산이 fit 당시보다 ${(m.explainedDrop * 100).toFixed(1)}% 떨어짐`]),
		`basis: ${result.didFit ? `fit 수행 (${result.fitReason})` : '재사용 — 기존 좌표 고정'}`,
		describeReembedding(result.needsReembedding),
		`좌표 앞 3건:\n${samples}`,
		`실행 시간: ${elapsedMs.toFixed(1)}ms`,
	].join('\n');
}

// 재사용 실행은 멱반복을 돌지 않으므로 "0회 반복"이 정상이다 — 그대로 보여주면 수렴 실패로 읽힌다
function describeConvergence(converged: boolean, iterations: number, didFit: boolean): string {
	if (!didFit) {
		return '해당 없음 (재사용이라 반복 계산을 하지 않음)';
	}
	return converged ? `완료 (${iterations}회 반복)` : `상한 도달 (${iterations}회) — 축이 덜 안정적일 수 있음`;
}

// 재임베딩하면 살아날 논문 수를 알린다. PCA는 걸러내기만 하므로, 이 논문들은
// 임베딩을 다시 하지 않는 한 계속 그래프 밖에 남는다.
function describeReembedding(sourceIds: string[]): string {
	if (sourceIds.length === 0) {
		return '재임베딩 필요: 없음';
	}
	const sample = sourceIds.slice(0, 3).join(', ');
	const more = sourceIds.length > 3 ? ` 외 ${sourceIds.length - 3}편` : '';
	return `재임베딩 필요: ${sourceIds.length}편 (${sample}${more}) — 다시 임베딩해야 그래프에 들어옵니다`;
}

function describePcaError(error: unknown): string {
	if (error instanceof PCAError) {
		const ex = error.excluded;
		const lines = [
			`PCA 에러: ${error.message}`,
			`입력 ${error.inputCount}편 → 유효 ${error.validCount}편 (기준 모델: ${error.usedModel || '없음'})`,
			`제외: malformed ${ex.malformed} · embeddingFailed ${ex.embeddingFailed} · modelMismatch ${ex.modelMismatch} · invalidVector ${ex.invalidVector} · duplicateId ${ex.duplicateId}`,
			describeReembedding(error.needsReembedding),
		];
		// 임베딩이 실패한 논문이 제외의 대부분이면 원인은 대개 "모델 미설치"다.
		// Embedding.embed()는 모델이 없을 때 throw 대신 폴백 벡터(embeddingSucceeded=false)를
		// 돌려주므로, 그 상태로 수집하면 모든 논문이 여기서 걸러진다. 숫자만 보면 원인을 알 수 없어 안내한다.
		if (ex.embeddingFailed > 0 && ex.embeddingFailed >= error.inputCount / 2) {
			lines.push(
				'',
				'대부분이 임베딩 실패로 제외됐습니다. 설정 탭에서 임베딩 모델이 설치돼 있는지 확인해 주세요 — ' +
					'모델이 없으면 논문이 임시 임베딩으로 저장되고, 그 벡터는 그래프에 쓸 수 없습니다.',
			);
		}
		return lines.join('\n');
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
		paper.collectedApis = ['synthetic'];
		paper.collectedQueries = [{ searchType: 'keyword', query: 'synthetic' }];
		paper.embedding = embedding;
		paper.embeddingModel = 'synthetic-test';
		paper.embeddingSource = 'synthetic';
		paper.embeddingSucceeded = true;
		papers.push(paper);
	}
	return papers;
}

// // 실제 임베딩 테스트용 논문. 벡터 대신 제목·초록을 만들고, 임베딩 필드는 비워 둔다
// // (Embedding.embed()의 결과로 채워진다). 주제가 뚜렷이 다른 세 덩어리로 구성해
// // 실제 모델이 내용 차이를 좌표로 반영하는지 확인할 수 있게 한다.
// function makeRealisticPapers(count: number, clusterCount: number): Paper[] {
// 	// 주제별 어휘 — 서로 겹치지 않게 골라야 덩어리 분리를 확인할 수 있다
// 	const topics = [
// 		{
// 			name: '언어모델',
// 			titles: [
// 				'Attention-based Transformers for Multilingual Text Generation',
// 				'Scaling Laws in Large Language Model Pretraining',
// 				'Instruction Tuning Improves Zero-shot Reasoning in Language Models',
// 				'Efficient Tokenization Strategies for Neural Machine Translation',
// 				'Retrieval-Augmented Generation for Open-domain Question Answering',
// 				'Sparse Attention Reduces Inference Cost in Long-context Transformers',
// 				'Cross-lingual Transfer in Multilingual Sentence Encoders',
// 			],
// 			abstract:
// 				'We study transformer language models trained on large text corpora. Our approach improves perplexity and downstream accuracy on natural language understanding benchmarks, including question answering and summarization. We analyze attention patterns, tokenization, and the effect of instruction tuning on zero-shot generalization.',
// 		},
// 		{
// 			name: '컴퓨터비전',
// 			titles: [
// 				'Convolutional Architectures for Fine-grained Image Classification',
// 				'Self-supervised Pretraining for Semantic Segmentation of Satellite Imagery',
// 				'Diffusion Models for High-resolution Image Synthesis',
// 				'Robust Object Detection under Adverse Weather Conditions',
// 				'Vision Transformers with Hierarchical Feature Pyramids',
// 				'Depth Estimation from Monocular Video Sequences',
// 				'Neural Radiance Fields for Novel View Synthesis of Indoor Scenes',
// 			],
// 			abstract:
// 				'We present a computer vision method for recognizing objects in images and video. The model uses convolutional and vision transformer backbones trained with self-supervised objectives on large image datasets. Experiments on segmentation, detection, and depth estimation benchmarks show improved pixel accuracy and mean intersection over union.',
// 		},
// 		{
// 			name: '강화학습',
// 			titles: [
// 				'Off-policy Reinforcement Learning for Robotic Manipulation',
// 				'Sample-efficient Exploration in Sparse-reward Environments',
// 				'Model-based Planning with Learned World Dynamics',
// 				'Multi-agent Reinforcement Learning for Cooperative Navigation',
// 				'Offline Reinforcement Learning from Suboptimal Demonstrations',
// 				'Reward Shaping Accelerates Policy Convergence in Continuous Control',
// 				'Sim-to-real Transfer of Locomotion Policies for Legged Robots',
// 			],
// 			abstract:
// 				'We propose a reinforcement learning algorithm for continuous control and robotic manipulation. The agent learns a policy through interaction with the environment, using reward signals and a learned dynamics model for planning. We evaluate sample efficiency, exploration behavior, and sim-to-real transfer on locomotion and manipulation tasks.',
// 		},
// 	];
//
// 	const papers: Paper[] = [];
// 	for (let i = 0; i < count; i++) {
// 		const cluster = i % clusterCount;
// 		const topic = topics[cluster % topics.length]!;
// 		const titleIndex = Math.floor(i / clusterCount) % topic.titles.length;
//
// 		const paper = new Paper();
// 		// describeClusterSeparation이 라벨을 sourceId의 두 번째 조각에서 읽으므로 형식을 맞춘다
// 		paper.sourceId = `real-c${cluster}-${String(i).padStart(3, '0')}`;
// 		paper.title = topic.titles[titleIndex] ?? topic.titles[0]!;
// 		paper.abstract = topic.abstract;
// 		paper.authors = [];
// 		paper.references = [];
// 		paper.publicationDate = `2025-0${(i % 9) + 1}-15`;
// 		paper.citationCount = 0;
// 		paper.citationsKnown = false;
// 		paper.collectedApi = 'synthetic';
// 		paper.collectedQuery = { searchType: 'keyword', query: topic.name };
// 		// 임베딩 필드는 Embedding.embed()의 결과로 덮어쓴다
// 		paper.embedding = [];
// 		paper.embeddingModel = '';
// 		paper.embeddingSource = '';
// 		paper.embeddingSucceeded = false;
// 		papers.push(paper);
// 	}
// 	return papers;
// }

// 덩어리 분리 확인: sourceId에 심어둔 정답 라벨(syn-c0-… / real-c0-…)로 안/밖 거리를 비교한다
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
