// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// 절전/네트워크 단절에서 깨어난 직후를 재현한다. requestUrl은 throw:false를 줘도 전송
// 계층 실패(연결 끊김/DNS 실패)는 reject하는데, 예전에는 그 예외가 재시도 루프를 그대로
// 뚫고 나가 재시도 0회로 구독이 죽었다 — 깨자마자 남은 구독이 전부 즉시 실패하고 수집이
// 끝나 있던 QA 재현의 원인.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	HttpRequestError,
	STATUS_NETWORK_ERROR,
	describeFailure,
	requestWithRetry,
} from '../src/collect/ApiSupport';
import { mockRequests, recordedRequests, response } from './stubs/obsidian';
import { withFastTimers } from './helpers/arxivFixtures';

const URL = 'https://example.test/api';

// 백오프가 실제로 3s~60s를 기다리므로 타이머를 0으로 접어 돌린다.
function run<T>(work: () => Promise<T>): Promise<T> {
	return withFastTimers(work);
}

describe('requestWithRetry — 전송 계층 실패(절전 복귀 등)', () => {
	it('연결 실패는 재시도한다 — 예전엔 재시도 없이 그대로 위로 던졌다', async () => {
		let calls = 0;
		mockRequests(() => {
			calls += 1;
			if (calls <= 2) {
				throw new Error('net::ERR_INTERNET_DISCONNECTED');
			}
			return response(200, 'ok');
		});

		const result = await run(() => requestWithRetry({ url: URL }));

		assert.equal(result.status, 200);
		assert.equal(recordedRequests().length, 3, '연결 실패 뒤 다시 걸지 않았다');
	});

	it('연결 실패 예산을 다 쓰면 NETWORK로 분류된 에러를 던진다', async () => {
		mockRequests(() => {
			throw new Error('net::ERR_NAME_NOT_RESOLVED');
		});

		const error = await run(() =>
			requestWithRetry({ url: URL }).then(
				() => undefined,
				(e: unknown) => e,
			),
		);

		assert.ok(error instanceof HttpRequestError, `HttpRequestError가 아니다: ${String(error)}`);
		assert.equal(error.status, STATUS_NETWORK_ERROR);
		assert.equal(error.exhausted, true);
		// UNKNOWN에 묻히면 로그만 보고는 "왜 죽었는지"를 알 수 없다 — 실제로 QA 로그가
		// [UNKNOWN]으로만 남아 원인 파악이 늦어졌다.
		assert.equal(describeFailure(error).code, 'NETWORK');
	});

	it('연결 실패는 상태코드 재시도 예산(maxAttempts)을 쓰지 않는다', async () => {
		// 깨어나는 동안의 연결 실패가 예산을 다 먹으면, 정작 서버가 429/503을 줄 때
		// 재시도가 남아있지 않게 된다.
		const statuses = [0, 0, 503, 503, 200]; // 0 = 전송 실패
		let calls = 0;
		mockRequests(() => {
			const status = statuses[calls] ?? 200;
			calls += 1;
			if (status === 0) {
				throw new Error('net::ERR_NETWORK_CHANGED');
			}
			return response(status, status === 200 ? 'ok' : 'busy');
		});

		const result = await run(() => requestWithRetry({ url: URL }, { maxAttempts: 3 }));

		assert.equal(result.status, 200);
		assert.equal(recordedRequests().length, 5);
	});

	it('연결 실패 재시도 횟수는 호출자가 조절할 수 있다', async () => {
		mockRequests(() => {
			throw new Error('net::ERR_INTERNET_DISCONNECTED');
		});

		await run(() =>
			requestWithRetry({ url: URL }, { networkMaxAttempts: 2, networkBackoffMs: [1] }).catch(
				() => undefined,
			),
		);

		assert.equal(recordedRequests().length, 2);
	});
});
