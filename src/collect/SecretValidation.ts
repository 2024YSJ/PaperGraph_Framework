import { HttpRequestError, requestWithRetry } from './ApiSupport';
import { S2_SECRET_PROVIDER } from './API';
import type { Secret } from './Secret';

// API 키가 늘어날 걸 대비한 검증 레지스트리. provider마다 "가벼운 요청을 실제로
// 날려본다"가 유일하게 신뢰할 수 있는 방법이다 — 키 형식만으로는 어떤 provider의
// 키인지, 혹은 유효한지 판단할 수 없다(provider마다 임의 문자열이라 정규식으로
// 확정하기 어렵고, 우연히 형식이 겹칠 수 있다).

export interface KeyValidationResult {
	provider: string;
	valid: boolean;
	// 실패 원인 구분 — UI가 "키가 틀렸다" vs "일시적 문제다"를 다르게 안내할 수 있게.
	reason?: 'invalid-key' | 'network-error';
	detail?: string;
}

// provider마다 등록하는 "가벼운 검증 호출". 실제 수집에 쓰는 무거운 배치 조회 대신
// 저비용 엔드포인트로 키 유효성만 확인한다.
export interface KeyValidator {
	provider: string; // Secret의 provider 키와 동일 체계(S2_SECRET_PROVIDER 등)
	label: string; // 설정 탭 드롭다운에 보여줄 사람이 읽는 이름
	validate(key: string): Promise<KeyValidationResult>;
}

// S2는 잘못된/만료된 키에 401 또는 403으로 응답한다(문서화된 값이 아니라 관측 기반이라
// 둘 다 받는다). requestWithRetry가 이미 이 상태코드들을 "재시도 불가"로 던지므로
// (DEFAULT_RETRYABLE_STATUS에 없음), HttpRequestError.status만 보면 된다.
const S2_INVALID_KEY_STATUS = new Set([401, 403]);

// 배치 조회(S2_BATCH_ENDPOINT)를 그대로 쓰지 않는다 — 검증은 "키가 통하는지"만 확인하면
// 되므로, 논문 조회 자체가 필요 없는 가장 가벼운 엔드포인트(빈 검색 1건)를 쓴다.
const S2_VALIDATION_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1';

export const S2_KEY_VALIDATOR: KeyValidator = {
	provider: S2_SECRET_PROVIDER,
	label: 'Semantic Scholar',
	async validate(key: string): Promise<KeyValidationResult> {
		try {
			// maxAttempts: 1 — 검증은 재시도할 필요가 없다. 401/403은 몇 번을 다시 불러도
			// 401/403이고, requestWithRetry의 기본 재시도 대상(429/502/503/504/timeout)도
			// 아니라 어차피 재시도되지 않는다. 명시적으로 1로 둬 의도를 드러낸다.
			await requestWithRetry(
				{ url: S2_VALIDATION_ENDPOINT, method: 'GET', headers: { 'x-api-key': key } },
				{ maxAttempts: 1 },
			);
			return { provider: S2_SECRET_PROVIDER, valid: true };
		} catch (error) {
			if (error instanceof HttpRequestError && S2_INVALID_KEY_STATUS.has(error.status)) {
				return { provider: S2_SECRET_PROVIDER, valid: false, reason: 'invalid-key' };
			}
			return {
				provider: S2_SECRET_PROVIDER,
				valid: false,
				reason: 'network-error',
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

// 검증기 레지스트리 — File.ts의 API_FACTORIES와 같은 모양이다. 새 provider(다른 논문
// API, 유료 AI API 등)가 생기면 여기 한 줄만 추가하면 된다. arXiv는 키가 필요 없어
// 검증 대상이 아니다.
export const KEY_VALIDATORS: KeyValidator[] = [S2_KEY_VALIDATOR];

// 이 키가 어떤 provider의 것인지 판별한다. 등록된 검증기에 순서대로 물어보고
// valid:true가 나온 첫 provider를 채택한다. 형식 검사로는 판별할 수 없으므로
// 이 방법(실제 호출)이 유일하게 신뢰할 수 있는 경로다.
export async function identifyKeyProvider(
	key: string,
	validators: KeyValidator[] = KEY_VALIDATORS,
): Promise<string | undefined> {
	for (const validator of validators) {
		const result = await validator.validate(key);
		if (result.valid) {
			return validator.provider;
		}
	}
	return undefined;
}

// Secret에 등록된 키 전체를 점검한다. provider별로 키가 없으면 건너뛴다(등록 안 된
// provider는 검증 대상이 아니다 — arXiv처럼 키 자체가 없는 경우와 같은 취급).
export async function validateAllKeys(
	secret: Secret,
	validators: KeyValidator[] = KEY_VALIDATORS,
): Promise<KeyValidationResult[]> {
	const results: KeyValidationResult[] = [];
	for (const validator of validators) {
		const key = secret.getKey(validator.provider);
		if (key === undefined) {
			continue;
		}
		results.push(await validator.validate(key));
	}
	return results;
}
