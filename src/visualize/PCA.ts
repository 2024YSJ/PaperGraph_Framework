import { Paper } from '../collect/Paper';

// 임베딩 벡터를 그래프용 평면 좌표 (x, y)로 투영하는 PCA.
// 계약·규칙·근거는 docs/Structure/PCA_Spec.md 참고 — 이 파일은 그 스펙의 구현이다.

// ─────────────────────────────────────────────────────────────
// 공개 타입 (스펙 3절)
// ─────────────────────────────────────────────────────────────

// 논문 한 편의 좌표 — 모든 렌더러가 공통으로 쓰는 최소 정보만 담는다
export interface PCAPoint {
	sourceId: string;
	x: number; // 제1주성분
	y: number; // 제2주성분
	paper: Paper; // 원본 논문 참조 — 렌더러가 크기(인용수)·인용 관계·시간축 등에 쓴다
}

// 결과가 맞게 나왔는지 확인하는 값들 (스펙 5절)
export interface PCAMetrics {
	explainedAxis1: number; // 제1축이 담은 분산 비율 (0~1)
	explainedAxis2: number; // 제2축이 담은 분산 비율 (0~1)
	explainedTotal: number; // 두 축 합계
	orthogonality: number; // 두 축의 내적. 0에 가까워야 정상
	meanX: number; // 결과 x 평균. fit 실행에서는 0에 가까워야 정상
	meanY: number; // 결과 y 평균. fit 실행에서는 0에 가까워야 정상
	converged: boolean; // 반복 상한 전에 수렴했는가
	iterations: number; // 실제로 돈 반복 횟수
	// 재사용 실행에서 축이 얼마나 낡았는지. fit 당시 설명 분산 대비 지금 떨어진 비율(0~1)이며,
	// fit 실행에서는 방금 계산한 축이므로 항상 0이다. 이 값이 커지면 refit 기준(9절)을
	// 조정할 근거가 된다 — 스펙 5·9절이 말하는 "품질 하락" 신호를 여기서 바로 읽을 수 있게 한다.
	explainedDrop: number;
}

// 제외된 논문 수 (이유별, 스펙 2절의 검사 순서와 동일)
export interface PCAExcluded {
	malformed: number;
	embeddingFailed: number;
	modelMismatch: number;
	invalidVector: number;
	duplicateId: number;
}

// fit이 찾은 축 일체. PCA가 내부에 보관했다가 다음 호출에서 재사용하며,
// 그 덕에 논문이 추가돼도 기존 점이 제자리에 남는다 (스펙 9절)
export interface PCABasis {
	mean: number[]; // 중심화에 쓴 평균 벡터 — 빠지면 같은 축으로도 투영이 어긋난다
	axis1: number[]; // 제1주성분
	axis2: number[]; // 제2주성분. 데이터가 일직선(rank-1)이면 영벡터
	usedModel: string; // fit 당시 기준 모델
	dimension: number; // fit 당시 차원 수
	fittedCount: number; // fit 당시 유효 논문 수 — 20% 증감 판정의 기준
	fittedExplainedTotal: number; // fit 당시 설명 분산 합 — 품질 하락 관찰용
}

export interface PCAResult {
	points: PCAPoint[];
	metrics: PCAMetrics;
	excluded: PCAExcluded;
	usedModel: string; // 기준으로 삼은 임베딩 모델
	dimension: number; // 사용한 벡터 차원 수
	basis: PCABasis; // 이번 실행에 쓰인(또는 새로 만든) 축 — 무엇으로 그렸는지 확인용
	didFit: boolean; // 이번 실행에서 축을 새로 계산했는가
	fitReason: 'basis 없음' | '모델 변경' | '편수 20% 이상 변동' | '재사용';
	// 다시 임베딩하면 그래프에 들어올 수 있는 논문들의 sourceId (아래 needsReembedding 참고).
	// PCA는 걸러내기만 하고 데이터를 고치지 않으므로, 이 목록이 재임베딩 요청의 대상이다.
	needsReembedding: string[];
}

// 좌표를 만들 수 없을 때 던지는 에러. 수치를 필드로 들고 있어
// 받는 쪽이 메시지 문자열을 파싱할 필요가 없다.
export class PCAError extends Error {
	inputCount: number; // 입력 논문 수
	validCount: number; // 걸러낸 뒤 남은 수
	excluded: PCAExcluded; // 이유별 제외 수
	usedModel: string; // 기준 모델 (후보가 전혀 없었으면 빈 문자열)
	// 다시 임베딩하면 살아날 논문들. 그래프를 못 그린 상황일수록 이 목록이 중요하다 —
	// "논문이 부족하다"의 해결책이 재수집이 아니라 재임베딩일 수 있기 때문이다.
	needsReembedding: string[];

	constructor(
		message: string,
		info: {
			inputCount: number;
			validCount: number;
			excluded: PCAExcluded;
			usedModel: string;
			needsReembedding: string[];
		},
	) {
		super(message);
		this.name = 'PCAError';
		this.inputCount = info.inputCount;
		this.validCount = info.validCount;
		this.excluded = info.excluded;
		this.usedModel = info.usedModel;
		this.needsReembedding = info.needsReembedding;
	}
}

// ─────────────────────────────────────────────────────────────
// PCA 본체
// ─────────────────────────────────────────────────────────────

export class PCA {
	// ── 상수 — 값 조정은 여기 한 곳에서 한다 ──────────────────────────

	// 그래프를 그릴 최소 유효 논문 수. 팀 합의(경향성)에 따른 값 — 수학적 하한 3 밑으로 내리지 말 것 (스펙 2절)
	private static readonly MIN_VALID_PAPERS = 15;
	// 벡터 원소 절댓값 상한. 이 안의 값은 분산 계산의 제곱에서도 넘치지 않는다 (스펙 2절)
	private static readonly MAX_ABS_ELEMENT = 1e100;
	// 멱반복 상한과 수렴 판정 허용오차 (스펙 4절 구현 메모).
	// 두 축의 분산이 비슷한 데이터는 평면 안 회전이 늦게 잦아들어 수백 회가 걸릴 수 있는데,
	// 반복 비용이 회당 미미하므로 상한을 넉넉히 잡는다
	private static readonly MAX_ITERATIONS = 1000;
	private static readonly CONVERGENCE_EPS = 1e-10;
	// 직교화 후 벡터가 사실상 영벡터인지(rank-1) 판정하는 임계값
	private static readonly DEGENERATE_EPS = 1e-12;
	// fit 당시 대비 유효 편수가 이 비율 이상 증감하면 자동 refit — 늘어날 때와 줄어들 때 모두 (스펙 9절)
	private static readonly REFIT_COUNT_CHANGE_RATIO = 0.2;
	// "전체 분산 0" 판정용 상대 임계값. 완전히 같은 벡터들도 부동소수점 때문에
	// (같은 값 n개의 평균조차 1ulp 어긋난다) 분산이 정확한 0이 아니라 ~1e-29로 나오므로,
	// 데이터 크기(평균 제곱 노름) 대비 상대 비교로 판정한다
	private static readonly RELATIVE_ZERO_VARIANCE = 1e-24;

	// 세션 캐시 — 직전 실행에서 얻은 축을 보관했다가 다음 호출에 재사용한다.
	// 덕분에 호출 측이 아무것도 하지 않아도 논문이 추가될 때 기존 점이 제자리에 남는다.
	// 플러그인이 꺼지면 사라지는 메모리 전용이며, 재시작 후 좌표까지 유지하는 것은
	// 지금 범위가 아니다(파일 저장이 필요하고 그건 PCA가 할 수 없는 일이다).
	private cachedBasis?: PCABasis;

	// 동기 실행. 입력 배열과 Paper 객체는 읽기만 하고 변형하지 않는다 (스펙 3절).
	// 축은 내부 캐시에서만 가져온다 — 호출 측은 그냥 부르기만 하면 좌표가 고정된다.
	run(papers: Paper[]): PCAResult {
		// 1. 복사본을 sourceId 사전순으로 정렬 — 입력 순서에서 결과를 분리한다 (스펙 4절 결정성).
		//    localeCompare는 로케일에 따라 순서가 달라지므로 코드포인트 비교를 쓴다.
		const sorted = [...papers].sort((a, b) => {
			const idA = String(a?.sourceId);
			const idB = String(b?.sourceId);
			return idA < idB ? -1 : idA > idB ? 1 : 0;
		});

		// 2. 걸러내기 — 어떤 논문을 쓸지 고른다 (스펙 2절)
		const { valid, excluded, usedModel, dimension, needsReembedding } =
			PCA.selectValidPapers(sorted);

		const errorInfo = {
			inputCount: papers.length,
			validCount: valid.length,
			excluded,
			usedModel,
			needsReembedding,
		};

		// 최소 개수 미달 — 에러로 올린다. 재수집 여부는 main이 판단한다 (스펙 2절)
		//
		// 개인 노트 설정 패널(PersonalNoteMiddleware)은 그래프가 성공적으로 뜬 뒤에만
		// 마운트된다(그래프 노드를 이웃 좌표 기준으로 써서 개인 노트를 배치하므로,
		// 기존 그래프 없이는 존재할 수 없다) — 이 메시지가 사실상 "왜 개인 노트 경로를
		// 입력할 곳이 안 보이는지"에 대한 유일한 단서라, 그 연결을 명시한다(QA: 개인 노트
		// 추가를 시도했는데 조용히 실패하는 것처럼 보인다는 보고).
		if (valid.length < PCA.MIN_VALID_PAPERS) {
			throw new PCAError(
				`유효 논문이 ${valid.length}편이라 그래프를 만들 수 없습니다 (최소 ${PCA.MIN_VALID_PAPERS}편 필요) — ` +
					`개인 노트를 포함한 그래프 화면 전체가 이 최소 편수를 채워야 열립니다.`,
				errorInfo,
			);
		}

		// 3. 벡터를 Float64Array로 옮기고 현재 데이터의 평균과 전체 분산을 구한다
		const rows = valid.map((p) => Float64Array.from(p.embedding));
		const currentMean = PCA.meanVector(rows, dimension);
		const { variance: totalVariance, scale: dataScale } = PCA.spreadStats(rows, currentMean);

		// 전체 분산이 사실상 0 = 모든 벡터가 동일 → 주성분을 정의할 수 없다 (스펙 4절 퇴화 케이스).
		// 데이터 크기 대비 상대 비교 — 정확한 0 비교는 부동소수점 때문에 이 경우를 못 잡는다
		if (totalVariance <= dataScale * PCA.RELATIVE_ZERO_VARIANCE) {
			throw new PCAError('모든 논문의 임베딩이 동일해 주성분을 정의할 수 없습니다', errorInfo);
		}

		// 4. basis 판정 — 재사용할지 새로 fit할지는 PCA가 스스로 정한다 (스펙 9절).
		//    재사용으로 판정됐을 때만 값이 있다 (캐시가 비어 있으면 판정이 fit이므로).
		const decision = PCA.decideFit(this.cachedBasis, usedModel, dimension, valid.length);
		const reuseBasis = decision.fit ? undefined : this.cachedBasis;

		// 중심을 어디로 잡을지 먼저 정한다. fit이면 지금 데이터의 평균, 재사용이면 fit 당시의 평균이다
		// (그래야 기존 논문이 같은 좌표에 남는다).
		const mean = reuseBasis === undefined ? currentMean : Float64Array.from(reuseBasis.mean);

		// 중심화는 여기서 한 번만 한다 — 축 계산과 투영이 같은 배열을 나눠 쓴다.
		// 예전에는 fit 분기와 투영에서 각각 만들어 논문 수만큼 배열이 두 벌 생겼다.
		const centered = rows.map((row) => PCA.subtract(row, mean));

		let axis1: Float64Array;
		let axis2: Float64Array;
		let iterations = 0;
		let converged = true;
		let resultBasis: PCABasis;

		if (reuseBasis === undefined) {
			// fit: 멱반복으로 두 주성분을 새로 계산한다
			const fitted = PCA.fitTwoAxes(centered, dimension);
			axis1 = fitted.axis1;
			axis2 = fitted.axis2;
			iterations = fitted.iterations;
			converged = fitted.converged;
			resultBasis = {
				mean: Array.from(mean),
				axis1: Array.from(axis1),
				axis2: Array.from(axis2),
				usedModel,
				dimension,
				fittedCount: valid.length,
				fittedExplainedTotal: 0, // 아래에서 지표 계산 후 채운다
			};
		} else {
			// 재사용: 캐시된 축으로 투영만 한다 — 기존 논문의 좌표가 고정된다
			axis1 = Float64Array.from(reuseBasis.axis1);
			axis2 = Float64Array.from(reuseBasis.axis2);
			resultBasis = reuseBasis;
		}

		// 5. 투영 → (x, y)
		const points: PCAPoint[] = valid.map((paper, i) => {
			const centeredRow = centered[i]!;
			return {
				sourceId: paper.sourceId,
				x: PCA.dot(centeredRow, axis1),
				y: PCA.dot(centeredRow, axis2),
				paper,
			};
		});

		// 6. 최종 점검 — 입력을 다 걸렀는데도 좌표가 깨졌다면 계산 코드의 버그다 (스펙 4절)
		for (const point of points) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
				throw new PCAError('좌표 계산에서 내부 오류가 발생했습니다 (유한하지 않은 좌표)', errorInfo);
			}
		}

		// 7. 검증 지표 — 결과가 맞게 나왔는지 확인할 값들 (스펙 5절)
		const metrics = PCA.computeMetrics(
			points,
			axis1,
			axis2,
			totalVariance,
			converged,
			iterations,
			reuseBasis === undefined ? 0 : reuseBasis.fittedExplainedTotal,
		);

		// fit이었다면 basis에 fit 당시 설명 분산을 기록한다 (다음 실행의 품질 비교 기준)
		if (decision.fit) {
			resultBasis.fittedExplainedTotal = metrics.explainedTotal;
		}

		// 이번에 쓴 축을 세션 캐시에 남긴다 — 다음 호출에서 좌표가 고정된다
		this.cachedBasis = resultBasis;

		return {
			points,
			metrics,
			excluded,
			usedModel,
			dimension,
			basis: resultBasis,
			didFit: decision.fit,
			fitReason: decision.reason,
			needsReembedding,
		};
	}

	// 세션 캐시를 비운다. 다음 실행은 반드시 새로 fit한다.
	//
	// 코퍼스를 바꿔서 볼 때 쓴다 — 예를 들어 "최근 5년"과 "전체"를 오가는 경우, 캐시가 하나뿐이라
	// 앞서 본 코퍼스의 축이 남아 있다. 편수가 크게 달라지면 PCA.decideFit()이 알아서 refit하지만,
	// 편수가 비슷한 다른 코퍼스라면 판별할 단서가 없으므로 호출 측이 명시적으로 비워줘야 한다.
	resetBasis(): void {
		this.cachedBasis = undefined;
	}

	// 어떤 논문을 계산에 넣을지 고른다 (스펙 2절). 좌표를 만드는 일과 재료를 고르는 일은
	// 책임이 다르므로 run()에서 떼어냈다.
	//
	// 두 패스로 도는 이유: modelMismatch와 길이 검사는 기준(모델·길이)이 정해져야 판정할 수
	// 있는데, 그 기준은 1차 통과자를 전부 본 뒤에야 정해지기 때문이다.
	private static selectValidPapers(sorted: Paper[]): {
		valid: Paper[];
		excluded: PCAExcluded;
		usedModel: string;
		dimension: number;
		needsReembedding: string[];
	} {
		const excluded: PCAExcluded = {
			malformed: 0,
			embeddingFailed: 0,
			modelMismatch: 0,
			invalidVector: 0,
			duplicateId: 0,
		};

		// 다시 임베딩하면 살아날 수 있는 논문들. 재임베딩을 요청할 대상이므로 sourceId를 모아둔다.
		// malformed(파일 손상)와 duplicateId(중복)는 임베딩을 다시 해도 해결되지 않으므로 넣지 않는다.
		const needsReembedding: string[] = [];

		// 1차 패스: 구조 검사(malformed·embeddingFailed)를 통과한 후보를 모은다
		const candidates: Paper[] = [];
		for (const paper of sorted) {
			if (!PCA.isWellFormed(paper)) {
				excluded.malformed++;
				continue;
			}
			if (paper.embeddingSucceeded === false) {
				excluded.embeddingFailed++;
				needsReembedding.push(paper.sourceId);
				continue;
			}
			candidates.push(paper);
		}

		// 기준 모델: 가장 많은 논문이 쓰는 모델. 동률이면 정렬상 먼저 나온 모델 (후보가 없으면 빈 문자열)
		const usedModel = PCA.pickMostCommon(
			candidates.map((p) => p.embeddingModel),
			'',
		);
		// 기준 길이: 기준 모델 후보들의 벡터 길이 최빈값
		const dimension = PCA.pickMostCommon(
			candidates.filter((p) => p.embeddingModel === usedModel).map((p) => p.embedding.length),
			0,
		);

		// 2차 패스: 표의 순서대로 판정한다 (modelMismatch → invalidVector → duplicateId)
		const seenIds = new Set<string>();
		const valid: Paper[] = [];
		for (const paper of candidates) {
			if (paper.embeddingModel !== usedModel) {
				excluded.modelMismatch++;
				needsReembedding.push(paper.sourceId);
				continue;
			}
			if (!PCA.isValidVector(paper.embedding, dimension)) {
				excluded.invalidVector++;
				needsReembedding.push(paper.sourceId);
				continue;
			}
			if (seenIds.has(paper.sourceId)) {
				excluded.duplicateId++;
				continue;
			}
			seenIds.add(paper.sourceId);
			valid.push(paper);
		}

		return { valid, excluded, usedModel, dimension, needsReembedding };
	}

	// 결과가 맞게 나왔는지 확인할 값들을 계산한다 (스펙 5절).
	// 분산은 평행이동에 불변이므로 재사용 실행(평균이 0이 아닐 수 있음)에서도 같은 식이 성립한다.
	private static computeMetrics(
		points: PCAPoint[],
		axis1: Float64Array,
		axis2: Float64Array,
		totalVariance: number,
		converged: boolean,
		iterations: number,
		fittedExplainedTotal: number,
	): PCAMetrics {
		// 평균과 분산을 한 번의 순회로 구한다 — 따로 부르면 같은 배열을 여러 번 훑게 된다
		const x = PCA.meanAndVariance(points.map((p) => p.x));
		const y = PCA.meanAndVariance(points.map((p) => p.y));
		const explainedAxis1 = x.variance / totalVariance;
		const explainedAxis2 = y.variance / totalVariance;

		const explainedTotal = explainedAxis1 + explainedAxis2;
		// fit 실행이면 기준값이 0이라 비교 대상이 없다 → 낙폭도 0
		const explainedDrop =
			fittedExplainedTotal > 0
				? Math.max(0, (fittedExplainedTotal - explainedTotal) / fittedExplainedTotal)
				: 0;

		return {
			explainedAxis1,
			explainedAxis2,
			explainedTotal,
			orthogonality: PCA.isAllZero(axis2) ? 0 : PCA.dot(axis1, axis2),
			meanX: x.mean,
			meanY: y.mean,
			converged,
			iterations,
			explainedDrop,
		};
	}

	// ─────────────────────────────────────────────────────────────
	// 걸러내기 도우미 (스펙 2절)
	// ─────────────────────────────────────────────────────────────

	// PCA가 읽는 네 필드의 타입이 전부 맞는지 — JSON 손상은 여기서 입구 차단한다
	private static isWellFormed(paper: Paper): boolean {
		return (
			typeof paper === 'object' &&
			paper !== null &&
			typeof paper.sourceId === 'string' &&
			paper.sourceId.length > 0 &&
			Array.isArray(paper.embedding) &&
			typeof paper.embeddingModel === 'string' &&
			typeof paper.embeddingSucceeded === 'boolean'
		);
	}

	// 벡터 내용 검사: 비었는지 / 길이가 기준과 다른지 / 원소가 유한한 숫자 범위인지
	private static isValidVector(embedding: number[], dimension: number): boolean {
		if (embedding.length === 0 || embedding.length !== dimension) {
			return false;
		}
		for (const value of embedding) {
			// JSON에서 온 배열엔 null이 섞여 있을 수 있다. 거대한 값은 제곱에서 넘친다
			if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > PCA.MAX_ABS_ELEMENT) {
				return false;
			}
		}
		return true;
	}

	// 가장 많이 나온 값. 동률이면 먼저 나온 값 (입력이 정렬돼 있으므로 결정적이다)
	private static pickMostCommon<T>(items: T[], fallback: T): T {
		const counts = new Map<T, number>();
		let best = fallback;
		let bestCount = 0;
		for (const item of items) {
			const count = (counts.get(item) ?? 0) + 1;
			counts.set(item, count);
			// 초과일 때만 교체 — 동률이면 먼저 나온 쪽이 유지된다
			if (count > bestCount) {
				best = item;
				bestCount = count;
			}
		}
		return best;
	}

	// ─────────────────────────────────────────────────────────────
	// basis 판정 (스펙 9절)
	// ─────────────────────────────────────────────────────────────

	private static decideFit(
		basis: PCABasis | undefined,
		usedModel: string,
		dimension: number,
		validCount: number,
	): { fit: boolean; reason: PCAResult['fitReason'] } {
		if (basis === undefined) {
			return { fit: true, reason: 'basis 없음' };
		}
		if (basis.usedModel !== usedModel || basis.dimension !== dimension) {
			return { fit: true, reason: '모델 변경' };
		}
		// 기준은 fit 당시 편수다 — 재사용할 때 갱신하지 않으므로 기준선이 조금씩 밀리지 않는다.
		// fittedCount는 최소 편수 검사를 통과한 뒤에만 설정되므로 0이 될 수 없다.
		if (Math.abs(validCount - basis.fittedCount) / basis.fittedCount >= PCA.REFIT_COUNT_CHANGE_RATIO) {
			return { fit: true, reason: '편수 20% 이상 변동' };
		}
		return { fit: false, reason: '재사용' };
	}

	// ─────────────────────────────────────────────────────────────
	// 주성분 계산 — 멱반복 + 매 반복 한쪽 방향 직교화 (스펙 4절)
	// ─────────────────────────────────────────────────────────────

	private static fitTwoAxes(
		centered: Float64Array[],
		dimension: number,
	): { axis1: Float64Array; axis2: Float64Array; iterations: number; converged: boolean } {
		// 시작 벡터는 고정된 규칙으로 — 난수를 쓰면 실행마다 그래프가 뒤집힐 수 있다 (스펙 4절 결정성)
		let v1 = PCA.initialVector1(centered, dimension);
		let v2 = PCA.initialVector2(centered, dimension, v1);

		let iterations = 0;
		let converged = false;

		const w1 = new Float64Array(dimension);
		const w2 = new Float64Array(dimension);

		while (iterations < PCA.MAX_ITERATIONS) {
			iterations++;

			// w = C·v = Xᵀ(X·v)/n — 공분산 행렬을 실제로 만들지 않는다.
			// 두 축을 한 번의 순회로 함께 처리한다 — 데이터가 캐시에 안 들어갈 만큼 크면
			// 순회 횟수가 곧 비용이라, 따로 두 번 도는 것보다 확실히 싸다.
			PCA.covarianceTimesPair(centered, v1, v2, w1, w2);
			PCA.normalize(w1);

			// v2에서 v1 방향 성분을 뺀다 — 한쪽 방향 직교화로 축 순서가 보장된다
			PCA.subtractProjection(w2, w1);
			if (PCA.norm(w2) < PCA.DEGENERATE_EPS) {
				// 데이터가 일직선(rank-1) — 2축이 존재하지 않는다. 에러가 아니라 정상 종료 (스펙 4절 퇴화 케이스).
				// rank-1 basis의 axis2는 영벡터로 저장한다 — 재사용 시 y = 내적 = 0이 자연히 유지된다
				v1.set(w1);
				return { axis1: PCA.fixSign(v1), axis2: new Float64Array(dimension), iterations, converged: true };
			}
			PCA.normalize(w2);

			// 수렴 판정: 부호가 일시적으로 뒤집혀도 방향이 같으면 수렴으로 본다 (|내적| 비교)
			const stable1 = Math.abs(PCA.dot(w1, v1)) > 1 - PCA.CONVERGENCE_EPS;
			const stable2 = Math.abs(PCA.dot(w2, v2)) > 1 - PCA.CONVERGENCE_EPS;
			v1.set(w1);
			v2.set(w2);
			if (stable1 && stable2) {
				converged = true;
				break;
			}
		}

		// 수렴 후 교환 단계: 시작 벡터가 우연히 1축과 수직이었으면 축이 뒤바뀌어 수렴할 수 있다.
		// 투영 분산이 큰 쪽을 1축으로 확정한다 (스펙 4절).
		// 두 축의 분산을 한 번의 순회로 함께 잰다 — 따로 재면 데이터를 두 번 훑는다.
		const spread = PCA.projectionVariancePair(centered, v1, v2);
		if (spread.second > spread.first) {
			[v1, v2] = [v2, v1];
			// 교환 후 v2를 v1에 대해 한 번 더 정돈해 직교를 확실히 한다
			PCA.subtractProjection(v2, v1);
			PCA.normalize(v2);
		}

		// 부호 고정은 교환 뒤에 한다 (스펙 4절 결정성)
		return { axis1: PCA.fixSign(v1), axis2: PCA.fixSign(v2), iterations, converged };
	}

	// v1 초기값: 중심화된 데이터 중 처음으로 크기가 0이 아닌 벡터. 없으면 표준 기저 (도달 불가 — 분산 0은 이미 에러)
	private static initialVector1(centered: Float64Array[], dimension: number): Float64Array {
		for (const row of centered) {
			if (PCA.norm(row) > PCA.DEGENERATE_EPS) {
				const v = Float64Array.from(row);
				PCA.normalize(v);
				return v;
			}
		}
		return PCA.basisVector(dimension, 0);
	}

	// v2 초기값: v1과 평행하지 않은 다음 데이터 벡터에서 v1 성분을 뺀 것. 없으면 표준 기저에서 찾는다
	private static initialVector2(
		centered: Float64Array[],
		dimension: number,
		v1: Float64Array,
	): Float64Array {
		for (const row of centered) {
			const v = Float64Array.from(row);
			PCA.subtractProjection(v, v1);
			if (PCA.norm(v) > PCA.DEGENERATE_EPS) {
				PCA.normalize(v);
				return v;
			}
		}
		// 데이터에서 못 찾으면 표준 기저 벡터로 폴백 (rank-1이면 멱반복 안에서 퇴화 처리된다)
		for (let i = 0; i < dimension; i++) {
			const v = PCA.basisVector(dimension, i);
			PCA.subtractProjection(v, v1);
			if (PCA.norm(v) > PCA.DEGENERATE_EPS) {
				PCA.normalize(v);
				return v;
			}
		}
		return PCA.basisVector(dimension, 0);
	}

	// i번째 성분만 1인 표준 기저 벡터
	private static basisVector(dimension: number, index: number): Float64Array {
		const v = new Float64Array(dimension);
		v[index] = 1;
		return v;
	}

	// ─────────────────────────────────────────────────────────────
	// 벡터 연산 도우미 — 인덱스 접근은 전부 이 안에 가둔다
	// (noUncheckedIndexedAccess가 Float64Array에도 적용되므로, 루프의 ! 단언을 여기서만 쓴다)
	// ─────────────────────────────────────────────────────────────

	private static dot(a: Float64Array, b: Float64Array): number {
		let sum = 0;
		for (let i = 0; i < a.length; i++) {
			sum += a[i]! * b[i]!;
		}
		return sum;
	}

	private static norm(v: Float64Array): number {
		return Math.sqrt(PCA.dot(v, v));
	}

	// 길이를 1로 만든다. 영벡터는 그대로 둔다 (호출부가 norm으로 먼저 판정한다)
	private static normalize(v: Float64Array): void {
		const n = PCA.norm(v);
		if (n === 0) {
			return;
		}
		for (let i = 0; i < v.length; i++) {
			v[i] = v[i]! / n;
		}
	}

	private static subtract(a: Float64Array, b: Float64Array): Float64Array {
		const out = new Float64Array(a.length);
		for (let i = 0; i < a.length; i++) {
			out[i] = a[i]! - b[i]!;
		}
		return out;
	}

	// v -= (v·u)u — v에서 u 방향 성분을 제거한다 (u는 단위벡터)
	private static subtractProjection(v: Float64Array, u: Float64Array): void {
		const s = PCA.dot(v, u);
		for (let i = 0; i < v.length; i++) {
			v[i] = v[i]! - s * u[i]!;
		}
	}

	// out1 = Xᵀ(X·v1)/n, out2 = Xᵀ(X·v2)/n — 공분산 행렬 곱 두 개를 데이터 한 번 순회로 계산한다.
	// 행렬을 만들지 않는 것과 별개로, 논문 수가 많으면 데이터가 캐시에 안 들어가 순회 자체가 비용이다 (스펙 4절)
	private static covarianceTimesPair(
		rows: Float64Array[],
		v1: Float64Array,
		v2: Float64Array,
		out1: Float64Array,
		out2: Float64Array,
	): void {
		out1.fill(0);
		out2.fill(0);
		for (const row of rows) {
			// 한 행을 읽는 동안 두 축에 대한 내적을 함께 구한다
			let s1 = 0;
			let s2 = 0;
			for (let i = 0; i < row.length; i++) {
				const value = row[i]!;
				s1 += value * v1[i]!;
				s2 += value * v2[i]!;
			}
			for (let i = 0; i < row.length; i++) {
				const value = row[i]!;
				out1[i] = out1[i]! + value * s1;
				out2[i] = out2[i]! + value * s2;
			}
		}
		const n = rows.length;
		for (let i = 0; i < out1.length; i++) {
			out1[i] = out1[i]! / n;
			out2[i] = out2[i]! / n;
		}
	}

	private static meanVector(rows: Float64Array[], dimension: number): Float64Array {
		const mean = new Float64Array(dimension);
		for (const row of rows) {
			for (let i = 0; i < dimension; i++) {
				mean[i] = mean[i]! + row[i]!;
			}
		}
		for (let i = 0; i < dimension; i++) {
			mean[i] = mean[i]! / rows.length;
		}
		return mean;
	}

	// 흩어짐 정도를 한 번의 순회로 잰다.
	//   variance — 각 벡터가 중심에서 떨어진 거리 제곱의 평균 (= 각 차원 분산의 합)
	//   scale    — 벡터 제곱 노름의 평균. "분산이 사실상 0인지"를 상대 비교할 기준이다
	// 차이 벡터를 만들지 않고 원소 단위로 누적한다 — 논문 수만큼 배열이 생기는 것을 피한다.
	private static spreadStats(
		rows: Float64Array[],
		mean: Float64Array,
	): { variance: number; scale: number } {
		let diffSum = 0;
		let normSum = 0;
		for (const row of rows) {
			for (let i = 0; i < row.length; i++) {
				const value = row[i]!;
				const diff = value - mean[i]!;
				diffSum += diff * diff;
				normSum += value * value;
			}
		}
		return { variance: diffSum / rows.length, scale: normSum / rows.length };
	}

	// 축 방향 투영값들의 분산 (중심화된 데이터이므로 평균 0 기준)
	// 두 축 방향 투영값의 분산을 한 번의 순회로 구한다 (중심화된 데이터이므로 평균 0 기준).
	// 교환 단계에서만 쓰이며, 따로 재면 데이터를 두 번 훑게 된다.
	private static projectionVariancePair(
		centered: Float64Array[],
		axis1: Float64Array,
		axis2: Float64Array,
	): { first: number; second: number } {
		let sum1 = 0;
		let sum2 = 0;
		for (const row of centered) {
			let s1 = 0;
			let s2 = 0;
			for (let i = 0; i < row.length; i++) {
				const value = row[i]!;
				s1 += value * axis1[i]!;
				s2 += value * axis2[i]!;
			}
			sum1 += s1 * s1;
			sum2 += s2 * s2;
		}
		const n = centered.length;
		return { first: sum1 / n, second: sum2 / n };
	}

	// 부호 고정: 절댓값이 가장 큰 성분(동률이면 앞 인덱스)이 양수가 되도록 뒤집는다 (스펙 4절 결정성)
	private static fixSign(v: Float64Array): Float64Array {
		let maxIndex = 0;
		let maxAbs = 0;
		for (let i = 0; i < v.length; i++) {
			const abs = Math.abs(v[i]!);
			if (abs > maxAbs) {
				maxAbs = abs;
				maxIndex = i;
			}
		}
		if (v[maxIndex]! < 0) {
			for (let i = 0; i < v.length; i++) {
				v[i] = -v[i]!;
			}
		}
		return v;
	}

	private static isAllZero(v: Float64Array): boolean {
		for (let i = 0; i < v.length; i++) {
			if (v[i] !== 0) {
				return false;
			}
		}
		return true;
	}

	// ─────────────────────────────────────────────────────────────
	// 통계 도우미 (검증 지표용)
	// ─────────────────────────────────────────────────────────────

	// 투영값들의 평균과 분산을 한 번의 순회로 구한다 (검증 지표용).
	// 분산은 자기 평균 기준이라 재사용 실행에서 평균이 0이 아니어도 올바르게 잰다.
	private static meanAndVariance(values: number[]): { mean: number; variance: number } {
		let sum = 0;
		for (const value of values) {
			sum += value;
		}
		const mean = sum / values.length;

		let squared = 0;
		for (const value of values) {
			squared += (value - mean) * (value - mean);
		}
		return { mean, variance: squared / values.length };
	}
}
