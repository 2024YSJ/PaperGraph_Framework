// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { CollectAndSave } from '../src/collect/CollectAndSave';
import { Embedding } from '../src/collect/Embedding';
import { File } from '../src/common/File';
import type { Middleware } from '../src/common/Middleware';
import { Paper } from '../src/collect/Paper';
import { S2_SECRET_PROVIDER } from '../src/collect/API';
import { mockRequests, recordedRequests, response } from './stubs/obsidian';
import {
	entries,
	entry,
	feed,
	installDomParser,
	queryParams,
	withFastTimers,
} from './helpers/arxivFixtures';
import { VaultStub } from './helpers/vaultStub';

// 네트워크(requestUrl)와 Vault만 대역이고 나머지는 전부 실제 코드가 도는 통합 테스트.
// File도 실제 구현을 쓴다 — 커서가 정말 JSON으로 왕복하는지, writePaper가 기존 파일과
// 출처를 병합하는지는 File을 흉내 내면 검증되지 않기 때문이다.

installDomParser();

// 대역 Vault 안의 임의 경로. 실제 플러그인 폴더 위치는 vault.configDir에 따라 달라지지만,
// File은 init()으로 받은 경로를 그대로 쓰므로 테스트에서는 아무 값이나 상관없다.
const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

// Backfill 테스트가 쓰는 구간. 값 자체에 의미는 없고 유효한 범위이기만 하면 된다.
const FROM_MS = Date.UTC(2025, 0, 1);
const TO_MS = Date.UTC(2025, 0, 31);

let vault: VaultStub;

// ── 대역 Embedding ───────────────────────────────────────────────────
// CollectAndSave가 실제로 부르는 세 메서드만 구현한다. embed 호출을 기록해 중복 제거와
// 순차 호출을 검사한다.
interface EmbeddingSpy {
	calls: string[]; // embed에 넘어온 title
	maxConcurrent: number;
	resetCount: number;
	installed: boolean;
	failOn?: (title: string) => boolean;
	// 연속 실패 몇 번에 브레이커가 열리는지, 열리면 남은 쿨다운은 얼마인지.
	// 0이면 아예 안 열린다(대부분의 테스트가 신경 쓸 필요 없는 기본값).
	tripCooldownMs: number;
	// true면 기다려도 안 풀린다(모델이 회복 불가능한 상태). false면 호출자가 쿨다운을
	// 확인하고 기다린 것으로 보고 풀린다 — 실제로는 시간이 지나 끝나는 것인데,
	// withFastTimers가 대기를 0ms로 만들어 시계로는 재현할 수 없다.
	cooldownPersists: boolean;
	// 지금 남은 쿨다운(ms). 테스트가 직접 만질 일은 없다 — 실패가 쌓이면 열린다.
	cooldownMs: number;
}

// 실제 Embedding과 같은 값 (Embedding.FAILURE_LIMIT).
const FAKE_FAILURE_LIMIT = 3;

function fakeEmbedding(overrides: Partial<EmbeddingSpy> = {}): {
	spy: EmbeddingSpy;
	embedding: Embedding;
} {
	const spy: EmbeddingSpy = {
		calls: [],
		maxConcurrent: 0,
		resetCount: 0,
		installed: true,
		tripCooldownMs: 0,
		cooldownPersists: false,
		cooldownMs: 0,
		...overrides,
	};
	let inFlight = 0;
	let consecutiveFailures = 0;

	const embedding = {
		isModelInstalled: () => Promise.resolve(spy.installed),
		resetCircuitBreaker: () => {
			spy.resetCount += 1;
			spy.cooldownMs = 0;
			consecutiveFailures = 0;
		},
		get breakerCooldownRemainingMs(): number {
			const remaining = spy.cooldownMs;
			if (!spy.cooldownPersists) {
				// 호출자가 이 값을 보고 기다릴 것이므로, 그 뒤에는 풀린 상태가 된다.
				spy.cooldownMs = 0;
				consecutiveFailures = 0;
			}
			return remaining;
		},
		embed: async (title: string) => {
			// 브레이커가 열려 있으면 실제 Embedding도 시도조차 않고 즉시 throw한다.
			if (spy.cooldownMs > 0) {
				throw new Error('PaperGraph3D: 임베딩이 반복 실패해 잠시 중단된 상태입니다.');
			}
			inFlight += 1;
			spy.maxConcurrent = Math.max(spy.maxConcurrent, inFlight);
			spy.calls.push(title);
			// 마이크로태스크를 한 번 양보해, 병렬 호출이 있었다면 실제로 겹치게 만든다.
			await Promise.resolve();
			inFlight -= 1;
			if (spy.failOn?.(title) === true) {
				// 연속 실패가 쌓이면 브레이커가 열린다 — 실제 Embedding.recordFailure와 같은 규칙.
				consecutiveFailures += 1;
				if (spy.tripCooldownMs > 0 && consecutiveFailures >= FAKE_FAILURE_LIMIT) {
					spy.cooldownMs = spy.tripCooldownMs;
				}
				throw new Error(`임베딩 실패: ${title}`);
			}
			consecutiveFailures = 0;
			return {
				embedding: [0.1, 0.2, 0.3],
				embeddingModel: 'test-model',
				embeddingSource: 'test',
				embeddingSucceeded: true,
			};
		},
	};
	return { spy, embedding: embedding as unknown as Embedding };
}

// ── 구독 파일 ────────────────────────────────────────────────────────
// run()은 File.readSubscriptions()로 구독을 직접 읽으므로, 대역 API를 주입할 수 없다.
// 대신 Subscriptions.json을 심어 실제 ArxivAPI가 복원되게 하고 네트워크만 대역으로 둔다.
function writeSubscriptionsFile(queries: string[], updateTime?: number): void {
	vault.files.set(
		`${PLUGIN_DIR}/Subscriptions.json`,
		JSON.stringify({
			updateTime,
			apis: queries.map((query) => ({
				apiName: 'arxiv',
				querys: [{ searchType: 'keyword', query }],
			})),
		}),
	);
}

// arXiv 조회엔 주어진 피드로, S2 배치엔 빈 배열로 답한다.
function arxivOnly(atom: string): void {
	mockRequests((param) => {
		if (param.url.includes('semanticscholar')) {
			return response(200, '[]');
		}
		return response(200, atom);
	});
}

function collectFlow(embedding: Embedding, middlewares: Middleware[] = []): CollectAndSave {
	const flow = new CollectAndSave();
	flow.embedding = embedding;
	for (const mw of middlewares) {
		flow.setMiddleware(mw);
	}
	return flow;
}

// 첫 arXiv 요청이 실제로 조회한 날짜 구간(YYYYMMDDHHmm 두 개). 쿼리스트링에서 공백은
// '+'로 인코딩되는데 decodeURIComponent는 '+'를 풀지 않으므로 직접 되돌린다.
function requestedWindow(): { from: string; to: string } {
	const url = recordedRequests().find((r) => !r.url.includes('semanticscholar'))?.url ?? '';
	const query = decodeURIComponent(url).replace(/\+/g, ' ');
	const matched = /submittedDate:\[(\d{12}) TO (\d{12})\]/.exec(query);
	assert.ok(matched !== null, `날짜 구간이 쿼리에 없다: ${query}`);
	return { from: matched[1] ?? '', to: matched[2] ?? '' };
}

function storedSubscriptions(): { updateTime?: number } {
	const raw = vault.files.get(`${PLUGIN_DIR}/Subscriptions.json`);
	assert.ok(raw !== undefined, 'Subscriptions.json이 저장되지 않았다');
	return JSON.parse(raw) as { updateTime?: number };
}

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
});

describe('CollectAndSave.run — 사전 조건', () => {
	it('구독이 없으면 네트워크를 쓰기 전에 멈춘다', async () => {
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await assert.rejects(() => collectFlow(embedding).run('recent'), /등록된 구독이 없습니다/);
		assert.equal(recordedRequests().length, 0);
	});

	it('임베딩 모델이 없으면 수집을 시작조차 하지 않는다', async () => {
		// 모델 미설치는 embed()에서 서킷브레이커를 트립시키지 않아, 그냥 진행하면 논문
		// 수만큼 조용히 실패하며 전부 빈 임베딩으로 저장된다. 그 전에 끊어야 한다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { spy, embedding } = fakeEmbedding({ installed: false });

		await assert.rejects(
			() => collectFlow(embedding).run('recent'),
			/임베딩 모델이 설치되어 있지 않습니다/,
		);
		assert.equal(recordedRequests().length, 0, '수집 요청이 나가면 안 된다');
		assert.equal(spy.calls.length, 0);
	});

	it('Backfill은 구간 없이 부르면 거부한다 — 범위 지정이 본질이라 기본값을 지어내지 않는다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await assert.rejects(
			() => collectFlow(embedding).run('backfill'),
			/수집할 구간\(from\/to\)이 필요합니다/,
		);
		assert.equal(recordedRequests().length, 0);
	});

	it('Backfill 구간이 NaN이면 요청 전에 거부한다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await assert.rejects(
			() => collectFlow(embedding).run('backfill', { from: Number.NaN, to: Date.now() }),
			/수집할 구간\(from\/to\)이 필요합니다/,
		);
		assert.equal(recordedRequests().length, 0);
	});
});

// 중복 제거는 run()의 책임이 아니라 'all' 미들웨어로 붙는다(별도 담당자). 여기서는
// run()이 그 미들웨어가 기대는 계약을 실제로 지키는지만 검증한다.
describe('CollectAndSave.run — 중복 제거 확장 지점', () => {
	it('run()은 스스로 목록에서 중복을 빼지 않는다 — 같은 논문이 두 번 들어오면 두 번 다 저장 경로를 탄다', async () => {
		// 구독 2개가 같은 응답을 받는다 = 같은 sourceId가 두 번 들어온다. 이 목록 자체를
		// 줄이는(splice) 건 미들웨어 몫이라, run()이 그걸 대신 하고 있지 않은지 확인한다.
		// (embed() 호출 횟수는 검증하지 않는다 — 두 번째 논문은 B-2 재사용 경로로 인해
		// 방금 이 실행에서 저장된 벡터를 그대로 쓰므로 embed()가 다시 불리지 않는 게 정상.)
		writeSubscriptionsFile(['graph', 'network']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent', { hours: 24 });

		// 같은 sourceId라 저장 경로가 같아 파일은 하나이고, 출처는 writePaper가 병합한다 —
		// 이 병합이 일어나려면 두 번째 논문도 writePaper까지 도달해야 한다(목록에서 안 빠짐).
		assert.equal(vault.storedPapers().length, 1);
		assert.deepEqual(vault.storedPapers()[0]?.paper.collectedApis, ['arxiv', 'arxiv']);
	});

	it("'all' 미들웨어가 배열을 in-place로 줄이면 이후 임베딩·저장이 줄어든 목록을 본다", async () => {
		// 중복 제거 미들웨어가 의존할 계약. Middleware.run은 void를 반환하므로 새 배열을
		// 돌려줄 수 없고, 받은 배열을 직접 수정하는 방법뿐이다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(4), 4));
		const { spy, embedding } = fakeEmbedding();

		const dropOdd: Middleware = {
			type: 'all',
			run: (context) => {
				const papers = context as Paper[];
				// 짝수 번째만 남긴다 — 실제 중복 제거가 splice로 하는 일과 같은 형태.
				const kept = papers.filter((_, i) => i % 2 === 0);
				papers.splice(0, papers.length, ...kept);
			},
		};

		await collectFlow(embedding, [dropOdd]).run('recent', { hours: 24 });

		assert.deepEqual(spy.calls, ['Paper 0', 'Paper 2'], '미들웨어가 덜어낸 논문까지 임베딩했다');
		assert.equal(vault.storedPapers().length, 2, '덜어낸 논문이 저장됐다');
	});

	it('미들웨어가 없으면 수집된 논문이 그대로 전부 처리된다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(3), 3));
		const { spy, embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent', { hours: 24 });

		assert.equal(spy.calls.length, 3);
		assert.equal(vault.storedPapers().length, 3);
	});
});

// 4일 재스캔 창 때문에 recent 수집은 최근 논문을 매번 다시 훑는다. 이 두 문제는 실기기
// 테스트에서 실제로 재현됐다: 임베딩 실패가 어제 성공한 벡터를 지우고(B-1), 같은 논문을
// 실행마다 다시 임베딩해 낭비가 컸다(B-2). 둘 다 embedOrReuse()가 저장본을 먼저 확인해서
// 해결한다 — B-1은 File.writePaperAt의 보존 규칙(백스톱)까지 이중으로 막는다.
describe('CollectAndSave.run — 저장본 재사용/보존 (B-1, B-2)', () => {
	it('이미 임베딩된 논문은 다시 임베딩하지 않고 기존 벡터를 재사용한다 (B-2)', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { spy: spy1, embedding: embedding1 } = fakeEmbedding();
		await collectFlow(embedding1).run('recent', { hours: 24 });
		assert.equal(spy1.calls.length, 1, '첫 실행은 정상적으로 임베딩해야 한다');

		// 같은 논문을 다시 수집 — 같은 sourceId라 저장본이 이미 있다.
		arxivOnly(feed([entry()], 1));
		const { spy: spy2, embedding: embedding2 } = fakeEmbedding();
		await collectFlow(embedding2).run('recent', { hours: 24 });

		assert.equal(spy2.calls.length, 0, '이미 성공한 논문을 또 임베딩했다 — 재작업 낭비');
		assert.deepEqual(vault.storedPapers()[0]?.paper.embedding, [0.1, 0.2, 0.3]);
		assert.equal(vault.storedPapers()[0]?.paper.embeddingSucceeded, true);
	});

	it('저장본이 실패 상태면 다시 임베딩한다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding: failing } = fakeEmbedding({ failOn: () => true });
		await collectFlow(failing).run('recent', { hours: 24 });
		assert.equal(vault.storedPapers()[0]?.paper.embeddingSucceeded, false);

		arxivOnly(feed([entry()], 1));
		const { spy, embedding } = fakeEmbedding();
		await collectFlow(embedding).run('recent', { hours: 24 });

		assert.equal(spy.calls.length, 1, '실패 상태였던 논문은 재시도해야 한다');
		assert.equal(vault.storedPapers()[0]?.paper.embeddingSucceeded, true);
	});

	it('임베딩이 실패해도 어제 성공했던 벡터를 지우지 않는다 (B-1)', async () => {
		// 첫 실행: 정상 임베딩 성공.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding: ok } = fakeEmbedding();
		await collectFlow(ok).run('recent', { hours: 24 });
		assert.deepEqual(vault.storedPapers()[0]?.paper.embedding, [0.1, 0.2, 0.3]);

		// 두 번째 실행에서 모델이 죽었다고 가정 — embedOrReuse가 저장본 확인 전에
		// isModelInstalled() 사전 체크를 통과해야 여기까지 온다는 전제이므로, 모델은
		// "설치됨"으로 두고 embed() 자체가 실패하는 시나리오로 재현한다.
		arxivOnly(feed([entry()], 1));
		const { embedding: failing } = fakeEmbedding({ installed: true, failOn: () => true });
		// 저장본이 이미 성공 상태이므로 embedOrReuse는 애초에 embed()를 부르지 않는다 —
		// 이 케이스는 File.writePaperAt의 보존 규칙(백스톱)이 아니라 재사용 경로가 막는다.
		await collectFlow(failing).run('recent', { hours: 24 });

		assert.deepEqual(
			vault.storedPapers()[0]?.paper.embedding,
			[0.1, 0.2, 0.3],
			'성공했던 벡터가 실패로 덮였다',
		);
		assert.equal(vault.storedPapers()[0]?.paper.embeddingSucceeded, true);
	});
});

describe('CollectAndSave.run — 미들웨어 실패 격리', () => {
	it("'all' 미들웨어가 throw해도 이후 임베딩·저장·커서 갱신이 계속된다", async () => {
		// testOptions.hours는 테스트 경로라 커서를 안 건드린다 — 커서 갱신까지 검증하려면
		// 운영 경로(인자 없는 recent)로 불러야 한다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { spy, embedding } = fakeEmbedding();
		const broken: Middleware = {
			type: 'all',
			run: () => {
				throw new Error('중복 제거 버그');
			},
		};

		const before = Date.now();
		await collectFlow(embedding, [broken]).run('recent');
		const after = Date.now();

		assert.equal(spy.calls.length, 1, "'all' 실패로 이후 단계가 멈췄다");
		assert.equal(vault.storedPapers().length, 1);
		const updateTime = storedSubscriptions().updateTime;
		assert.ok(
			updateTime !== undefined && updateTime >= before && updateTime <= after,
			'커서 갱신도 멈췄다',
		);
	});

	it("'forEach' 미들웨어가 특정 논문에서 throw해도 나머지 논문은 계속 저장된다", async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(3), 3));
		const { embedding } = fakeEmbedding();
		const brokenOnSecond: Middleware = {
			type: 'forEach',
			run: (context) => {
				if ((context as Paper).title === 'Paper 1') {
					throw new Error('미들웨어 버그');
				}
			},
		};

		await collectFlow(embedding, [brokenOnSecond]).run('recent', { hours: 24 });

		assert.equal(vault.storedPapers().length, 3, '실패한 논문 하나 때문에 나머지까지 저장이 안 됐다');
	});
});

describe('CollectAndSave.run — 임베딩 계약', () => {
	it('논문을 순차로만 임베딩한다 — embed()는 동시 호출에 안전하지 않다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(5), 5));
		const { spy, embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent', { hours: 24 });

		assert.equal(spy.calls.length, 5);
		assert.equal(spy.maxConcurrent, 1, 'embed()가 동시에 두 번 이상 실행됐다');
	});

	it('배치 시작 시 서킷브레이커를 초기화한다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { spy, embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent', { hours: 24 });

		assert.equal(spy.resetCount, 1);
	});

	it('임베딩이 실패해도 논문은 저장한다 — 실패 사실이 디스크에 남아야 나중에 찾을 수 있다', async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(3), 3));
		const { embedding } = fakeEmbedding({ failOn: (title) => title === 'Paper 1' });

		await collectFlow(embedding).run('recent', { hours: 24 });

		const stored = vault.storedPapers();
		assert.equal(stored.length, 3, '실패한 논문이 저장에서 빠졌다');

		const failed = stored.find((s) => s.paper.title === 'Paper 1');
		assert.equal(failed?.paper.embeddingSucceeded, false);
		assert.deepEqual(failed?.paper.embedding, [], '실패했는데 가짜 벡터가 들어갔다');
		assert.equal(failed?.paper.embeddingModel, '');

		const ok = stored.find((s) => s.paper.title === 'Paper 0');
		assert.equal(ok?.paper.embeddingSucceeded, true);
		assert.deepEqual(ok?.paper.embedding, [0.1, 0.2, 0.3]);
	});
});

describe('CollectAndSave.run — 미들웨어', () => {
	it("'all'은 전체 목록으로 한 번, 'forEach'는 논문마다 한 번 실행된다", async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed(entries(3), 3));
		const { embedding } = fakeEmbedding();

		const allContexts: unknown[] = [];
		const eachContexts: unknown[] = [];
		const all: Middleware = {
			type: 'all',
			run: (context) => {
				allContexts.push(context);
			},
		};
		const each: Middleware = {
			type: 'forEach',
			run: (context) => {
				eachContexts.push(context);
			},
		};

		await collectFlow(embedding, [all, each]).run('recent', { hours: 24 });

		assert.equal(allContexts.length, 1);
		assert.equal((allContexts[0] as Paper[]).length, 3, "'all'은 Paper[] 전체를 받아야 한다");
		assert.equal(eachContexts.length, 3);
	});

	it("수집 결과가 0편이어도 'all'은 빈 배열로 호출된다", async () => {
		// 설정탭이 "N편 수집" Notice를 이 호출 하나로 관측한다 — 0편일 때 'all'이 아예
		// 안 불리면, 실패도 아닌데 성공 Notice에 건수가 안 붙어 사용자가 원인을 알 수 없다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([], 0));
		const { embedding } = fakeEmbedding();

		const allContexts: unknown[] = [];
		const all: Middleware = {
			type: 'all',
			run: (context) => {
				allContexts.push(context);
			},
		};

		await collectFlow(embedding, [all]).run('recent', { hours: 24 });

		assert.equal(allContexts.length, 1);
		assert.deepEqual(allContexts[0], []);
	});

	it("'visual' 미들웨어는 수집 흐름에서 실행되지 않는다", async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		let visualRuns = 0;
		const visual: Middleware = {
			type: 'visual',
			run: () => {
				visualRuns += 1;
			},
		};

		await collectFlow(embedding, [visual]).run('recent', { hours: 24 });

		assert.equal(visualRuns, 0);
	});

	it("'forEach'는 임베딩 후 · 저장 전에 실행된다", async () => {
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		// 미들웨어가 논문을 고치면 그 값이 디스크에 반영돼야 한다(= 저장보다 먼저 돈다).
		// 동시에 임베딩 결과도 이미 붙어 있어야 한다(= 임베딩보다 나중에 돈다).
		let sawEmbedding: unknown;
		const each: Middleware = {
			type: 'forEach',
			run: (context) => {
				const paper = context as Paper;
				sawEmbedding = paper.embedding;
				paper.title = `[검토됨] ${paper.title}`;
			},
		};

		await collectFlow(embedding, [each]).run('recent', { hours: 24 });

		assert.deepEqual(sawEmbedding, [0.1, 0.2, 0.3], '미들웨어가 임베딩 전에 실행됐다');
		assert.equal(vault.storedPapers()[0]?.paper.title, '[검토됨] A Test Paper');
	});
});

describe('CollectAndSave.run — 커서', () => {
	it('recent 수집을 마치면 커서를 훑은 구간의 끝으로 옮긴다', async () => {
		writeSubscriptionsFile(['graph'], Date.now() - 60 * 60 * 1000);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		const before = Date.now();
		await collectFlow(embedding).run('recent');
		const after = Date.now();

		const updateTime = storedSubscriptions().updateTime;
		assert.ok(updateTime !== undefined && updateTime >= before && updateTime <= after);
	});

	it('커서가 없는 첫 실행도 1970년이 아니라 최근 구간을 훑는다', async () => {
		// 커서 0에 보정 창을 그냥 빼면 음수 epoch이 되어 상한에 걸린 "가장 오래된 2000편"을
		// 가져오게 된다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent');

		const fromYear = Number(requestedWindow().from.slice(0, 4));
		assert.ok(fromYear >= new Date().getFullYear() - 1, `첫 실행이 ${fromYear}년부터 훑는다`);
	});

	it('첫 실행의 폭은 24시간이 아니라 API가 선언한 재스캔 창(4일)과 같다', async () => {
		// "최근"의 개념을 24시간에서 4일로 통일했다 — 첫 실행과 재스캔이 같은 폭을 쓴다
		// (API.recentRescanWindowMs). 다른 값을 억지로 도입하지 않았는지 확인한다.
		writeSubscriptionsFile(['graph']);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		const before = Date.now();
		await collectFlow(embedding).run('recent');
		const after = Date.now();

		const { from, to } = requestedWindow();
		const widthMs = Date.UTC(
			Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)),
			Number(to.slice(8, 10)), Number(to.slice(10, 12)),
		) - Date.UTC(
			Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)),
			Number(from.slice(8, 10)), Number(from.slice(10, 12)),
		);
		const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
		// 쿼리 문자열은 분 단위까지만(YYYYMMDDHHmm) 실려 양쪽 절삭 오차가 최대 ~2분 생긴다.
		assert.ok(
			Math.abs(widthMs - fourDaysMs) < 120_000,
			`첫 실행 폭이 4일이 아니다: ${widthMs}ms (테스트 실행 시간: ${after - before}ms)`,
		);
	});

	it('커서가 있으면 그보다 4일 뒤로 물러난 지점부터 훑는다 — 색인 지연 보정', async () => {
		const cursor = Date.UTC(2025, 5, 20, 12, 0, 0);
		writeSubscriptionsFile(['graph'], cursor);
		arxivOnly(feed([], 0));
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent');

		// 커서(6/20)에서 4일 물러난 6/16부터여야 한다.
		assert.equal(requestedWindow().from.slice(0, 8), '20250616');
	});

	it('범위를 직접 준 테스트 경로는 운영 커서를 건드리지 않는다', async () => {
		const cursor = Date.now() - 7 * 24 * 60 * 60 * 1000;
		writeSubscriptionsFile(['graph'], cursor);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).run('recent', { hours: 24 });

		assert.equal(storedSubscriptions().updateTime, cursor);
	});

	it('backfill은 커서를 옮기지 않는다 — 과거를 메우는 작업이라 최신 지점과 무관하다', async () => {
		const cursor = Date.now() - 7 * 24 * 60 * 60 * 1000;
		writeSubscriptionsFile(['graph'], cursor);
		arxivOnly(feed([entry()], 1));
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).run('backfill', {
			from: Date.UTC(2025, 0, 1),
			to: Date.UTC(2025, 0, 31),
		});

		assert.equal(storedSubscriptions().updateTime, cursor);
	});

	it('구간이 잘렸으면 실제로 훑은 지점까지만 커서로 인정한다', async () => {
		// 상한(MAX_PAGES=20)에 걸리게 만들어 truncated 상태를 만든다. 요청한 구간의 끝을
		// 그대로 저장하면 못 본 구간을 봤다고 기록하게 된다.
		writeSubscriptionsFile(['graph'], Date.UTC(2025, 0, 20));
		let page = 0;
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const atom = feed(entries(100, page * 100), 100000);
			page += 1;
			return response(200, atom);
		});
		const { embedding } = fakeEmbedding();

		await withFastTimers(() => collectFlow(embedding).run('recent'));

		const updateTime = storedSubscriptions().updateTime;
		assert.ok(updateTime !== undefined);
		// 마지막으로 훑은 논문의 제출 시각(2025-01-15대)이지 "지금"이 아니어야 한다.
		assert.ok(
			updateTime < Date.UTC(2025, 1, 1),
			`잘렸는데 커서가 구간 끝으로 갔다: ${new Date(updateTime).toISOString()}`,
		);
		assert.equal(new Date(updateTime).getUTCFullYear(), 2025);
	});
});

// ── 재스캔 시 이미 아는 인용수는 S2에 다시 묻지 않는다 (knownCitations) ─────
describe('CollectAndSave.run — 저장된 인용수는 S2에 다시 묻지 않는다', () => {
	it('이미 citationsKnown=true인 논문이 재스캔에 다시 걸리면 S2 요청을 보내지 않는다', async () => {
		writeSubscriptionsFile(['graph']);
		// 1차: S2가 인용수 7을 알려주고, citationsKnown=true로 저장된다.
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(
					200,
					JSON.stringify([{ citationCount: 7, externalIds: { ArXiv: '2501.00001' } }]),
				);
			}
			return response(200, feed([entry({ id: 'http://arxiv.org/abs/2501.00001v1' })], 1));
		});
		const { embedding } = fakeEmbedding();
		await collectFlow(embedding).run('recent', { hours: 24 });
		assert.equal(vault.storedPapers()[0]?.paper.citationCount, 7);

		// 2차: 재스캔이 같은 논문을 다시 잡아온다. S2가 이번엔 호출되면 즉시 실패하도록
		// 해서, 실제로 호출되는지 여부를 직접 검증한다.
		let s2Called = false;
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				s2Called = true;
				return response(200, '[]');
			}
			return response(200, feed([entry({ id: 'http://arxiv.org/abs/2501.00001v1' })], 1));
		});
		const { embedding: embedding2 } = fakeEmbedding();
		await collectFlow(embedding2).run('recent', { hours: 24 });

		assert.equal(s2Called, false, '이미 아는 인용수인데 S2를 다시 불렀다');
		assert.equal(vault.storedPapers()[0]?.paper.citationCount, 7, '기존 인용수가 유지돼야 한다');
	});

	it('citationsKnown=false인 논문은 재스캔에서도 정상적으로 S2에 묻는다', async () => {
		writeSubscriptionsFile(['graph']);
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]'); // S2가 실패/모름 -> citationsKnown=false로 남음
			}
			return response(200, feed([entry({ id: 'http://arxiv.org/abs/2501.00002v1' })], 1));
		});
		const { embedding } = fakeEmbedding();
		await collectFlow(embedding).run('recent', { hours: 24 });
		assert.equal(vault.storedPapers()[0]?.paper.citationsKnown, false);

		let s2Called = false;
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				s2Called = true;
				return response(
					200,
					JSON.stringify([{ citationCount: 3, externalIds: { ArXiv: '2501.00002' } }]),
				);
			}
			return response(200, feed([entry({ id: 'http://arxiv.org/abs/2501.00002v1' })], 1));
		});
		const { embedding: embedding2 } = fakeEmbedding();
		await collectFlow(embedding2).run('recent', { hours: 24 });

		assert.equal(s2Called, true, '모르는 인용수인데 S2를 안 불렀다');
		assert.equal(vault.storedPapers()[0]?.paper.citationCount, 3);
	});
});

// ── File.writePaperAt 임베딩 보존 백스톱 ────────────────────────────
// run()의 embedOrReuse()가 대부분의 경우를 먼저 막아주지만, File 계층의 이 규칙은
// repair()나 앞으로 생길 다른 호출자까지 보호하는 안전망이라 run()을 거치지 않고
// File.writePaper를 직접 두 번 불러 이 계층만 독립적으로 검증한다.
describe('File.writePaper — 임베딩 보존 백스톱', () => {
	it('기존이 성공 상태면, 실패 상태로 재저장해도 기존 벡터를 유지한다', async () => {
		const paper = new Paper();
		paper.title = 'T';
		paper.authors = [];
		paper.abstract = 'A';
		paper.sourceId = 'arxiv:2501.00001';
		paper.references = [];
		paper.publicationDate = '2025-01-15';
		paper.citationCount = 0;
		paper.citationsKnown = true;
		paper.collectedApis = ['arxiv'];
		paper.collectedQueries = [{ searchType: 'keyword', query: 'q' }];
		paper.embedding = [0.1, 0.2];
		paper.embeddingModel = 'specter2';
		paper.embeddingSource = 'local';
		paper.embeddingSucceeded = true;
		await File.writePaper(paper);

		const retry = Object.assign(new Paper(), paper, {
			embedding: [],
			embeddingModel: '',
			embeddingSource: '',
			embeddingSucceeded: false,
		});
		await File.writePaper(retry);

		const stored = (await File.readAllPapers())[0];
		assert.deepEqual(stored?.embedding, [0.1, 0.2], '성공했던 벡터가 사라졌다');
		assert.equal(stored?.embeddingSucceeded, true);
	});

	it('기존이 없으면 실패 상태를 그대로 저장한다 — 가짜 값을 지어내지 않는다', async () => {
		const paper = new Paper();
		paper.title = 'T2';
		paper.authors = [];
		paper.abstract = 'A';
		paper.sourceId = 'arxiv:2501.00002';
		paper.references = [];
		paper.publicationDate = '2025-01-15';
		paper.citationCount = 0;
		paper.citationsKnown = false;
		paper.collectedApis = ['arxiv'];
		paper.collectedQueries = [{ searchType: 'keyword', query: 'q' }];
		paper.embedding = [];
		paper.embeddingModel = '';
		paper.embeddingSource = '';
		paper.embeddingSucceeded = false;
		await File.writePaper(paper);

		const stored = (await File.readAllPapers())[0];
		assert.deepEqual(stored?.embedding, []);
		assert.equal(stored?.embeddingSucceeded, false);
	});
});

// 4일 재스캔 창이 같은 논문을 다시 저장 대상으로 올려도, 실제 값이 기존과 완전히 같으면
// 디스크를 건드리지 않는다 — 안 그러면 내용이 똑같은데 파일 감시자/동기화가 매번
// 깨어나고 updatedAt이 매번 지금 시각으로 갱신돼 "마지막으로 실제로 바뀐 시점"이 사라진다.
describe('File.writePaper — 값이 같으면 재저장하지 않는다', () => {
	function samplePaper(overrides: Partial<Paper> = {}): Paper {
		const paper = new Paper();
		paper.title = 'T';
		paper.authors = ['Alice'];
		paper.abstract = 'A';
		paper.sourceId = 'arxiv:2501.00003';
		paper.references = [];
		paper.publicationDate = '2025-01-15';
		paper.citationCount = 5;
		paper.citationsKnown = true;
		paper.collectedApis = ['arxiv'];
		paper.collectedQueries = [{ searchType: 'keyword', query: 'q' }];
		paper.embedding = [0.1, 0.2];
		paper.embeddingModel = 'specter2';
		paper.embeddingSource = 'local';
		paper.embeddingSucceeded = true;
		return Object.assign(paper, overrides);
	}

	it('완전히 같은 값으로 다시 저장하면 파일을 건드리지 않는다', async () => {
		await File.writePaper(samplePaper());
		const before = new Map(vault.files);

		await File.writePaper(samplePaper());

		assert.deepEqual(vault.files, before, '내용이 같은데 파일이 다시 써졌다(updatedAt 등)');
	});

	it('값이 하나라도 다르면(예: 인용수 보강) 정상적으로 다시 쓴다', async () => {
		await File.writePaper(samplePaper({ citationCount: 5, citationsKnown: false }));
		const before = new Map(vault.files);

		await File.writePaper(samplePaper({ citationCount: 42, citationsKnown: true }));

		assert.notDeepEqual(vault.files, before, '값이 바뀌었는데 파일이 그대로다');
		const stored = (await File.readAllPapers())[0];
		assert.equal(stored?.citationCount, 42);
	});

	it('새 구독이 출처를 추가하면(collectedApis 병합) 다시 쓴다', async () => {
		await File.writePaper(samplePaper({ collectedApis: ['arxiv'], collectedQueries: [{ searchType: 'keyword', query: 'q' }] }));
		const before = new Map(vault.files);

		await File.writePaper(
			samplePaper({
				collectedApis: ['arxiv'],
				collectedQueries: [{ searchType: 'keyword', query: 'other' }],
			}),
		);

		assert.notDeepEqual(vault.files, before, '새 출처가 추가됐는데 파일이 그대로다');
		const stored = (await File.readAllPapers())[0];
		assert.equal(stored?.collectedApis.length, 2);
	});
});

// ── 보정 패스 (repair) ───────────────────────────────────────────────

// 저장된 논문을 만드는 헬퍼. File.writePaper(실제 구현)로 심어서, repair가 다시 읽고
// 다시 쓰는 경로 전체가 실제 파일 형식과 왕복되도록 한다.
function buildStoredPaper(overrides: Partial<Paper>): Paper {
	const paper = new Paper();
	paper.title = '저장된 논문';
	paper.authors = [];
	paper.abstract = 'An abstract.';
	paper.sourceId = 'arxiv:2501.99999';
	paper.references = [];
	paper.publicationDate = '2025-01-15';
	paper.citationCount = 7;
	paper.citationsKnown = true;
	paper.collectedApis = ['arxiv'];
	paper.collectedQueries = [{ searchType: 'keyword', query: 'graph' }];
	paper.embedding = [0.5, 0.5];
	paper.embeddingModel = 'test-model';
	paper.embeddingSource = 'test';
	paper.embeddingSucceeded = true;
	return Object.assign(paper, overrides);
}

// S2 배치 요청에는 요청된 id 그대로 citationCount를 채워 응답하고, 그 외 요청은 실패시킨다
// — repair는 arXiv 조회를 할 일이 없다.
function s2Only(citationCount: number): void {
	mockRequests((param) => {
		if (!param.url.includes('semanticscholar')) {
			throw new Error(`repair가 예상 밖 요청을 보냈다: ${param.url}`);
		}
		const ids = (JSON.parse(param.body ?? '{}') as { ids: string[] }).ids;
		const body = ids.map((id) => ({
			citationCount,
			externalIds: { ArXiv: id.replace(/^ARXIV:/, '') },
		}));
		return response(200, JSON.stringify(body));
	});
}

describe('CollectAndSave.repair — 보정 패스', () => {
	it('임베딩 모델이 없으면 시작하지 않는다', async () => {
		await File.writePaper(buildStoredPaper({ embeddingSucceeded: false, embedding: [] }));
		s2Only(1);
		const { spy, embedding } = fakeEmbedding({ installed: false });

		await assert.rejects(
			() => collectFlow(embedding).repair(),
			/임베딩 모델이 설치되어 있지 않습니다/,
		);
		assert.equal(spy.calls.length, 0);
		assert.equal(recordedRequests().length, 0);
	});

	it('embeddingSucceeded=false인 논문만 재임베딩하고 결과를 디스크에 남긴다', async () => {
		await File.writePaper(
			buildStoredPaper({
				sourceId: 'arxiv:2501.00001',
				title: '실패했던 논문',
				embeddingSucceeded: false,
				embedding: [],
				embeddingModel: '',
				embeddingSource: '',
			}),
		);
		await File.writePaper(buildStoredPaper({ sourceId: 'arxiv:2501.00002', title: '멀쩡한 논문' }));
		s2Only(1);
		const { spy, embedding } = fakeEmbedding();

		await collectFlow(embedding).repair();

		assert.deepEqual(spy.calls, ['실패했던 논문'], '성공했던 논문까지 다시 임베딩했다');
		const repaired = vault.storedPapers().find((s) => s.paper.title === '실패했던 논문');
		assert.equal(repaired?.paper.embeddingSucceeded, true);
		assert.deepEqual(repaired?.paper.embedding, [0.1, 0.2, 0.3]);
	});

	it('재임베딩이 또 실패하면 디스크를 건드리지 않는다', async () => {
		await File.writePaper(
			buildStoredPaper({
				title: '또 실패할 논문',
				embeddingSucceeded: false,
				embedding: [],
				embeddingModel: '',
				embeddingSource: '',
			}),
		);
		s2Only(1);
		const before = new Map(vault.files);
		const { embedding } = fakeEmbedding({ failOn: () => true });

		await collectFlow(embedding).repair();

		assert.deepEqual(vault.files, before, '아무것도 안 바뀌었는데 파일이 다시 써졌다');
	});

	it('citationsKnown=false인 논문만 S2에 물어보고 채워서 저장한다', async () => {
		await File.writePaper(
			buildStoredPaper({
				sourceId: 'arxiv:2501.00003',
				title: '인용수 없는 논문',
				citationsKnown: false,
				citationCount: 0,
			}),
		);
		await File.writePaper(
			buildStoredPaper({ sourceId: 'arxiv:2501.00004', title: '인용수 있는 논문' }),
		);
		s2Only(42);
		const { embedding } = fakeEmbedding();

		await collectFlow(embedding).repair();

		const s2Requests = recordedRequests().filter((r) => r.url.includes('semanticscholar'));
		assert.equal(s2Requests.length, 1);
		const ids = (JSON.parse(s2Requests[0]?.body ?? '{}') as { ids: string[] }).ids;
		assert.deepEqual(ids, ['ARXIV:2501.00003'], '이미 아는 인용수까지 다시 물어봤다');

		const enriched = vault.storedPapers().find((s) => s.paper.title === '인용수 없는 논문');
		assert.equal(enriched?.paper.citationsKnown, true);
		assert.equal(enriched?.paper.citationCount, 42);
	});

	it('둘 다 멀쩡한 논문은 재시도도 재저장도 하지 않는다', async () => {
		await File.writePaper(buildStoredPaper({ title: '완전한 논문' }));
		s2Only(1);
		const before = new Map(vault.files);
		const { spy, embedding } = fakeEmbedding();

		await collectFlow(embedding).repair();

		assert.equal(spy.calls.length, 0);
		assert.equal(recordedRequests().length, 0, 'S2에 물어볼 것이 없어야 한다');
		assert.deepEqual(vault.files, before);
	});
});

// ── File.readSubscriptions — 새 설치 기본값 ─────────────────────────

describe('File.readSubscriptions — Subscriptions.json이 아직 없을 때', () => {
	it('apis를 undefined가 아니라 빈 배열로 돌려준다', async () => {
		// Subscriptions.json을 아예 심지 않은 상태 = 완전히 새로 설치한 환경.
		// apis가 undefined면 이걸 그대로 .map하는 호출자(설정탭 등)가 그 자리에서 죽는다.
		const subscriptions = await File.readSubscriptions();
		assert.deepEqual(subscriptions.apis, []);
	});

	it('updateTime도 undefined로 두지 않는다 — 파일이 있을 때와 같은 모양이어야 한다', async () => {
		const subscriptions = await File.readSubscriptions();
		assert.equal(subscriptions.updateTime, 0);
	});

	it('모르는 apiName이 저장돼 있으면 조용히 넘기지 않고 throw한다', async () => {
		// 이 버전이 모르는 API로 저장된 파일(팀원이 새 API를 추가한 브랜치에서 저장 등).
		// 조용히 빈 목록을 돌려주면 그 위에 저장이 일어나 기존 구독이 사라지므로,
		// 읽기 단계에서 실패를 알려야 호출자가 덮어쓰기를 멈출 수 있다.
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({ updateTime: 123, apis: [{ apiName: 'pubmed', querys: [] }] }),
		);
		await assert.rejects(() => File.readSubscriptions(), /Unknown apiName: pubmed/);
	});
});

// ── Secret 저장 — 설정탭 API 키 필드가 의존하는 계약 ────────────────────
describe('File.readSecret/writeSecret — provider별 키 보존', () => {
	it('한 provider의 키를 저장해도 이미 등록된 다른 provider의 키가 사라지지 않는다', async () => {
		const first = await File.readSecret();
		first.setKey('otherProvider', 'other-key');
		await File.writeSecret(first);

		// 설정탭의 persistApiKey()가 하는 것과 같은 패턴: 다시 읽고, 한 provider만
		// 갈아끼우고, 다시 쓴다.
		const second = await File.readSecret();
		second.setKey(S2_SECRET_PROVIDER, 's2-key');
		await File.writeSecret(second);

		const final = await File.readSecret();
		assert.equal(final.getKey('otherProvider'), 'other-key', '다른 provider의 키가 사라졌다');
		assert.equal(final.getKey(S2_SECRET_PROVIDER), 's2-key');
	});
});

// ── 직렬 작업 큐 ──────────────────────────────────────────────────────
// 수집 작업은 절대 겹치면 안 되지만(Embedding이 세션/서킷브레이커를 락 없이 공유), 자동
// 수집이 도는 중에도 사용자가 구독을 추가하거나 Backfill을 실행할 수 있어야 한다. 그래서
// 두 번째 요청은 거절이 아니라 큐에 들어가 순서대로 실행된다.
describe('CollectAndSave — 직렬 작업 큐', () => {
	it('실행 중에 다른 작업을 요청하면 거절하지 않고 줄을 세운다', async () => {
		arxivOnly(feed([entry()], 1));
		writeSubscriptionsFile(['queued']);

		const timeline: string[] = [];
		const { embedding, spy } = fakeEmbedding();
		const flow = collectFlow(embedding);

		const first = flow.run('recent', { hours: 24 }, () => timeline.push('start:A'));
		const second = flow.run('backfill', { from: Date.now() - 86_400_000, to: Date.now() }, () =>
			timeline.push('start:B'),
		);

		// 입큐는 동기다: 요청하자마자 둘 다 줄에 서 있고, 아직 아무것도 시작하지 않았다.
		// (거절됐다면 두 번째가 아예 줄에 없을 것이다.)
		assert.deepEqual(
			flow.queueState.waiting.map((job) => job.kind),
			['recent', 'backfill'],
		);
		assert.equal(timeline.length, 0, `아직 아무것도 시작하면 안 된다: ${timeline.join(',')}`);

		await Promise.all([first, second]);

		assert.deepEqual(timeline, ['start:A', 'start:B'], '요청한 순서대로 실행되지 않았다');
		// 겹쳤다면 두 작업의 임베딩이 동시에 in-flight가 된다 — Embedding이 락 없이 세션을
		// 공유하므로 이게 큐가 막아야 할 실제 위험이다.
		assert.equal(spy.maxConcurrent, 1, '두 작업의 임베딩이 겹쳤다');
		assert.equal(flow.isBusy, false);
		assert.equal(flow.queueState.waiting.length, 0);
	});

	it('한 작업이 실패해도 큐의 다음 작업은 실행된다', async () => {
		arxivOnly(feed([entry()], 1));
		writeSubscriptionsFile(['after-failure']);
		const { embedding, spy } = fakeEmbedding();
		const flow = collectFlow(embedding);

		// 범위 없는 Backfill은 resolveWindow에서 확실히 실패한다.
		const failing = flow.run('backfill');
		const following = flow.run('recent', { hours: 24 });

		await assert.rejects(() => failing, /수집할 구간\(from\/to\)이 필요합니다/);
		await following;
		assert.ok(spy.calls.length > 0, '앞 작업의 실패로 뒤 작업까지 취소됐다');
	});

	it('아직 시작하지 않은 requestRecent는 하나로 합친다', async () => {
		arxivOnly(feed([entry()], 1));
		writeSubscriptionsFile(['coalesce']);
		const { embedding } = fakeEmbedding();
		const flow = collectFlow(embedding);

		// 첫 작업이 큐를 점유한 동안, 구독을 연달아 세 번 바꿨다고 가정한다.
		const blocking = flow.run('backfill', { from: Date.now() - 86_400_000, to: Date.now() });
		const a = flow.requestRecent();
		const b = flow.requestRecent();
		const c = flow.requestRecent();

		assert.equal(a, b, 'recent 요청이 합쳐지지 않았다');
		assert.equal(b, c);
		assert.equal(flow.queueState.waiting.filter((job) => job.kind === 'recent').length, 1);

		await Promise.all([blocking, a, b, c]);
	});

	it('이미 실행 중인 recent에는 합치지 않는다 — 그 작업은 새 구독을 못 본다', async () => {
		arxivOnly(feed([entry()], 1));
		writeSubscriptionsFile(['running']);
		const { embedding } = fakeEmbedding();
		const flow = collectFlow(embedding);

		// 실행이 시작된 시점에 새 recent를 요청한다.
		let queuedDuringRun: Promise<void> | undefined;
		const running = flow.requestRecent('첫 번째', () => {
			queuedDuringRun = flow.requestRecent('구독 변경 반영');
		});

		await running;
		assert.ok(queuedDuringRun !== undefined, '실행 중 요청이 만들어지지 않았다');
		assert.notEqual(queuedDuringRun, running, '실행 중인 작업에 합쳐져 새 구독이 무시된다');
		await queuedDuringRun;
	});
});

// ── 커서 저장이 구독을 덮어쓰지 않는다 ────────────────────────────────
describe('CollectAndSave — 수집 중 추가된 구독 보존', () => {
	it('수집이 끝나도 그 사이에 추가된 구독이 사라지지 않는다', async () => {
		arxivOnly(feed([entry()], 1));
		writeSubscriptionsFile(['original']);
		const { embedding } = fakeEmbedding();

		// 'all' 미들웨어는 수집이 끝나고 커서 저장 전에 불린다 — 사용자가 수집 도중에
		// 구독을 추가하는 상황을 이 시점에 재현한다.
		const addSubscriptionMidRun: Middleware = {
			type: 'all',
			run: async () => {
				const subscriptions = await File.readSubscriptions();
				subscriptions.apis = [
					...subscriptions.apis,
					File.createApi('arxiv', [{ searchType: 'keyword', query: 'added-during-run' }]),
				];
				await File.writeSubscriptions(subscriptions);
			},
		};

		await collectFlow(embedding, [addSubscriptionMidRun]).run('recent');

		const stored = JSON.parse(vault.files.get(`${PLUGIN_DIR}/Subscriptions.json`) ?? '{}') as {
			apis?: { querys?: { query: string }[] }[];
		};
		const queries = (stored.apis ?? []).flatMap((api) =>
			(api.querys ?? []).map((q) => q.query),
		);
		assert.ok(
			queries.includes('added-during-run'),
			`수집 중 추가된 구독이 커서 저장에 덮여 사라졌다: ${JSON.stringify(queries)}`,
		);
		assert.ok(queries.includes('original'), '기존 구독까지 사라졌다');
	});
});

// ── 청크 단위 점진 저장 ────────────────────────────────────────────────
// Backfill 상한이 사라지면서 "전량을 다 받은 뒤에 저장"은 못 쓰게 됐다. 수만 편을
// 메모리에 들고 있어야 하고, 마지막에 실패하면 그때까지 받은 게 전부 사라진다.
describe('CollectAndSave — 청크 단위로 저장한다', () => {
	it('수집 도중 네트워크가 끊겨도 그 전까지 받은 청크는 이미 저장돼 있다', async () => {
		writeSubscriptionsFile(['partial']);
		const { embedding } = fakeEmbedding();

		// 1·2페이지는 정상(각 100건), 3페이지에서 500. 500은 재시도 대상이 아니라 즉시 throw다.
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			if (start >= 200) {
				return response(500, 'boom');
			}
			return response(200, feed(entries(100, start), 500));
		});

		await assert.rejects(() =>
			withFastTimers(() =>
				collectFlow(embedding).run('backfill', { from: FROM_MS, to: TO_MS }),
			),
		);

		// 예전 구조라면 여기서 0편이었다 — 전량을 모은 뒤에야 저장했기 때문이다.
		assert.equal(
			vault.storedPapers().length,
			200,
			'실패 전에 받은 청크가 저장되지 않았다 — 점진 저장이 동작하지 않는다',
		);
	});

	it('페이지가 나뉘어도 all 미들웨어가 청크마다 불리고 총합은 전체 편수와 같다', async () => {
		writeSubscriptionsFile(['chunked']);
		const { embedding } = fakeEmbedding();

		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			// 총 250건: 100 + 100 + 50
			const remaining = Math.max(0, 250 - start);
			return response(200, feed(entries(Math.min(100, remaining), start), 250));
		});

		const chunkSizes: number[] = [];
		const observer: Middleware = {
			type: 'all',
			run: (context) => {
				chunkSizes.push((context as Paper[]).length);
			},
		};

		await withFastTimers(() =>
			collectFlow(embedding, [observer]).run('backfill', { from: FROM_MS, to: TO_MS }),
		);

		assert.ok(chunkSizes.length > 1, `청크가 하나뿐이다: ${chunkSizes.join(',')}`);
		assert.equal(
			chunkSizes.reduce((sum, n) => sum + n, 0),
			250,
			'청크 합계가 전체 편수와 다르다',
		);
		assert.equal(vault.storedPapers().length, 250);
	});
});

// ── 임베딩 서킷브레이커 ────────────────────────────────────────────────
// 브레이커가 열리면 embed()는 시도조차 안 하고 즉시 throw한다. 그대로 두면 남은 논문이
// 몇 초 만에 전부 빈 벡터로 저장된다.
describe('CollectAndSave — 임베딩 서킷브레이커', () => {
	it('브레이커가 열리면 쿨다운을 기다렸다 재개한다 — 남은 논문을 즉시 실패로 흘리지 않는다', async () => {
		arxivOnly(feed(entries(6), 6));
		writeSubscriptionsFile(['breaker']);

		// 앞 3편이 연달아 실패해 브레이커가 열리고, 기다리면 풀린다.
		const failing = new Set(['Paper 0', 'Paper 1', 'Paper 2']);
		const { embedding, spy } = fakeEmbedding({
			failOn: (title) => failing.has(title),
			tripCooldownMs: 60_000,
			cooldownPersists: false,
		});

		await withFastTimers(() => collectFlow(embedding).run('recent', { hours: 24 }));

		// 기다린 뒤 나머지가 정상적으로 임베딩됐어야 한다 — 브레이커가 열렸다고 남은
		// 논문을 전부 빈 벡터로 흘려보내면 안 된다.
		assert.deepEqual(spy.calls, ['Paper 0', 'Paper 1', 'Paper 2', 'Paper 3', 'Paper 4', 'Paper 5']);
		const succeeded = vault.storedPapers().filter((s) => s.paper.embeddingSucceeded);
		assert.equal(succeeded.length, 3, '쿨다운 후 임베딩이 재개되지 않았다');
	});

	it('계속 열려 있으면 무한정 기다리지 않고 포기하되, 메타데이터는 저장한다', async () => {
		arxivOnly(feed(entries(8), 8));
		writeSubscriptionsFile(['breaker-stuck']);

		// 전부 실패하고 기다려도 안 풀린다 = 모델이 회복 불가능한 상태.
		const { embedding, spy } = fakeEmbedding({
			failOn: () => true,
			tripCooldownMs: 60_000,
			cooldownPersists: true,
		});

		await withFastTimers(() => collectFlow(embedding).run('recent', { hours: 24 }));

		// 브레이커가 열린 뒤로는 embed를 더 부르지 않는다. 논문마다 1분씩 서면 수집이
		// 사실상 멈추므로, 몇 번 기다려보고 포기해야 한다.
		assert.equal(
			spy.calls.length,
			FAKE_FAILURE_LIMIT,
			`브레이커가 열린 뒤에도 계속 시도했다: ${spy.calls.length}회`,
		);
		// 임베딩은 실패했어도 논문 자체는 저장된다(보정 패스가 벡터를 채운다).
		assert.equal(vault.storedPapers().length, 8, '임베딩 실패로 논문까지 버려졌다');
		assert.ok(vault.storedPapers().every((stored) => !stored.paper.embeddingSucceeded));
	});
});
