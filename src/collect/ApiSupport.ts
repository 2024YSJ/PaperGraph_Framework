import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

// 모든 API 구현체가 공유하는 실패 처리 정책과 그 도구들 (2026-08-04 확정).
// 새 API(예: Semantic Scholar, PubMed)를 추가할 때도 이 세 규칙을 그대로 따르면 실패
// 동작이 API마다 달라지지 않는다.
//
//   [1] 수집 자체가 불가능 -> throw
//       설정 오류, 응답 없음/깨짐 등 "결과를 신뢰할 수 없는" 경우. 호출자가 이번 수집을
//       실패로 판단해야 하므로 조용히 빈 배열을 반환하지 않는다. -> requestWithRetry
//
//   [2] 개별 논문이 불완전 -> 그 논문만 제외
//       필수 필드가 없는 항목 하나 때문에 나머지 정상 논문까지 버리지 않는다.
//       -> hasRequiredFields
//
//   [3] 보강(선택 정보)이 실패 -> 논문은 살리고 플래그로 표시
//       인용수처럼 없어도 Paper 자체는 유효한 정보. citationsKnown=false로 남겨 다음
//       수집에서 다시 시도되게 둔다. -> enrichQuietly

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000; // arXiv가 권장하는 호출 간격이자 S2 재시도 간격

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// [1] 정책. 429(rate limit)만 재시도하고, 그 외 실패는 전부 throw한다.
// requestUrl은 기본적으로 비-2xx에서 예외를 던져 429까지 즉시 실패로 만들기 때문에
// throw:false로 받아 상태코드를 직접 판정한다.
export async function requestWithRetry(param: RequestUrlParam): Promise<RequestUrlResponse> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			await delay(RETRY_DELAY_MS);
		}
		const response = await requestUrl({ ...param, throw: false });
		if (response.status === 429) {
			continue;
		}
		if (response.status >= 400) {
			throw new Error(`${param.url} -> HTTP ${response.status}`);
		}
		return response;
	}
	throw new Error(`${param.url} -> rate-limited (429) after ${MAX_ATTEMPTS} attempts`);
}

// [1] 정책. 응답이 정상 XML인지 확인한다. 차단 페이지나 잘린 응답을 파싱하면 entry가
// 0개로 나오는데, 이걸 "검색 결과 없음"과 구별하지 못하면 조용히 빈 결과를 반환하게 된다.
export function parseXml(xmlText: string, source: string): Document {
	const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length > 0) {
		throw new Error(`${source} response was not well-formed XML (throttled or unavailable)`);
	}
	return doc;
}

// [2] 정책. 필수 필드가 모두 비어있지 않은지 확인한다. 하나라도 없으면 호출자가 그
// 항목을 건너뛴다(전체 실패로 만들지 않는다).
export function hasRequiredFields(...values: (string | undefined | null)[]): boolean {
	return values.every((value) => value !== undefined && value !== null && value.length > 0);
}

// [3] 정책. 보강 작업을 감싸 실패를 삼킨다. 보강은 선택 정보이므로 실패해도 수집 결과
// 자체는 유효하며, 채워지지 않은 필드는 플래그(예: citationsKnown=false)로 남아 다음
// 수집에서 다시 시도된다.
export async function enrichQuietly(task: () => Promise<void>): Promise<void> {
	try {
		await task();
	} catch {
		// 의도적으로 무시 — 보강 실패는 수집 실패가 아니다.
	}
}
