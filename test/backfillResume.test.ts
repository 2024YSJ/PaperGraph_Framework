// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// 수 시간짜리 backfill이 중간에 끊겼을 때(절전·강제 종료·재시도 소진) 다음 실행이
// 처음부터 다시 훑던 문제. 라운드가 끝날 때마다 진행 지점을 BackfillProgress.json에
// 남기고, 같은 구간을 다시 요청하면 그 지점부터 이어받는다.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { CollectAndSave } from '../src/collect/CollectAndSave';
import { Embedding } from '../src/collect/Embedding';
import { File, type BackfillProgressRecord } from '../src/common/File';
import { mockRequests, recordedRequests, response } from './stubs/obsidian';
import { entries, feed, installDomParser, queryParams, withFastTimers } from './helpers/arxivFixtures';
import { VaultStub } from './helpers/vaultStub';

installDomParser();

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';
const FROM_MS = Date.UTC(2025, 0, 1);
const TO_MS = Date.UTC(2025, 0, 31);

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
});

// 임베딩은 이 테스트의 관심사가 아니라 항상 성공하는 대역으로 둔다.
function fakeEmbedding(): Embedding {
	return {
		isModelInstalled: () => Promise.resolve(true),
		resetCircuitBreaker: () => undefined,
		breakerCooldownRemainingMs: 0,
		embed: () =>
			Promise.resolve({
				embedding: [0.1, 0.2],
				embeddingModel: 'stub',
				embeddingSource: 'local',
				embeddingSucceeded: true,
			}),
	} as unknown as Embedding;
}

function writeSubscriptions(queries: string[]): void {
	vault.files.set(
		`${PLUGIN_DIR}/Subscriptions.json`,
		JSON.stringify({
			apis: queries.map((query) => ({
				apiName: 'arxiv',
				querys: [{ searchType: 'keyword', query }],
			})),
		}),
	);
}

function flow(): CollectAndSave {
	const instance = new CollectAndSave();
	instance.embedding = fakeEmbedding();
	return instance;
}

function progressRecords(): BackfillProgressRecord[] {
	const raw = vault.files.get(`${PLUGIN_DIR}/BackfillProgress.json`);
	return raw === undefined ? [] : (JSON.parse(raw) as BackfillProgressRecord[]);
}

// 나간 arXiv 요청들의 submittedDate 구간 시작(YYYYMMDDHHmm) 목록.
function requestedFroms(): string[] {
	return recordedRequests()
		.filter((r) => !r.url.includes('semanticscholar'))
		.map((r) => {
			const query = decodeURIComponent(r.url).replace(/\+/g, ' ');
			return /submittedDate:\[(\d{12}) TO /.exec(query)?.[1] ?? '';
		});
}

// 라운드 하나(MAX_PAGES=20 × PAGE_SIZE=100 = 2000건)를 꽉 채운 뒤, 다음 라운드의 첫
// 요청에서 500을 돌려준다 — "한 라운드는 끝냈고 그 다음에 끊겼다"를 만든다.
function failAfterFirstRound(): void {
	let round = 0;
	let pagesInRound = 0;
	mockRequests((param) => {
		if (param.url.includes('semanticscholar')) {
			return response(200, '[]');
		}
		const start = Number(queryParams(param.url).get('start'));
		if (start === 0 && pagesInRound > 0) {
			round += 1;
			pagesInRound = 0;
		}
		if (round > 0) {
			return response(500, 'boom');
		}
		pagesInRound += 1;
		// totalResults를 충분히 크게 줘 라운드가 상한(MAX_PAGES)에 걸리게 한다.
		return response(200, feed(entries(100, start), 50_000));
	});
}

describe('backfill 진행 지점 저장', () => {
	it('라운드가 끝나면 진행 지점을 남긴다 — 실패해도 남아 있다', async () => {
		writeSubscriptions(['graph']);
		failAfterFirstRound();

		await withFastTimers(() => flow().run('backfill', { from: FROM_MS, to: TO_MS })).catch(
			() => undefined,
		);

		const records = progressRecords();
		assert.equal(records.length, 1, '진행 지점이 저장되지 않았다');
		const record = records[0] as BackfillProgressRecord;
		assert.equal(record.apiName, 'arxiv');
		assert.equal(record.from, FROM_MS);
		assert.equal(record.to, TO_MS);
		assert.ok(
			record.coveredThrough > FROM_MS && record.coveredThrough < TO_MS,
			`이어받기 지점이 구간 밖이다: ${new Date(record.coveredThrough).toISOString()}`,
		);
	});

	it('같은 구간을 다시 실행하면 저장된 지점부터 훑는다', async () => {
		writeSubscriptions(['graph']);
		failAfterFirstRound();
		await withFastTimers(() => flow().run('backfill', { from: FROM_MS, to: TO_MS })).catch(
			() => undefined,
		);
		const resumePoint = (progressRecords()[0] as BackfillProgressRecord).coveredThrough;

		// 두 번째 실행 — 이번엔 바로 끝나는 응답을 준다.
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, feed(entries(1, 9000), 1));
		});
		await withFastTimers(() => flow().run('backfill', { from: FROM_MS, to: TO_MS }));

		const first = requestedFroms()[0];
		const expected = new Date(resumePoint).toISOString().slice(0, 16).replace(/[-T:]/g, '');
		assert.equal(first, expected, '요청 구간이 처음(from)으로 되돌아갔다 — 이어받지 않았다');
	});

	it('구간을 끝까지 훑으면 기록을 지운다 — 다음 실행이 0편으로 끝나지 않게', async () => {
		writeSubscriptions(['graph']);
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, feed(entries(1), 1));
		});

		await withFastTimers(() => flow().run('backfill', { from: FROM_MS, to: TO_MS }));

		assert.deepEqual(progressRecords(), []);
	});

	it('다른 구간을 요청하면 저장된 지점을 쓰지 않는다', async () => {
		writeSubscriptions(['graph']);
		failAfterFirstRound();
		await withFastTimers(() => flow().run('backfill', { from: FROM_MS, to: TO_MS })).catch(
			() => undefined,
		);
		assert.equal(progressRecords().length, 1);

		const otherFrom = Date.UTC(2024, 0, 1);
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, feed(entries(1, 9000), 1));
		});
		await withFastTimers(() => flow().run('backfill', { from: otherFrom, to: TO_MS }));

		assert.equal(requestedFroms()[0], '202401010000');
	});

	it('구간 밖(수동 편집 등)의 저장값은 무시한다', () => {
		const records: BackfillProgressRecord[] = [
			{
				apiName: 'arxiv',
				querys: [{ searchType: 'keyword', query: 'graph' }],
				from: FROM_MS,
				to: TO_MS,
				coveredThrough: TO_MS + 86_400_000,
				updatedAt: 0,
			},
		];
		const resume = File.findBackfillResumePoint(
			records,
			'arxiv',
			[{ searchType: 'keyword', query: 'graph' }],
			FROM_MS,
			TO_MS,
		);
		assert.equal(resume, undefined);
	});
});

describe('수집 커서는 구독이 끝나는 즉시 저장된다', () => {
	it('두 번째 구독이 시작될 때 첫 구독의 커서가 이미 파일에 있다', async () => {
		writeSubscriptions(['graph', 'vision']);
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, feed(entries(1), 1));
		});

		let cursorAtSecondStart: number | undefined;
		await withFastTimers(() =>
			flow().run('recent', undefined, undefined, undefined, (_api, index) => {
				if (index === 1) {
					const raw = vault.files.get(`${PLUGIN_DIR}/Subscriptions.json`) ?? '{}';
					const data = JSON.parse(raw) as { apis?: { updateTime?: number }[] };
					cursorAtSecondStart = data.apis?.[0]?.updateTime;
				}
			}),
		);

		assert.ok(
			cursorAtSecondStart !== undefined && cursorAtSecondStart > 0,
			'첫 구독이 끝났는데도 커서가 실행이 다 끝날 때까지 저장되지 않았다',
		);
	});
});
