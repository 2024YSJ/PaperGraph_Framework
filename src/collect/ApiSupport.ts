import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { Log } from '../common/Log';

// 외부 HTTP API를 호출할 때 쓰는 범용 도구 모음.
//
// 이 파일은 어떤 서비스를 부르는지, 응답으로 무엇을 만드는지 모른다. 특정 API에
// 맞춘 값(재시도 간격 등)은 상수로 박지 않고 호출자가 RetryPolicy로 주입한다 —
// 여기에 한 서비스의 사정이 스며들기 시작하면 다음 서비스는 이 파일을 쓸 수 없다.
// 도메인별 실패 처리 정책은 그 도메인 쪽(예: collect/API.ts)에 적는다.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000; // 서버가 비상식적으로 긴 Retry-After를 줘도 여기서 자른다
// 응답이 영영 안 오는 요청을 끊는 기본 시한. Obsidian requestUrl에는 타임아웃 옵션이
// 아예 없어서(RequestUrlParam에 필드가 없다) 이게 없으면 Promise가 영원히 안 풀린다 —
// 에러도 없이 호출자가 멈춘다.
const DEFAULT_TIMEOUT_MS = 60_000;

// 타임아웃을 상태코드로 표현하기 위한 내부 값. 실제 HTTP 코드가 아니라, 재시도 판정과
// 로그가 다른 실패와 같은 경로를 타게 하려고 쓰는 표식이다. 504(Gateway Timeout)를
// 재사용하지 않는 이유는 "서버가 504를 줬다"와 "서버가 응답 자체를 안 했다"를 로그에서
// 구별할 수 있어야 하기 때문이다.
export const STATUS_CLIENT_TIMEOUT = -1;

// 일시적 장애로 보고 재시도할 상태코드의 기본값.
// - 429: rate limit
// - 503: 과부하/스로틀. 이걸 빼면 스로틀이 곧바로 "실패"가 되어버린다.
// - 502/504: 게이트웨이 계열 일시 장애
// - STATUS_CLIENT_TIMEOUT: 응답 없음. 스로틀 중인 서버가 연결만 잡아두는 경우가 있어
//   일시적 장애로 본다.
const DEFAULT_RETRYABLE_STATUS: ReadonlySet<number> = new Set([
	STATUS_CLIENT_TIMEOUT,
	429,
	502,
	503,
	504,
]);

// 재시도 동작을 호출자가 조절하는 값들. 전부 선택이며, 주지 않으면 위 기본값을 쓴다.
// 서비스마다 권장 호출 간격이나 스로틀 코드가 다르므로 호출부가 자기 정책을 들고 온다.
export interface RetryPolicy {
	maxAttempts?: number;
	retryDelayMs?: number;
	maxRetryAfterMs?: number;
	retryableStatus?: ReadonlySet<number>;
	// 한 번의 시도가 이 시간을 넘기면 포기하고 다음 시도로 넘어간다.
	timeoutMs?: number;
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
		// 타임아웃은 서버가 준 코드가 아니라 우리가 붙인 표식이라, "HTTP -1"로 보이면
		// 원인을 오해하게 된다.
		const what = status === STATUS_CLIENT_TIMEOUT ? '응답 없음(timeout)' : `HTTP ${status}`;
		super(
			exhausted ? `${url} -> ${what} (temporary) after ${attempts} attempts` : `${url} -> ${what}`,
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

// 한 번의 요청에 시한을 건다.
//
// ⚠️ requestUrl에는 취소 수단이 없다(AbortSignal도 timeout 옵션도 받지 않는다). 그래서
// 시한이 지나도 원 요청은 백그라운드에 그대로 남아 언젠가 끝난다 — 여기서 하는 일은
// "호출자를 풀어주는 것"뿐이고, 남은 요청을 회수하지는 못한다. 그래도 이게 없으면
// 응답 없는 요청 하나가 수집 파이프라인 전체를 영원히 세운다.
//
// 타임아웃을 예외가 아니라 가짜 응답(STATUS_CLIENT_TIMEOUT)으로 돌려주는 이유는
// 호출부의 재시도 판정을 상태코드 하나로 통일해두기 위해서다 — 예외로 만들면
// requestWithRetry가 상태코드 경로와 예외 경로를 따로 관리해야 한다.
async function requestWithTimeout(
	param: RequestUrlParam,
	timeoutMs: number,
): Promise<RequestUrlResponse> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<RequestUrlResponse>((resolve) => {
		timer = setTimeout(
			() => resolve({ status: STATUS_CLIENT_TIMEOUT, headers: {} } as RequestUrlResponse),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([requestUrl({ ...param, throw: false }), timeout]);
	} finally {
		// 요청이 먼저 끝났으면 타이머를 치운다 — 안 그러면 마지막 요청 뒤로 timeoutMs만큼
		// 프로세스에 살아있는 타이머가 남는다.
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
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
	const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let lastStatus = 0;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const startedAt = Date.now();
		const response = await requestWithTimeout(param, timeoutMs);
		const elapsedMs = Date.now() - startedAt;
		if (retryableStatus.has(response.status)) {
			lastStatus = response.status;
			const retryAfterMs = parseRetryAfter(response.headers, maxRetryAfterMs);
			const waitMs = retryAfterMs ?? retryDelayMs;
			// 마지막 시도였다면 더 기다릴 필요 없이 루프를 빠져나간다.
			const willRetry = attempt < maxAttempts - 1;
			const label =
				response.status === STATUS_CLIENT_TIMEOUT
					? `응답 없음 — ${timeoutMs}ms 안에 안 와서 끊음`
					: `HTTP ${response.status} — 일시적 장애로 판정`;
			Log.warn('http.retry', label, {
				url: param.url,
				attempt: attempt + 1,
				maxAttempts,
				elapsedMs,
				retryAfterHeaderMs: retryAfterMs,
				waitMs: willRetry ? waitMs : 0,
				willRetry,
			});
			if (willRetry) {
				await delay(waitMs);
			}
			continue;
		}
		if (response.status >= 400) {
			Log.error('http.fail', `HTTP ${response.status} — 재시도 불가`, undefined, {
				url: param.url,
				attempt: attempt + 1,
				elapsedMs,
			});
			throw new HttpRequestError(param.url, response.status, false, attempt + 1);
		}
		if (attempt > 0) {
			Log.info('http.retry', '재시도 끝에 성공', {
				url: param.url,
				attempt: attempt + 1,
				elapsedMs,
			});
		}
		return response;
	}

	Log.error(
		'http.fail',
		`${lastStatus === STATUS_CLIENT_TIMEOUT ? '응답 없음(timeout)' : `HTTP ${lastStatus}`} — 재시도 ${maxAttempts}회 소진`,
		undefined,
		{ url: param.url, maxAttempts },
	);
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
//
// 삼키되 흔적은 남긴다. 예외가 정말로 흔적 없이 사라지면 "왜 인용수가 계속 비어 있지?"를
// 밖에서 확인할 방법이 없어진다. label은 어느 작업이었는지 알려주는 이름.
export async function runQuietly(task: () => Promise<void>, label = 'unnamed'): Promise<void> {
	try {
		await task();
	} catch (error) {
		// 의도적으로 무시 — 이 작업의 실패는 전체의 실패가 아니다.
		Log.warn('quiet', `선택적 작업 실패(무시됨): ${label}`, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
