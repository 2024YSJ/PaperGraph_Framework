import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

// 외부 HTTP API를 호출할 때 쓰는 범용 도구 모음.
//
// 이 파일은 어떤 서비스를 부르는지, 응답으로 무엇을 만드는지 모른다. 특정 API에
// 맞춘 값(재시도 간격 등)은 상수로 박지 않고 호출자가 RetryPolicy로 주입한다 —
// 여기에 한 서비스의 사정이 스며들기 시작하면 다음 서비스는 이 파일을 쓸 수 없다.
// 도메인별 실패 처리 정책은 그 도메인 쪽(예: collect/API.ts)에 적는다.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000; // 서버가 비상식적으로 긴 Retry-After를 줘도 여기서 자른다

// 일시적 장애로 보고 재시도할 상태코드의 기본값.
// - 429: rate limit
// - 503: 과부하/스로틀. 이걸 빼면 스로틀이 곧바로 "실패"가 되어버린다.
// - 502/504: 게이트웨이 계열 일시 장애
const DEFAULT_RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

// 재시도 동작을 호출자가 조절하는 값들. 전부 선택이며, 주지 않으면 위 기본값을 쓴다.
// 서비스마다 권장 호출 간격이나 스로틀 코드가 다르므로 호출부가 자기 정책을 들고 온다.
export interface RetryPolicy {
	maxAttempts?: number;
	retryDelayMs?: number;
	maxRetryAfterMs?: number;
	retryableStatus?: ReadonlySet<number>;
}

// 요청이 최종 실패했을 때 던지는 에러. 상태코드를 필드로 들고 있어야 호출자가
// "이 서비스에서 이 코드는 이런 뜻"이라는 도메인 판단을 할 수 있다. 문자열 메시지만
// 있으면 호출부는 파싱 말고는 분기할 방법이 없다.
export class HttpRequestError extends Error {
	constructor(
		readonly url: string,
		readonly status: number,
		// 재시도 가능한 상태코드로 MAX_ATTEMPTS를 모두 소진했는지. true면 "서버가 계속
		// 바쁨"이고, false면 "재시도해도 소용없는 실패"다.
		readonly exhausted: boolean,
		attempts: number,
	) {
		super(
			exhausted
				? `${url} -> HTTP ${status} (temporary) after ${attempts} attempts`
				: `${url} -> HTTP ${status}`,
		);
		this.name = 'HttpRequestError';
	}
}

// 응답 본문을 기대한 형식으로 읽지 못했을 때. source는 어느 응답이었는지 알려주는 라벨.
export class ResponseParseError extends Error {
	constructor(readonly source: string, detail: string) {
		super(`${source}: ${detail}`);
		this.name = 'ResponseParseError';
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// 배열을 size 단위로 자른다. 배치 엔드포인트처럼 "요청당 최대 N개" 제한이 있을 때 쓴다.
export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// 서버가 Retry-After로 대기 시간을 알려주면 그걸 따른다(초 단위 또는 HTTP-date).
// 해석할 수 없거나 범위를 벗어나면 undefined를 반환해 호출자가 기본 간격을 쓰게 한다.
function parseRetryAfter(
	headers: Record<string, string> | undefined,
	maxRetryAfterMs: number,
): number | undefined {
	if (!headers) {
		return undefined;
	}
	// 헤더 키의 대소문자는 구현마다 다르므로 소문자로 맞춰 조회한다.
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after');
	const raw = entry?.[1]?.trim();
	if (!raw) {
		return undefined;
	}

	const seconds = Number(raw);
	const ms = Number.isFinite(seconds) ? seconds * 1_000 : new Date(raw).getTime() - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) {
		return undefined;
	}
	return Math.min(ms, maxRetryAfterMs);
}

// 일시적 장애(policy.retryableStatus)만 재시도하고, 그 외 실패는 HttpRequestError로 던진다.
// requestUrl은 기본적으로 비-2xx에서 예외를 던져 429/503까지 즉시 실패로 만들기 때문에
// throw:false로 받아 상태코드를 직접 판정한다.
export async function requestWithRetry(
	param: RequestUrlParam,
	policy: RetryPolicy = {},
): Promise<RequestUrlResponse> {
	const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const retryDelayMs = policy.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const maxRetryAfterMs = policy.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
	const retryableStatus = policy.retryableStatus ?? DEFAULT_RETRYABLE_STATUS;
	let lastStatus = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const response = await requestUrl({ ...param, throw: false });
		if (retryableStatus.has(response.status)) {
			lastStatus = response.status;
			// 마지막 시도였다면 더 기다릴 필요 없이 루프를 빠져나간다.
			if (attempt < maxAttempts - 1) {
				await delay(parseRetryAfter(response.headers, maxRetryAfterMs) ?? retryDelayMs);
			}
			continue;
		}
		if (response.status >= 400) {
			throw new HttpRequestError(param.url, response.status, false, attempt + 1);
		}
		return response;
	}

	throw new HttpRequestError(param.url, lastStatus, true, maxAttempts);
}

// 응답이 정상 XML인지 확인한다. 차단 페이지나 잘린 응답을 파싱하면 요소가 0개로
// 나오는데, 이걸 "결과 없음"과 구별하지 못하면 조용히 빈 결과를 반환하게 된다.
export function parseXmlOrThrow(xmlText: string, sourceLabel: string): Document {
	const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length > 0) {
		throw new ResponseParseError(sourceLabel, 'response was not well-formed XML');
	}
	return doc;
}

// 값이 모두 비어있지 않은지 확인한다. 하나라도 없으면 호출자가 그 항목을 건너뛴다
// (전체를 실패로 만들지 않는다).
export function hasRequiredFields(...values: (string | undefined | null)[]): boolean {
	return values.every((value) => value !== undefined && value !== null && value.length > 0);
}

// 실패해도 무방한 작업을 감싸 예외를 삼킨다. 없어도 결과 자체는 유효한 선택적 작업에
// 쓴다 — 무엇이 선택적인지는 호출자가 판단한다.
export async function runQuietly(task: () => Promise<void>): Promise<void> {
	try {
		await task();
	} catch {
		// 의도적으로 무시 — 이 작업의 실패는 전체의 실패가 아니다.
	}
}
