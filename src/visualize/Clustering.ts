import { ExtraData, Paper } from '../collect/Paper';

// 클러스터링 한 번의 결과 요약. 논문별 번호는 paper.extra.clusterId에 들어간다
// (미들웨어가 만든 값은 extra에 모은다 — Paper.ts의 ExtraData 참고).
export interface ClusterResult {
	clusterCount: number; // 실제로 나눈 덩어리 수
	requestedCount: number; // 요청받은 수 (0이면 구독 개수에서 자동). clusterCount와 다르면 잘린 것
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

	// 그래도 끝은 있어야 한다. 표본 한 덩어리에 이 정도는 들어가야 "덩어리"라고 볼 수 있으므로,
	// 표본 크기를 이 값으로 나눈 만큼까지만 늘린다(표본 600 기준 30). 색이 10가지뿐이라
	// 그보다 많아지면 색이 돌아 쓰여 화면에서 구분되지도 않는다.
	private static readonly MIN_SAMPLES_PER_CLUSTER = 20;

	// k-means 반복 상한. 실제 볼트에서 전체는 17회, 표본은 k에 따라 12~31회에 스스로 멈추므로
	// 여유를 둔 안전장치다. 중간에 끊으면 안 된다 — 덜 수렴한 결과로 매긴 점수는 k끼리
	// 구분이 안 될 만큼 뭉개진다(표본 크기 주석 참고).
	private static readonly MAX_ITERATIONS = 60;

	// 덩어리 수의 상한. 사용자가 직접 넣든 구독 개수에서 오든 여기서 잘린다.
	//
	// 실제 볼트 8334편으로 잰 값 — k가 커질수록 느려지고 덩어리가 잘아진다:
	//   k=9  1.1초, 덩어리당 651편   k=20  4.8초, 285편   k=50  7.1초, 107편(최소 28편)
	// 20에서 이미 5초에 가깝고, 색이 10가지뿐이라 그 위로는 색이 두 바퀴 넘게 돌아 화면에서
	// 구분이 안 된다. 구독을 100개 등록해도 여기서 막힌다.
	private static readonly MAX_K = 20;

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

	// 직전 계산의 번호. 논문이 늘어도 화면 색이 유지되게 하는 데 쓴다
	// (inheritNumbers 참고). 캐시와 달리 논문이 바뀌어도 버리지 않는다.
	private previousLabels = new Map<string, number>();

	// 캐시를 버린다. 논문을 다시 수집했거나 임베딩 모델이 바뀌었을 때 호출자가 부른다.
	reset(): void {
		this.cachedKey = '';
		this.cachedLabels = new Map();
		this.cachedResult = undefined;
		this.previousLabels = new Map();
	}

	// 논문들을 묶고 각 논문의 extra.clusterId를 채운다. 보류된 논문과 임베딩이 없는 논문은
	// 값을 비운다 — 지난 계산의 번호가 남아 엉뚱한 색으로 그려지지 않게 한다.
	// requestedCount가 0이면 구독 개수에서 자동으로 정한다(chooseK).
	run(papers: Paper[], requestedCount = 0): ClusterResult {
		const valid = Clustering.selectValid(papers);
		const key = Clustering.cacheKey(valid, requestedCount);
		if (key === this.cachedKey && this.cachedResult) {
			Clustering.applyLabels(papers, this.cachedLabels);
			return this.cachedResult;
		}

		const labels = new Map<string, number>();
		let clusterCount = 0;
		if (valid.length >= Clustering.MIN_PAPERS) {
			const dim = valid[0]?.embedding.length ?? 0;
			const vectors = Clustering.pack(valid, dim);
			const k = Clustering.chooseK(valid, requestedCount);
			const centroids = Clustering.kmeans(vectors, valid.length, dim, k, Clustering.MAX_ITERATIONS);
			clusterCount = Clustering.assign(vectors, valid, dim, k, centroids, labels, this.previousLabels);
		}

		const result: ClusterResult = {
			clusterCount,
			requestedCount,
			clustered: labels.size,
			ambiguous: valid.length - labels.size,
			skipped: papers.length - valid.length,
		};
		this.cachedKey = key;
		this.cachedLabels = labels;
		this.cachedResult = result;
		// 다음 계산이 번호를 물려받을 수 있게 남긴다.
		this.previousLabels = labels;
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

	// 캐시를 그대로 쓸 수 있는지 판단하는 열쇠. 정렬돼 있으므로 논문이 추가·삭제되면 편수와
	// 양 끝 sourceId 중 하나는 반드시 달라진다. 요청한 덩어리 수도 넣어야 한다 — 빼면
	// 사용자가 숫자를 바꿔도 캐시가 그대로 맞아떨어져 화면이 안 바뀐다.
	private static cacheKey(valid: Paper[], requestedCount: number): string {
		const first = valid[0]?.sourceId ?? '';
		const last = valid[valid.length - 1]?.sourceId ?? '';
		return `${valid.length}|${first}|${last}|${requestedCount}`;
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

	// 몇 덩어리로 나눌지 정한다.
	//
	// 기하학으로 추측하지 않는다. 실루엣·CH지수·관성 무릎을 전부 재봤지만 실제 볼트에서는
	// 셋 다 k=2를 가리켰다(순도 55%). 정작 좋은 값은 6~7이었다(순도 85%) — 논문 주제가
	// 연속적으로 이어져 있어 "몇 덩어리"라는 기하학적 신호가 아예 없기 때문이다. 게다가 그
	// 점수들은 표본 크기에 휘둘려서, 표본을 600에서 3000으로 바꾸자 답이 2에서 5로 뒤집혔다.
	//
	// 대신 이미 알고 있는 값을 쓴다: 논문을 몇 개의 구독으로 모았는가. 추측이 아니라 기록이라
	// 흔들리지 않고, 탐색이 사라져 훨씬 빠르다.
	private static chooseK(papers: Paper[], requested: number): number {
		const limit = Clustering.maxK(papers.length);
		if (requested > 0) {
			// 사용자가 정한 값. 범위 밖이면 자른다 — 1이면 전부 한 색이라 나눈 의미가 없고,
			// 너무 크면 느려지는 데다 색이 돌아 쓰여 화면에서 구분되지 않는다.
			return Math.min(Math.max(requested, Clustering.MIN_K), limit);
		}

		// 안 정했으면 구독 개수를 쓴다. 논문마다 "어떤 구독으로 수집됐는가"가 남아 있고,
		// 조건을 여러 개 AND로 묶은 구독도 한 줄('combined')로 합쳐져 저장되므로, 서로 다른
		// 문자열 개수가 곧 구독 개수다(SearchQuery.combineQueries). Subscriptions.json을 읽지
		// 않는 이유는 그 파일이 "지금 구독 중인 것"만 담기 때문이다 — 구독을 지워도 그 논문은
		// 화면에 남아 있으므로, 실제로 그려지는 논문이 어디서 왔는지를 세는 쪽이 맞다(실측:
		// 파일에는 3개만 남아 있었지만 논문에는 7개가 기록돼 있었고, 7이 옳은 값이었다).
		const subscriptions = new Set<string>();
		for (const paper of papers) {
			for (const query of paper.collectedQueries ?? []) {
				subscriptions.add(query.query);
			}
		}
		return Math.min(Math.max(subscriptions.size, Clustering.MIN_K), limit);
	}

	// 이 논문 수에서 허용하는 덩어리 수의 상한. 고정값으로 두면 논문이 적은 사람에게 너무
	// 커진다(100편을 20덩어리로 나누면 덩어리당 5편이다). UI가 입력칸의 최대값으로 쓴다.
	static maxK(paperCount: number): number {
		return Math.max(
			Clustering.MIN_K,
			Math.min(Clustering.MAX_K, Math.floor(paperCount / Clustering.MIN_SAMPLES_PER_CLUSTER)),
		);
	}

	// UI가 입력칸에 그대로 쓸 수 있는 하한.
	static get minK(): number {
		return Clustering.MIN_K;
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

		const assignment = new Int32Array(count);
		// 논문마다 "자기 중심까지의 거리는 이보다 크지 않다"(upper)와 "다른 중심까지는 이보다
		// 가깝지 않다"(lower). 이 둘만으로 옮길 필요가 없다고 판정되면 거리 계산을 통째로
		// 건너뛴다 — 몇 번 돌고 나면 대부분의 논문이 제자리라, 실제 볼트에서 3배 빨라지면서
		// 결과는 한 편도 다르지 않았다(8334편·k=9: 2417ms → 803ms).
		const upper = new Float64Array(count).fill(Infinity);
		const lower = new Float64Array(count);

		const sums = new Float64Array(k * dim);
		const counts = new Int32Array(k);
		const previous = new Float64Array(k * dim);
		const drift = new Float64Array(k);
		const halfGap = new Float64Array(k);

		for (let iteration = 0; iteration < maxIterations; iteration += 1) {
			// 각 중심에서 가장 가까운 다른 중심까지 거리의 절반. 자기 중심까지의 거리가
			// 이보다 가까우면 다른 중심이 더 가까울 수는 없다(삼각부등식).
			halfGap.fill(Infinity);
			for (let a = 0; a < k; a += 1) {
				for (let b = 0; b < k; b += 1) {
					if (a === b) {
						continue;
					}
					const gap = Clustering.centroidDistance(centroids, dim, a, b) / 2;
					if (gap < (halfGap[a] as number)) {
						halfGap[a] = gap;
					}
				}
			}

			let moved = 0;
			for (let i = 0; i < count; i += 1) {
				const bound = Math.max(halfGap[assignment[i] as number] as number, lower[i] as number);
				if ((upper[i] as number) <= bound) {
					continue; // 옮길 이유가 없다 — 거리를 재보지 않는다
				}
				// 상한이 느슨해서 걸린 것일 수 있으니, 실제 거리로 조여 한 번 더 본다.
				upper[i] = Clustering.distanceTo(vectors, i, dim, centroids, assignment[i] as number);
				if ((upper[i] as number) <= bound) {
					continue;
				}
				const { cluster, own, other } = Clustering.twoNearest(vectors, i, dim, k, centroids);
				if (assignment[i] !== cluster) {
					assignment[i] = cluster;
					moved += 1;
				}
				upper[i] = own;
				lower[i] = other;
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
			previous.set(centroids);
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

			// 중심이 움직인 만큼 경계를 느슨하게 되돌린다. 그래야 다음 번 판정이 안전하다.
			let worst = 0;
			for (let c = 0; c < k; c += 1) {
				drift[c] = Clustering.centroidDistance(previous, dim, c, c, centroids);
				if ((drift[c] as number) > worst) {
					worst = drift[c] as number;
				}
			}
			for (let i = 0; i < count; i += 1) {
				upper[i] = (upper[i] as number) + (drift[assignment[i] as number] as number);
				lower[i] = (lower[i] as number) - worst;
			}
		}
		return centroids;
	}

	// 중심 a와 중심 b 사이의 거리. b를 다른 배열(other)에서 읽으면 "같은 번호 중심이 얼마나
	// 움직였는가"를 재는 데도 쓸 수 있다.
	private static centroidDistance(
		centroids: Float64Array,
		dim: number,
		a: number,
		b: number,
		other: Float64Array = centroids,
	): number {
		let sum = 0;
		for (let d = 0; d < dim; d += 1) {
			const diff = (centroids[a * dim + d] as number) - (other[b * dim + d] as number);
			sum += diff * diff;
		}
		return Math.sqrt(sum);
	}

	// 논문 i에서 중심 c까지의 거리.
	private static distanceTo(
		vectors: Float64Array,
		i: number,
		dim: number,
		centroids: Float64Array,
		c: number,
	): number {
		let sum = 0;
		const from = i * dim;
		const to = c * dim;
		for (let d = 0; d < dim; d += 1) {
			const diff = (vectors[from + d] as number) - (centroids[to + d] as number);
			sum += diff * diff;
		}
		return Math.sqrt(sum);
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
		previous: Map<string, number>,
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
		const renamed = Clustering.inheritNumbers(ordered, raw, valid, previous);
		for (let i = 0; i < valid.length; i += 1) {
			const cluster = raw[i];
			if (cluster !== undefined) {
				labels.set((valid[i] as Paper).sourceId, renamed.get(cluster) ?? cluster);
			}
		}
		return ordered.length;
	}

	// 새 덩어리에 붙일 번호를 정한다. 번호가 곧 색이므로, 논문이 늘어 덩어리가 다시 나뉘어도
	// "대체로 같은 논문들"이 모인 덩어리는 예전 번호를 그대로 물려받아야 화면 색이 유지된다.
	//
	// 큰 덩어리부터, 그 안의 논문들이 예전에 가장 많이 속했던 번호를 가져간다. 이미 다른
	// 덩어리가 가져간 번호는 건너뛰고, 물려받을 게 없으면 아직 안 쓰인 가장 작은 번호를 준다.
	// 예전 기록이 없는 첫 계산에서는 그냥 크기순(큰 덩어리가 0)이 된다.
	private static inheritNumbers(
		ordered: [number, number][],
		raw: (number | undefined)[],
		valid: Paper[],
		previous: Map<string, number>,
	): Map<number, number> {
		// 새 덩어리별로 "예전에 어느 번호였던 논문이 몇 편인지" 센다.
		const votes = new Map<number, Map<number, number>>();
		for (let i = 0; i < valid.length; i += 1) {
			const cluster = raw[i];
			const old = previous.get((valid[i] as Paper).sourceId);
			if (cluster === undefined || old === undefined) {
				continue;
			}
			const box = votes.get(cluster) ?? new Map<number, number>();
			box.set(old, (box.get(old) ?? 0) + 1);
			votes.set(cluster, box);
		}

		const renamed = new Map<number, number>();
		const taken = new Set<number>();
		const leftovers: number[] = [];
		for (const [cluster] of ordered) {
			const box = votes.get(cluster);
			const best = box
				? [...box.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).find(([old]) => !taken.has(old))
				: undefined;
			if (best) {
				renamed.set(cluster, best[0]);
				taken.add(best[0]);
			} else {
				leftovers.push(cluster);
			}
		}
		// 물려받지 못한 덩어리는 남은 번호 중 가장 작은 것부터 채운다.
		let next = 0;
		for (const cluster of leftovers) {
			while (taken.has(next)) {
				next += 1;
			}
			renamed.set(cluster, next);
			taken.add(next);
		}
		return renamed;
	}
}
