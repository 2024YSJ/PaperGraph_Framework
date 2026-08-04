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
}

// 제외된 논문 수 (이유별, 스펙 2절의 검사 순서와 동일)
export interface PCAExcluded {
	malformed: number;
	embeddingFailed: number;
	modelMismatch: number;
	invalidVector: number;
	duplicateId: number;
}

// fit이 찾은 축 일체. 다음 호출에 그대로 넘기면 fit을 건너뛰어
// 기존 논문의 좌표가 고정된다 (스펙 9절)
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
	basis: PCABasis; // 이번 실행에 쓰인(또는 새로 만든) 축 — 호출 측이 보관했다가 다음 호출에 넘긴다
	didFit: boolean; // 이번 실행에서 축을 새로 계산했는가
	fitReason: 'basis 없음' | 'basis 손상' | '모델 변경' | '편수 20% 이상 변동' | '재사용';
}

// 좌표를 만들 수 없을 때 던지는 에러. 수치를 필드로 들고 있어
// 받는 쪽이 메시지 문자열을 파싱할 필요가 없다.
export class PCAError extends Error {
	inputCount: number; // 입력 논문 수
	validCount: number; // 걸러낸 뒤 남은 수
	excluded: PCAExcluded; // 이유별 제외 수
	usedModel: string; // 기준 모델 (후보가 전혀 없었으면 빈 문자열)

	constructor(
		message: string,
		info: { inputCount: number; validCount: number; excluded: PCAExcluded; usedModel: string },
	) {
		super(message);
		this.name = 'PCAError';
		this.inputCount = info.inputCount;
		this.validCount = info.validCount;
		this.excluded = info.excluded;
		this.usedModel = info.usedModel;
	}
}

// ─────────────────────────────────────────────────────────────
// 상수 — 값 조정은 여기 한 곳에서 한다
// ─────────────────────────────────────────────────────────────

// 그래프를 그릴 최소 유효 논문 수. 팀 합의(경향성)에 따른 값 — 수학적 하한 3 밑으로 내리지 말 것 (스펙 2절)
const MIN_VALID_PAPERS = 15;
// 벡터 원소 절댓값 상한. 이 안의 값은 분산 계산의 제곱에서도 넘치지 않는다 (스펙 2절)
const MAX_ABS_ELEMENT = 1e100;
// 멱반복 상한과 수렴 판정 허용오차 (스펙 4절 구현 메모).
// 두 축의 분산이 비슷한 데이터는 평면 안 회전이 늦게 잦아들어 수백 회가 걸릴 수 있는데,
// 반복 비용이 회당 미미하므로 상한을 넉넉히 잡는다
const MAX_ITERATIONS = 1000;
const CONVERGENCE_EPS = 1e-10;
// 직교화 후 벡터가 사실상 영벡터인지(rank-1) 판정하는 임계값
const DEGENERATE_EPS = 1e-12;
// basis 축 검증(단위길이·직교) 허용오차 (스펙 9절)
const AXIS_TOLERANCE = 1e-6;
// fit 당시 대비 유효 편수가 이 비율 이상 증감하면 자동 refit (스펙 9절)
const REFIT_GROWTH_RATIO = 0.2;
// "전체 분산 0" 판정용 상대 임계값. 완전히 같은 벡터들도 부동소수점 때문에
// (같은 값 n개의 평균조차 1ulp 어긋난다) 분산이 정확한 0이 아니라 ~1e-29로 나오므로,
// 데이터 크기(평균 제곱 노름) 대비 상대 비교로 판정한다
const RELATIVE_ZERO_VARIANCE = 1e-24;

// ─────────────────────────────────────────────────────────────
// PCA 본체
// ─────────────────────────────────────────────────────────────

export class PCA {
	// 동기·무상태. 입력 배열과 Paper 객체는 읽기만 하고 변형하지 않는다 (스펙 3절).
	run(papers: Paper[], basis?: PCABasis): PCAResult {
		// 1. 복사본을 sourceId 사전순으로 정렬 — 입력 순서에서 결과를 분리한다 (스펙 4절 결정성).
		//    localeCompare는 로케일에 따라 순서가 달라지므로 코드포인트 비교를 쓴다.
		const sorted = [...papers].sort((a, b) => {
			const idA = String(a?.sourceId);
			const idB = String(b?.sourceId);
			return idA < idB ? -1 : idA > idB ? 1 : 0;
		});

		// 2. 걸러내기 (스펙 2절). 두 패스 — 1차에서 기준(모델·길이)을 정하고, 2차에서 판정한다.
		const excluded: PCAExcluded = {
			malformed: 0,
			embeddingFailed: 0,
			modelMismatch: 0,
			invalidVector: 0,
			duplicateId: 0,
		};

		// 1차 패스: 구조 검사(malformed·embeddingFailed)를 통과한 후보를 모은다
		const candidates: Paper[] = [];
		for (const paper of sorted) {
			if (!isWellFormed(paper)) {
				excluded.malformed++;
				continue;
			}
			if (paper.embeddingSucceeded === false) {
				excluded.embeddingFailed++;
				continue;
			}
			candidates.push(paper);
		}

		// 기준 모델: 가장 많은 논문이 쓰는 모델. 동률이면 정렬상 먼저 나온 모델 (후보가 없으면 빈 문자열)
		const usedModel = pickMostCommon(
			candidates.map((p) => p.embeddingModel),
			'',
		);
		// 기준 길이: 기준 모델 후보들의 벡터 길이 최빈값
		const dimension = pickMostCommon(
			candidates.filter((p) => p.embeddingModel === usedModel).map((p) => p.embedding.length),
			0,
		);

		// 2차 패스: 표의 순서대로 판정한다 (modelMismatch → invalidVector → duplicateId)
		const seenIds = new Set<string>();
		const valid: Paper[] = [];
		for (const paper of candidates) {
			if (paper.embeddingModel !== usedModel) {
				excluded.modelMismatch++;
				continue;
			}
			if (!isValidVector(paper.embedding, dimension)) {
				excluded.invalidVector++;
				continue;
			}
			if (seenIds.has(paper.sourceId)) {
				excluded.duplicateId++;
				continue;
			}
			seenIds.add(paper.sourceId);
			valid.push(paper);
		}

		const errorInfo = { inputCount: papers.length, validCount: valid.length, excluded, usedModel };

		// 최소 개수 미달 — 에러로 올린다. 재수집 여부는 main이 판단한다 (스펙 2절)
		if (valid.length < MIN_VALID_PAPERS) {
			throw new PCAError(
				`유효 논문이 ${valid.length}편이라 그래프를 만들 수 없습니다 (최소 ${MIN_VALID_PAPERS}편 필요)`,
				errorInfo,
			);
		}

		// 3. 벡터를 Float64Array로 옮기고 현재 데이터의 평균과 전체 분산을 구한다
		const rows = valid.map((p) => Float64Array.from(p.embedding));
		const currentMean = meanVector(rows, dimension);
		const totalVariance = varianceAround(rows, currentMean);

		// 전체 분산이 사실상 0 = 모든 벡터가 동일 → 주성분을 정의할 수 없다 (스펙 4절 퇴화 케이스).
		// 데이터 크기 대비 상대 비교 — 정확한 0 비교는 부동소수점 때문에 이 경우를 못 잡는다
		const dataScale = averageSquaredNorm(rows);
		if (totalVariance <= dataScale * RELATIVE_ZERO_VARIANCE) {
			throw new PCAError('모든 논문의 임베딩이 동일해 주성분을 정의할 수 없습니다', errorInfo);
		}

		// 4. basis 판정 — 재사용할지 새로 fit할지는 PCA가 스스로 정한다 (스펙 9절)
		const decision = decideFit(basis, usedModel, dimension, valid.length);

		let mean: Float64Array;
		let axis1: Float64Array;
		let axis2: Float64Array;
		let iterations = 0;
		let converged = true;
		let resultBasis: PCABasis;

		if (decision.fit || basis === undefined) {
			// fit: 멱반복으로 두 주성분을 새로 계산한다
			mean = currentMean;
			const centered = rows.map((row) => subtract(row, mean));
			const fitted = fitTwoAxes(centered, dimension);
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
			// 재사용: 저장된 평균·축으로 투영만 한다 — 기존 논문의 좌표가 고정된다
			mean = Float64Array.from(basis.mean);
			axis1 = Float64Array.from(basis.axis1);
			axis2 = Float64Array.from(basis.axis2);
			resultBasis = basis;
		}

		// 5. 투영 → (x, y)
		const points: PCAPoint[] = valid.map((paper, i) => {
			const centeredRow = subtract(rows[i]!, mean);
			return {
				sourceId: paper.sourceId,
				x: dot(centeredRow, axis1),
				y: dot(centeredRow, axis2),
				paper,
			};
		});

		// 6. 최종 점검 — 입력을 다 걸렀는데도 좌표가 깨졌다면 계산 코드의 버그다 (스펙 4절)
		for (const point of points) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
				throw new PCAError('좌표 계산에서 내부 오류가 발생했습니다 (유한하지 않은 좌표)', errorInfo);
			}
		}

		// 7. 검증 지표 (스펙 5절). 분산은 평행이동에 불변이므로 재사용 실행에서도 같은 식이 성립한다
		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		const metrics: PCAMetrics = {
			explainedAxis1: statVariance(xs) / totalVariance,
			explainedAxis2: statVariance(ys) / totalVariance,
			explainedTotal: 0, // 바로 아래에서 합산
			orthogonality: isAllZero(axis2) ? 0 : dot(axis1, axis2),
			meanX: average(xs),
			meanY: average(ys),
			converged,
			iterations,
		};
		metrics.explainedTotal = metrics.explainedAxis1 + metrics.explainedAxis2;

		// fit이었다면 basis에 fit 당시 설명 분산을 기록한다 (다음 실행의 품질 비교 기준)
		if (decision.fit) {
			resultBasis.fittedExplainedTotal = metrics.explainedTotal;
		}

		return {
			points,
			metrics,
			excluded,
			usedModel,
			dimension,
			basis: resultBasis,
			didFit: decision.fit,
			fitReason: decision.reason,
		};
	}
}

// ─────────────────────────────────────────────────────────────
// 걸러내기 도우미 (스펙 2절)
// ─────────────────────────────────────────────────────────────

// PCA가 읽는 네 필드의 타입이 전부 맞는지 — JSON 손상은 여기서 입구 차단한다
function isWellFormed(paper: Paper): boolean {
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
function isValidVector(embedding: number[], dimension: number): boolean {
	if (embedding.length === 0 || embedding.length !== dimension) {
		return false;
	}
	for (const value of embedding) {
		// JSON에서 온 배열엔 null이 섞여 있을 수 있다. 거대한 값은 제곱에서 넘친다
		if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_ELEMENT) {
			return false;
		}
	}
	return true;
}

// 가장 많이 나온 값. 동률이면 먼저 나온 값 (입력이 정렬돼 있으므로 결정적이다)
function pickMostCommon<T>(items: T[], fallback: T): T {
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

function decideFit(
	basis: PCABasis | undefined,
	usedModel: string,
	dimension: number,
	validCount: number,
): { fit: boolean; reason: PCAResult['fitReason'] } {
	if (basis === undefined) {
		return { fit: true, reason: 'basis 없음' };
	}
	if (!isBasisIntact(basis)) {
		return { fit: true, reason: 'basis 손상' };
	}
	if (basis.usedModel !== usedModel || basis.dimension !== dimension) {
		return { fit: true, reason: '모델 변경' };
	}
	if (Math.abs(validCount - basis.fittedCount) / basis.fittedCount >= REFIT_GROWTH_RATIO) {
		return { fit: true, reason: '편수 20% 이상 변동' };
	}
	return { fit: false, reason: '재사용' };
}

// basis가 온전한지 검사한다. 파일 저장이 연결되면 손상된 basis는 반드시 온다 (스펙 9절).
// 예외: axis2가 전부 0이면 rank-1 basis(일직선 데이터의 fit 결과)로 정상 취급한다.
function isBasisIntact(basis: PCABasis): boolean {
	if (!Number.isInteger(basis.dimension) || basis.dimension < 1) {
		return false;
	}
	if (!Number.isFinite(basis.fittedCount) || basis.fittedCount < 1) {
		return false;
	}
	if (typeof basis.usedModel !== 'string' || !Number.isFinite(basis.fittedExplainedTotal)) {
		return false;
	}
	if (
		!isFiniteNumberArray(basis.mean, basis.dimension) ||
		!isFiniteNumberArray(basis.axis1, basis.dimension) ||
		!isFiniteNumberArray(basis.axis2, basis.dimension)
	) {
		return false;
	}
	const axis1 = Float64Array.from(basis.axis1);
	const axis2 = Float64Array.from(basis.axis2);
	if (Math.abs(norm(axis1) - 1) > AXIS_TOLERANCE) {
		return false;
	}
	if (!isAllZero(axis2)) {
		if (Math.abs(norm(axis2) - 1) > AXIS_TOLERANCE) {
			return false;
		}
		if (Math.abs(dot(axis1, axis2)) > AXIS_TOLERANCE) {
			return false;
		}
	}
	return true;
}

function isFiniteNumberArray(values: number[], length: number): boolean {
	if (!Array.isArray(values) || values.length !== length) {
		return false;
	}
	for (const value of values) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return false;
		}
	}
	return true;
}

// ─────────────────────────────────────────────────────────────
// 주성분 계산 — 멱반복 + 매 반복 한쪽 방향 직교화 (스펙 4절)
// ─────────────────────────────────────────────────────────────

function fitTwoAxes(
	centered: Float64Array[],
	dimension: number,
): { axis1: Float64Array; axis2: Float64Array; iterations: number; converged: boolean } {
	// 시작 벡터는 고정된 규칙으로 — 난수를 쓰면 실행마다 그래프가 뒤집힐 수 있다 (스펙 4절 결정성)
	let v1 = initialVector1(centered, dimension);
	let v2 = initialVector2(centered, dimension, v1);

	let iterations = 0;
	let converged = false;

	const w1 = new Float64Array(dimension);
	const w2 = new Float64Array(dimension);

	while (iterations < MAX_ITERATIONS) {
		iterations++;

		// w = C·v = Xᵀ(X·v)/n — 공분산 행렬을 실제로 만들지 않는다
		covarianceTimes(centered, v1, w1);
		normalize(w1);

		covarianceTimes(centered, v2, w2);
		// v2에서 v1 방향 성분을 뺀다 — 한쪽 방향 직교화로 축 순서가 보장된다
		subtractProjection(w2, w1);
		if (norm(w2) < DEGENERATE_EPS) {
			// 데이터가 일직선(rank-1) — 2축이 존재하지 않는다. 에러가 아니라 정상 종료 (스펙 4절 퇴화 케이스).
			// rank-1 basis의 axis2는 영벡터로 저장한다 — 재사용 시 y = 내적 = 0이 자연히 유지된다
			v1.set(w1);
			return { axis1: fixSign(v1), axis2: new Float64Array(dimension), iterations, converged: true };
		}
		normalize(w2);

		// 수렴 판정: 부호가 일시적으로 뒤집혀도 방향이 같으면 수렴으로 본다 (|내적| 비교)
		const stable1 = Math.abs(dot(w1, v1)) > 1 - CONVERGENCE_EPS;
		const stable2 = Math.abs(dot(w2, v2)) > 1 - CONVERGENCE_EPS;
		v1.set(w1);
		v2.set(w2);
		if (stable1 && stable2) {
			converged = true;
			break;
		}
	}

	// 수렴 후 교환 단계: 시작 벡터가 우연히 1축과 수직이었으면 축이 뒤바뀌어 수렴할 수 있다.
	// 투영 분산이 큰 쪽을 1축으로 확정한다 (스펙 4절)
	if (projectionVariance(centered, v2) > projectionVariance(centered, v1)) {
		[v1, v2] = [v2, v1];
		// 교환 후 v2를 v1에 대해 한 번 더 정돈해 직교를 확실히 한다
		subtractProjection(v2, v1);
		normalize(v2);
	}

	// 부호 고정은 교환 뒤에 한다 (스펙 4절 결정성)
	return { axis1: fixSign(v1), axis2: fixSign(v2), iterations, converged };
}

// v1 초기값: 중심화된 데이터 중 처음으로 크기가 0이 아닌 벡터. 없으면 표준 기저 (도달 불가 — 분산 0은 이미 에러)
function initialVector1(centered: Float64Array[], dimension: number): Float64Array {
	for (const row of centered) {
		if (norm(row) > DEGENERATE_EPS) {
			const v = Float64Array.from(row);
			normalize(v);
			return v;
		}
	}
	return basisVector(dimension, 0);
}

// v2 초기값: v1과 평행하지 않은 다음 데이터 벡터에서 v1 성분을 뺀 것. 없으면 표준 기저에서 찾는다
function initialVector2(
	centered: Float64Array[],
	dimension: number,
	v1: Float64Array,
): Float64Array {
	for (const row of centered) {
		const v = Float64Array.from(row);
		subtractProjection(v, v1);
		if (norm(v) > DEGENERATE_EPS) {
			normalize(v);
			return v;
		}
	}
	// 데이터에서 못 찾으면 표준 기저 벡터로 폴백 (rank-1이면 멱반복 안에서 퇴화 처리된다)
	for (let i = 0; i < dimension; i++) {
		const v = basisVector(dimension, i);
		subtractProjection(v, v1);
		if (norm(v) > DEGENERATE_EPS) {
			normalize(v);
			return v;
		}
	}
	return basisVector(dimension, 0);
}

// i번째 성분만 1인 표준 기저 벡터
function basisVector(dimension: number, index: number): Float64Array {
	const v = new Float64Array(dimension);
	v[index] = 1;
	return v;
}

// ─────────────────────────────────────────────────────────────
// 벡터 연산 도우미 — 인덱스 접근은 전부 이 안에 가둔다
// (noUncheckedIndexedAccess가 Float64Array에도 적용되므로, 루프의 ! 단언을 여기서만 쓴다)
// ─────────────────────────────────────────────────────────────

function dot(a: Float64Array, b: Float64Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		sum += a[i]! * b[i]!;
	}
	return sum;
}

function norm(v: Float64Array): number {
	return Math.sqrt(dot(v, v));
}

// 길이를 1로 만든다. 영벡터는 그대로 둔다 (호출부가 norm으로 먼저 판정한다)
function normalize(v: Float64Array): void {
	const n = norm(v);
	if (n === 0) {
		return;
	}
	for (let i = 0; i < v.length; i++) {
		v[i] = v[i]! / n;
	}
}

function subtract(a: Float64Array, b: Float64Array): Float64Array {
	const out = new Float64Array(a.length);
	for (let i = 0; i < a.length; i++) {
		out[i] = a[i]! - b[i]!;
	}
	return out;
}

// v -= (v·u)u — v에서 u 방향 성분을 제거한다 (u는 단위벡터)
function subtractProjection(v: Float64Array, u: Float64Array): void {
	const s = dot(v, u);
	for (let i = 0; i < v.length; i++) {
		v[i] = v[i]! - s * u[i]!;
	}
}

// out = Xᵀ(X·v)/n — 공분산 행렬 곱을 행렬 없이 계산한다 (스펙 4절)
function covarianceTimes(rows: Float64Array[], v: Float64Array, out: Float64Array): void {
	out.fill(0);
	for (const row of rows) {
		const s = dot(row, v);
		for (let i = 0; i < row.length; i++) {
			out[i] = out[i]! + row[i]! * s;
		}
	}
	for (let i = 0; i < out.length; i++) {
		out[i] = out[i]! / rows.length;
	}
}

function meanVector(rows: Float64Array[], dimension: number): Float64Array {
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

// 데이터 크기: 벡터 제곱 노름의 평균 — "분산이 사실상 0인지"의 상대 비교 기준
function averageSquaredNorm(rows: Float64Array[]): number {
	let sum = 0;
	for (const row of rows) {
		sum += dot(row, row);
	}
	return sum / rows.length;
}

// 전체 분산: 각 벡터가 중심에서 떨어진 거리 제곱의 평균 (= 각 차원 분산의 합)
function varianceAround(rows: Float64Array[], mean: Float64Array): number {
	let sum = 0;
	for (const row of rows) {
		const diff = subtract(row, mean);
		sum += dot(diff, diff);
	}
	return sum / rows.length;
}

// 축 방향 투영값들의 분산 (중심화된 데이터이므로 평균 0 기준)
function projectionVariance(centered: Float64Array[], axis: Float64Array): number {
	let sum = 0;
	for (const row of centered) {
		const s = dot(row, axis);
		sum += s * s;
	}
	return sum / centered.length;
}

// 부호 고정: 절댓값이 가장 큰 성분(동률이면 앞 인덱스)이 양수가 되도록 뒤집는다 (스펙 4절 결정성)
function fixSign(v: Float64Array): Float64Array {
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

function isAllZero(v: Float64Array): boolean {
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

function average(values: number[]): number {
	let sum = 0;
	for (const value of values) {
		sum += value;
	}
	return sum / values.length;
}

// 통계적 분산 (자기 평균 기준) — 재사용 실행에서 투영값이 0 중심이 아니어도 올바르게 잰다
function statVariance(values: number[]): number {
	const mean = average(values);
	let sum = 0;
	for (const value of values) {
		sum += (value - mean) * (value - mean);
	}
	return sum / values.length;
}
