import { ExtraData, Paper } from '../collect/Paper';

// 클러스터링 한 번의 결과 요약. 논문별 번호는 paper.extra.clusterId에 들어간다
// (미들웨어가 만든 값은 extra에 모은다 — Paper.ts의 ExtraData 참고).
export interface ClusterResult {
	clusterCount: number; // 나눈 덩어리 수 (자동으로 정한 k)
	clustered: number; // 어느 덩어리엔가 속한 논문 수
	ambiguous: number; // 덩어리 사이에 껴서 판정을 보류한 논문 수(= 색을 칠하지 않는다)
	skipped: number; // 임베딩이 없어 계산에서 빠진 논문 수
}

// 논문 임베딩을 주제별로 묶는다.
//
// 입력은 PCA 결과(화면 좌표)가 아니라 임베딩 원본이다. 실제 볼트(6017편, arXiv 분야 5개)로
// 재보니 "이웃 20편 중 같은 분야" 비율이 임베딩 0.904 / PCA 2차원 0.785였다 — 2차원으로
// 줄이면 화면에서 붙어 보여도 실제로는 다른 분야인 논문이 섞인다. 50차원이나 10차원으로
// 줄여도 품질은 같았지만(0.905/0.906) 줄이는 계산만 6초가 넘어, 원본을 그대로 쓰는 쪽이
// 더 빠르고 단순하다.
//
// 밀도 기준(DBSCAN)을 쓰지 않는다. 처음엔 "덩어리 수를 모르니 밀도로 찾자"가 맞아 보였지만
// 실제 볼트에서 전혀 나뉘지 않았다 — eps를 0.30까지 낮춰가며 재보니 큰 덩어리 하나(6017편
// 중 5975편)이거나 전부 부스러기(99%가 미분류)일 뿐, 중간이 없었다. 논문 주제가 연속적으로
// 이어져 있어(cs.CV와 cs.CL이 겹친다) 덩어리 사이에 밀도가 낮은 골짜기가 없기 때문이다.
// 대신 k-means로 나누되, k를 데이터에서 정하고 경계에 낀 논문은 판정을 보류한다.
export class Clustering {
	// 이보다 적으면 나눌 의미가 없다(PCA의 MIN_VALID_PAPERS와 같은 취지).
	private static readonly MIN_PAPERS = 15;

	// 시도해 볼 덩어리 수의 시작점.
	private static readonly MIN_K = 2;

	// k를 어디까지 늘려볼지는 고정하지 않는다. 구독 수에 제한이 없어(Subscriptions.apis는
	// 그냥 배열) 주제를 몇 개까지 모을지 알 수 없으므로, 상한을 손으로 정하면 그 숫자가 곧
	// 근거 없는 천장이 된다.
	//
	// 대신 최고 점수를 이만큼 연속으로 못 깨면 거기서 멈춘다. 덩어리가 적은 데이터는 일찍
	// 끝나고, 많은 데이터는 알아서 더 간다 — 실측: 실제 볼트는 9개만 시도하고 k=4에서 멈췄고
	// (0.50초), 진짜 28덩어리인 합성 데이터에서는 32개까지 가서 k=27을 찾았다(1.70초).
	//
	// 6인 이유: 점수 곡선이 매끄럽지 않아 중간에 몇 번 내려갔다 올라온다(실제 볼트에서
	// k=4 다음 5·6·7이 내려갔다가 8에서 다시 올랐다). 너무 짧으면 그 골짜기에서 멈춰버린다.
	private static readonly PATIENCE = 6;

	// 그래도 끝은 있어야 한다. 표본 한 덩어리에 이 정도는 들어가야 "덩어리"라고 볼 수 있으므로,
	// 표본 크기를 이 값으로 나눈 만큼까지만 늘린다(표본 600 기준 30). 색이 10가지뿐이라
	// 그보다 많아지면 색이 돌아 쓰여 화면에서 구분되지도 않는다.
	private static readonly MIN_SAMPLES_PER_CLUSTER = 20;

	// k를 고를 때 쓰는 표본 크기. k마다 전체를 돌리면 열 배 가까이 느려지는데, 몇 덩어리가
	// 자연스러운지는 분포만 보면 알 수 있어 표본으로 충분하다.
	//
	// 표본을 줄여도 답은 잘 버틴다 — 실제 볼트에서 1200이든 600이든 k=4를 고르고, 1위와 2위
	// 점수의 격차도 0.0146 / 0.0104로 둘 다 넉넉했다. 반면 아래 반복 상한을 줄이면 격차가
	// 0.0005까지 좁아져 사실상 아무 k나 골라진다. 그래서 아껴야 할 때는 반복이 아니라 표본을
	// 줄인다.
	private static readonly SAMPLE_SIZE = 600;

	// k-means 반복 상한. 실제 볼트에서 전체는 17회, 표본은 k에 따라 12~31회에 스스로 멈추므로
	// 여유를 둔 안전장치다. 중간에 끊으면 안 된다 — 덜 수렴한 결과로 매긴 점수는 k끼리
	// 구분이 안 될 만큼 뭉개진다(SAMPLE_SIZE 주석 참고).
	private static readonly MAX_ITERATIONS = 60;

	// 판정을 보류하는 기준. 자기 덩어리 중심까지의 거리가 두 번째로 가까운 중심까지의
	// 거리와 이 비율 안쪽이면 "사이에 낀 논문"으로 보고 번호를 주지 않는다.
	//
	// 실제 볼트에서 잰 값 (분야 정답과 얼마나 맞는지):
	//   0.00 → 보류 0%,  순도 89.5%
	//   0.05 → 보류 12%, 순도 94% 부근
	//   0.10 → 보류 26%, 순도 97.1%
	// 보류를 늘릴수록 남은 논문은 정확해지지만 화면에서 색이 빠진다. 0.05는 "경계가 정말
	// 애매한 논문만" 빼는 지점이다.
	private static readonly MIN_MARGIN = 0.05;

	// 계산 결과를 세션 동안 들고 있는다. 버튼을 껐다 켤 때마다 다시 계산하지 않기 위해서다.
	// 요약이 아니라 sourceId별 번호를 들고 있어야 한다 — 논문 객체는 시각화를 열 때마다
	// 파일에서 새로 읽히므로(readAllPapers) 지난번에 채운 extra가 남아 있지 않다.
	private cachedKey = '';
	private cachedLabels = new Map<string, number>();
	private cachedResult: ClusterResult | undefined;

	// 캐시를 버린다. 논문을 다시 수집했거나 임베딩 모델이 바뀌었을 때 호출자가 부른다.
	reset(): void {
		this.cachedKey = '';
		this.cachedLabels = new Map();
		this.cachedResult = undefined;
	}

	// 논문들을 묶고 각 논문의 extra.clusterId를 채운다. 보류된 논문과 임베딩이 없는 논문은
	// 값을 비운다 — 지난 계산의 번호가 남아 엉뚱한 색으로 그려지지 않게 한다.
	run(papers: Paper[]): ClusterResult {
		const valid = Clustering.selectValid(papers);
		const key = Clustering.cacheKey(valid);
		if (key === this.cachedKey && this.cachedResult) {
			Clustering.applyLabels(papers, this.cachedLabels);
			return this.cachedResult;
		}

		const labels = new Map<string, number>();
		let clusterCount = 0;
		if (valid.length >= Clustering.MIN_PAPERS) {
			const dim = valid[0]?.embedding.length ?? 0;
			const vectors = Clustering.pack(valid, dim);
			const k = Clustering.chooseK(vectors, valid.length, dim);
			const centroids = Clustering.kmeans(vectors, valid.length, dim, k, Clustering.MAX_ITERATIONS);
			clusterCount = Clustering.assign(vectors, valid, dim, k, centroids, labels);
		}

		const result: ClusterResult = {
			clusterCount,
			clustered: labels.size,
			ambiguous: valid.length - labels.size,
			skipped: papers.length - valid.length,
		};
		this.cachedKey = key;
		this.cachedLabels = labels;
		this.cachedResult = result;
		Clustering.applyLabels(papers, labels);
		return result;
	}

	// ── 준비 ───────────────────────────────────────────────────────

	// 임베딩이 성공했고 첫 논문과 차원이 같은 논문만 쓴다. sourceId로 정렬해 순서를 못
	// 박는다 — 파일을 읽어온 순서가 달라도 같은 결과가 나와야 색이 흔들리지 않는다.
	private static selectValid(papers: Paper[]): Paper[] {
		const usable = papers.filter((paper) => paper.embeddingSucceeded && paper.embedding.length > 0);
		usable.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
		const dim = usable[0]?.embedding.length ?? 0;
		return usable.filter((paper) => paper.embedding.length === dim);
	}

	// 캐시를 그대로 쓸 수 있는지 판단하는 열쇠. 정렬돼 있으므로 논문이 추가·삭제되면
	// 편수와 양 끝 sourceId 중 하나는 반드시 달라진다.
	private static cacheKey(valid: Paper[]): string {
		return `${valid.length}|${valid[0]?.sourceId ?? ''}|${valid[valid.length - 1]?.sourceId ?? ''}`;
	}

	// 계산 결과를 논문에 싣는다. 목록에 없는 논문은 비워, 지난번엔 묶였다가 이번엔 빠진
	// 논문에 옛 번호가 남지 않게 한다.
	private static applyLabels(papers: Paper[], labels: Map<string, number>): void {
		for (const paper of papers) {
			paper.extra ??= new ExtraData();
			paper.extra.clusterId = labels.get(paper.sourceId);
		}
	}

	// 벡터를 하나의 연속 배열에 담는다. 거리 계산이 전체 비용의 대부분이라 배열의 배열보다
	// 이쪽이 캐시 적중률에서 유리하다.
	private static pack(papers: Paper[], dim: number): Float64Array {
		const packed = new Float64Array(papers.length * dim);
		for (let i = 0; i < papers.length; i += 1) {
			packed.set(papers[i]?.embedding ?? [], i * dim);
		}
		return packed;
	}

	// ── k 자동 결정 ────────────────────────────────────────────────

	// 몇 덩어리로 나누는 것이 자연스러운지 데이터에서 정한다.
	//
	// k를 2부터 늘려가며 표본을 나눠 보고, "자기 중심에는 가깝고 다른 중심에서는 먼" 정도가
	// 가장 좋은 k를 고른다(실루엣 점수의 중심점 판). 논문끼리 전부 비교하는 원래 실루엣은
	// 편수의 제곱이라 못 쓰지만, 중심점만 보면 편수에 비례해 끝난다.
	//
	// 최고 기록이 PATIENCE번 연속 안 깨지면 거기서 멈춘다 — 더 늘려봐야 나아지지 않는다는
	// 뜻이고, k가 커질수록 한 번 나눠보는 비용도 k에 비례해 커지기 때문이다.
	private static chooseK(vectors: Float64Array, count: number, dim: number): number {
		const sample = Clustering.sampleRows(vectors, count, dim);
		const rows = sample.length / dim;
		const limit = Math.min(Math.floor(rows / Clustering.MIN_SAMPLES_PER_CLUSTER), rows - 1);

		let bestK = Clustering.MIN_K;
		let bestScore = -Infinity;
		let missed = 0;
		for (let k = Clustering.MIN_K; k <= limit; k += 1) {
			const centroids = Clustering.kmeans(sample, rows, dim, k, Clustering.MAX_ITERATIONS);
			const score = Clustering.separation(sample, rows, dim, k, centroids);
			if (score > bestScore) {
				bestScore = score;
				bestK = k;
				missed = 0;
			} else {
				missed += 1;
				if (missed >= Clustering.PATIENCE) {
					break;
				}
			}
		}
		return bestK;
	}

	// 표본을 고르게 뽑는다(정렬된 순서에서 일정 간격) — 무작위가 아니라 결정적이어야 한다.
	private static sampleRows(vectors: Float64Array, count: number, dim: number): Float64Array {
		if (count <= Clustering.SAMPLE_SIZE) {
			return vectors;
		}
		const step = count / Clustering.SAMPLE_SIZE;
		const sample = new Float64Array(Clustering.SAMPLE_SIZE * dim);
		for (let i = 0; i < Clustering.SAMPLE_SIZE; i += 1) {
			const source = Math.floor(i * step) * dim;
			sample.set(vectors.subarray(source, source + dim), i * dim);
		}
		return sample;
	}

	// 나눔이 얼마나 잘 됐는지 한 숫자로. 논문마다 (두 번째로 가까운 중심까지 − 자기 중심까지)
	// 를 더 먼 쪽으로 나눈 값의 평균이다. 1에 가까울수록 덩어리가 뚜렷하다.
	private static separation(
		vectors: Float64Array,
		count: number,
		dim: number,
		k: number,
		centroids: Float64Array,
	): number {
		let total = 0;
		for (let i = 0; i < count; i += 1) {
			const { own, other } = Clustering.twoNearest(vectors, i, dim, k, centroids);
			const worst = Math.max(own, other);
			total += worst > 0 ? (other - own) / worst : 0;
		}
		return total / count;
	}

	// ── k-means ────────────────────────────────────────────────────

	// 중심점 k개를 찾는다. 시작점을 무작위로 잡지 않고 정렬된 논문에서 일정 간격으로 고르므로,
	// 같은 논문 묶음이면 언제 돌려도 같은 결과가 나온다(색이 매번 바뀌지 않는다).
	private static kmeans(
		vectors: Float64Array,
		count: number,
		dim: number,
		k: number,
		maxIterations: number,
	): Float64Array {
		const centroids = new Float64Array(k * dim);
		for (let c = 0; c < k; c += 1) {
			const source = Math.floor((c * count) / k) * dim;
			centroids.set(vectors.subarray(source, source + dim), c * dim);
		}

		const assignment = new Int32Array(count).fill(-1);
		const sums = new Float64Array(k * dim);
		const counts = new Int32Array(k);
		for (let iteration = 0; iteration < maxIterations; iteration += 1) {
			let moved = 0;
			for (let i = 0; i < count; i += 1) {
				const { cluster } = Clustering.twoNearest(vectors, i, dim, k, centroids);
				if (assignment[i] !== cluster) {
					assignment[i] = cluster;
					moved += 1;
				}
			}
			if (moved === 0) {
				break; // 아무도 옮겨가지 않으면 끝난 것이다
			}
			sums.fill(0);
			counts.fill(0);
			for (let i = 0; i < count; i += 1) {
				const c = assignment[i] as number;
				counts[c] = (counts[c] as number) + 1;
				const from = i * dim;
				const to = c * dim;
				for (let d = 0; d < dim; d += 1) {
					sums[to + d] = (sums[to + d] as number) + (vectors[from + d] as number);
				}
			}
			for (let c = 0; c < k; c += 1) {
				// 아무도 안 속한 중심은 그 자리에 둔다 — 0으로 밀면 엉뚱한 곳으로 튄다.
				const size = counts[c] as number;
				if (size === 0) {
					continue;
				}
				for (let d = 0; d < dim; d += 1) {
					centroids[c * dim + d] = (sums[c * dim + d] as number) / size;
				}
			}
		}
		return centroids;
	}

	// 논문 i에서 자기 중심까지(own)와 두 번째로 가까운 중심까지(other)의 거리. 어느 덩어리로
	// 보낼지, 경계에 낀 논문인지, 나눔이 얼마나 좋은지가 모두 이 두 값에서 나오므로 한 번에
	// 구한다.
	//
	// 비교는 제곱거리로 하고 제곱근은 마지막에 두 번만 뽑는다 — 제곱근은 크기 순서를 바꾸지
	// 않으므로 루프 안에서 중심마다 뽑을 이유가 없다.
	private static twoNearest(
		vectors: Float64Array,
		i: number,
		dim: number,
		k: number,
		centroids: Float64Array,
	): { cluster: number; own: number; other: number } {
		const from = i * dim;
		let cluster = 0;
		let own = Infinity;
		let other = Infinity;
		for (let c = 0; c < k; c += 1) {
			const to = c * dim;
			let sum = 0;
			for (let d = 0; d < dim; d += 1) {
				const diff = (vectors[from + d] as number) - (centroids[to + d] as number);
				sum += diff * diff;
			}
			if (sum < own) {
				other = own;
				own = sum;
				cluster = c;
			} else if (sum < other) {
				other = sum;
			}
		}
		return { cluster, own: Math.sqrt(own), other: Math.sqrt(other) };
	}

	// ── 번호 매기기 ────────────────────────────────────────────────

	// 논문마다 덩어리를 정하되, 경계에 낀 논문은 빼고 labels에 담는다. 그 뒤 번호를 크기순
	// (큰 덩어리가 0)으로 다시 매긴다 — 논문이 조금 늘거나 줄어도 큰 덩어리의 번호가 그대로라
	// 색이 튀지 않는다. 반환값은 실제로 쓰인 덩어리 수.
	private static assign(
		vectors: Float64Array,
		valid: Paper[],
		dim: number,
		k: number,
		centroids: Float64Array,
		labels: Map<string, number>,
	): number {
		const sizes = new Map<number, number>();
		const raw: (number | undefined)[] = [];
		for (let i = 0; i < valid.length; i += 1) {
			const { cluster, own, other } = Clustering.twoNearest(vectors, i, dim, k, centroids);
			// 자기 중심이 두 번째 중심보다 확실히 가깝지 않으면 판정을 보류한다.
			if (other <= 0 || (other - own) / other < Clustering.MIN_MARGIN) {
				raw.push(undefined);
				continue;
			}
			raw.push(cluster);
			sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
		}

		const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
		const renamed = new Map(ordered.map(([cluster], index) => [cluster, index]));
		for (let i = 0; i < valid.length; i += 1) {
			const cluster = raw[i];
			if (cluster !== undefined) {
				labels.set((valid[i] as Paper).sourceId, renamed.get(cluster) ?? cluster);
			}
		}
		return ordered.length;
	}
}
