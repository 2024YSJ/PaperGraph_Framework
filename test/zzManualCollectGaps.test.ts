// ⚠️ 임시 수동 확인용 — 수집 경로에서 아직 테스트가 없던 빈틈들을 재현한다. 확인 후 삭제할 것.
//
// 여기 있는 것들은 "버그 재현"이 아니라 "지금 코드가 실제로 어떻게 동작하는지"를 못 박는
// 성격이 섞여 있다. 각 describe 위에 무엇을 확인하려는 것인지와, 통과가 곧 정상인지
// 아니면 개선 여지가 있는 동작인지 적어둔다.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { CollectAndSave } from '../src/collect/CollectAndSave';
import { Embedding } from '../src/collect/Embedding';
import { File } from '../src/common/File';
import type { Middleware } from '../src/common/Middleware';
import { Paper } from '../src/collect/Paper';
import { parseLocalDateInput } from '../src/adapter/SubscriptionTargetModal';
import { mockRequests, recordedRequests, response } from './stubs/obsidian';
import { entries, entry, feed, installDomParser, withFastTimers } from './helpers/arxivFixtures';
import { VaultStub } from './helpers/vaultStub';

installDomParser();

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
});

// ── 공용 대역 ────────────────────────────────────────────────────────

function fakeEmbedding(): Embedding {
	return {
		isModelInstalled: () => Promise.resolve(true),
		resetCircuitBreaker: () => undefined,
		breakerCooldownRemainingMs: 0,
		embed: () =>
			Promise.resolve({
				embedding: [0.1, 0.2, 0.3],
				embeddingModel: 'test-model',
				embeddingSource: 'test',
				embeddingSucceeded: true,
			}),
	} as unknown as Embedding;
}

function collectFlow(middlewares: Middleware[] = []): CollectAndSave {
	const flow = new CollectAndSave();
	flow.embedding = fakeEmbedding();
	for (const mw of middlewares) {
		flow.setMiddleware(mw);
	}
	return flow;
}

function writeSubscriptionsFile(query = 'graph', updateTime?: number): void {
	vault.files.set(
		`${PLUGIN_DIR}/Subscriptions.json`,
		JSON.stringify({
			apis: [{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query }], updateTime }],
		}),
	);
}

// arXiv엔 주어진 피드로, S2엔 빈 배열(= 인용수를 하나도 못 채움)로 답한다.
function arxivOnly(atom: string): void {
	mockRequests((param) => {
		if (param.url.includes('semanticscholar')) {
			return response(200, '[]');
		}
		return response(200, atom);
	});
}

function s2RequestCount(): number {
	return recordedRequests().filter((r) => r.url.includes('semanticscholar')).length;
}

function storedCursor(): number | undefined {
	const raw = vault.files.get(`${PLUGIN_DIR}/Subscriptions.json`);
	assert.ok(raw !== undefined);
	return (JSON.parse(raw) as { apis?: { updateTime?: number }[] }).apis?.[0]?.updateTime;
}

function makePaper(sourceId: string, title: string, publicationDate = '2025-01-15'): Paper {
	const p = new Paper();
	p.title = title;
	p.authors = ['Alice Kim'];
	p.abstract = 'abstract';
	p.sourceId = sourceId;
	p.references = [];
	p.publicationDate = publicationDate;
	p.citationCount = 0;
	p.citationsKnown = true;
	p.collectedApis = [];
	p.collectedQueries = [];
	p.embedding = [0.1, 0.2, 0.3];
	p.embeddingModel = 'test-model';
	p.embeddingSource = 'test';
	p.embeddingSucceeded = true;
	return p;
}

// ── B7 ───────────────────────────────────────────────────────────────
// 역전 구간(from >= to)은 resolveWindow가 명시적으로 거부한다(CollectAndSave.ts) —
// 예전엔 collectWindow가 조용히 0편으로 끝내 "0편 수집 완료했습니다" Notice만 뜨고
// 사용자는 날짜를 거꾸로 넣었다는 사실을 알 방법이 없었다. 지금은 이 구간을 그대로
// 요청한 구독(들)이 실패로 잡혀 명확한 에러 메시지와 함께 던져진다.
describe('B7: backfill 날짜를 거꾸로 주면', () => {
	it('역전 구간은 명확한 에러로 거부되고 네트워크 요청은 안 나간다', async () => {
		writeSubscriptionsFile();
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		await withFastTimers(() =>
			assert.rejects(
				() =>
					flow.run('backfill', {
						from: Date.UTC(2025, 0, 31), // 시작이 종료보다 뒤
						to: Date.UTC(2025, 0, 1),
					}),
				/구간이 올바르지 않습니다/,
			),
		);

		const arxivRequests = recordedRequests().filter((r) => !r.url.includes('semanticscholar'));
		console.log('역전 구간 — arXiv 요청 수:', arxivRequests.length);
		console.log('역전 구간 — 저장된 논문 수:', vault.storedPapers().length);

		assert.equal(arxivRequests.length, 0, '역전 구간인데 arXiv를 호출했다');
		assert.equal(vault.storedPapers().length, 0);
	});

	it('순방향이어도 종료일이 미래면 거부된다 ("미래-미래")', async () => {
		writeSubscriptionsFile();
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
		await withFastTimers(() =>
			assert.rejects(
				() =>
					flow.run('backfill', {
						from: farFuture,
						to: farFuture + 24 * 60 * 60 * 1000, // from < to — 순서는 맞지만 둘 다 미래
					}),
				/종료일이 미래입니다/,
			),
		);

		const arxivRequests = recordedRequests().filter((r) => !r.url.includes('semanticscholar'));
		assert.equal(arxivRequests.length, 0, '미래 구간인데 arXiv를 호출했다');
	});

	it('"오늘까지"는 거부되지 않는다 — 종료일 당일 포함 보정(+24h)이 실제 재현된 버그', async () => {
		// SubscriptionTargetModal은 "종료일 당일 포함"을 위해 선택한 날짜의 다음날
		// 자정을 to로 넘긴다 — 오늘을 종료일로 고르면 to는 항상 "내일 자정"이라 이 순간
		// (now)보다 크다. 단순히 to > now로 비교하면 이 정상적인 입력까지 막혀버렸다.
		writeSubscriptionsFile();
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		const now = new Date();
		const todayMidnightLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const startOfTomorrowLocal = todayMidnightLocal + 24 * 60 * 60 * 1000; // "오늘까지" 선택 시 실제 to 값

		await withFastTimers(() =>
			flow.run('backfill', {
				from: todayMidnightLocal - 14 * 24 * 60 * 60 * 1000,
				to: startOfTomorrowLocal,
			}),
		);

		const arxivRequests = recordedRequests().filter((r) => !r.url.includes('semanticscholar'));
		assert.ok(arxivRequests.length > 0, '"오늘까지"인데 정상 요청이 안 나갔다 — 여전히 막혔다');
	});
});

// ── D11 / D12 ────────────────────────────────────────────────────────
// 자동 인용수 보정의 10분 쿨다운(AUTO_CITATION_REPAIR_COOLDOWN_MS).
// S2가 계속 빈 응답이라 "시도했지만 0건도 못 고침"이 되면, 다음 수집은 자동 보정을 건너뛴다.
describe('D11: 자동 인용수 보정 쿨다운', () => {
	it('직전 자동 보정이 0건으로 끝나면 다음 수집은 자동 보정을 건너뛴다', async () => {
		writeSubscriptionsFile();
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();

		await withFastTimers(() => flow.run('recent'));
		const firstRunS2 = s2RequestCount();
		console.log('1회차 S2 요청 수(수집 중 보강 + 자동 보정):', firstRunS2);

		// 요청 기록만 비우고 flow는 그대로 재사용 — 쿨다운 상태가 인스턴스에 남아 있어야 한다.
		mockRequests((param) =>
			param.url.includes('semanticscholar') ? response(200, '[]') : response(200, feed(entries(3), 3)),
		);

		await withFastTimers(() => flow.run('recent'));
		const secondRunS2 = s2RequestCount();
		console.log('2회차 S2 요청 수(자동 보정 건너뛰어야 함):', secondRunS2);

		assert.ok(firstRunS2 > 0, '1회차에 S2를 아예 안 불렀다면 이 테스트의 전제가 깨진다');
		assert.ok(
			secondRunS2 < firstRunS2,
			`2회차가 1회차만큼 S2를 불렀다 — 쿨다운이 안 걸렸다 (1회차 ${firstRunS2}, 2회차 ${secondRunS2})`,
		);
	});

	it('D12: 사용자가 직접 부르는 repairCitations는 쿨다운을 무시한다', async () => {
		writeSubscriptionsFile();
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		await withFastTimers(() => flow.run('recent')); // 여기서 쿨다운이 걸린다

		mockRequests((param) =>
			param.url.includes('semanticscholar') ? response(200, '[]') : response(200, feed(entries(3), 3)),
		);

		await withFastTimers(() => flow.repairCitations());
		const manualS2 = s2RequestCount();
		console.log('수동 인용수 보정의 S2 요청 수:', manualS2);

		assert.ok(manualS2 > 0, '수동 보정이 쿨다운에 막혔다 — "지금 다시 해봐라"는 요청은 존중해야 한다');
	});
});

// ── G20 ──────────────────────────────────────────────────────────────
// 저장이 실패하면 커서가 전진하면 안 된다. 전진해버리면 저장 못 한 구간을 "봤다"고
// 기록하는 셈이라 그 구간의 논문이 영구히 누락된다.
describe('G20: 저장 실패 시 커서', () => {
	it('논문 저장이 실패하면 그 구독의 커서를 전진시키지 않는다', async () => {
		const INITIAL_CURSOR = Date.UTC(2025, 0, 10);
		writeSubscriptionsFile('graph', INITIAL_CURSOR);
		arxivOnly(feed(entries(3), 3));

		// 논문 .json 쓰기만 실패시킨다 — Subscriptions.json 저장 경로는 살려둬야
		// "커서가 갱신되지 않았다"와 "파일을 아예 못 썼다"를 구분할 수 있다.
		const originalCreate = vault.create.bind(vault);
		vault.create = (path: string, text: string) => {
			if (path.startsWith('PaperGraph3D/')) {
				return Promise.reject(new Error('디스크 쓰기 실패(테스트)'));
			}
			return originalCreate(path, text);
		};

		const flow = collectFlow();
		await withFastTimers(() =>
			assert.rejects(() => flow.run('recent'), /모든 구독의 수집이 실패했습니다/),
		);

		console.log('저장 실패 후 커서:', storedCursor(), '(초기값:', INITIAL_CURSOR, ')');
		assert.equal(storedCursor(), INITIAL_CURSOR, '저장이 실패했는데 커서가 전진했다');
	});
});

// ── 새로고침(refreshAll) 저장 실패 격리 ─────────────────────────────────
// API.Refresh(arXiv 구현)는 내부적으로 runQuietly로 감싸져 있어 네트워크 실패로는
// 절대 throw하지 않는다 — 그래서 "새로고침 실패"를 재현하려면 네트워크가 아니라
// File.writePaper(디스크 쓰기)를 실패시켜야 한다. 예전엔 이게 refreshAllBody 전체를
// 그 자리에서 중단시켰는데(throw error), 이제 구독/출처 격리와 같은 원칙으로 그
// 논문만 stats.failedPapers에 남기고 나머지는 계속 처리한다.
describe('새로고침 — 논문 저장 실패는 그 논문만 건너뛰고 나머지는 계속된다', () => {
	it('두 번째 논문 저장이 실패해도 첫 번째·세 번째는 정상 처리되고 실패 목록에만 남는다', async () => {
		// 대상 논문 3편을 미리 볼트에 심어둔다 — refreshAll은 loadRepairTargets()로
		// 볼트 전체를 스캔해 대상을 정하므로, 여기서 미리 저장해둬야 대상이 된다.
		for (const n of [1, 2, 3]) {
			const p = makePaper(`arxiv:2501.0000${n}`, `Paper ${n}`);
			p.collectedApis = ['arxiv']; // refreshAllBody가 이 출처로 필터링한다
			await File.writePaper(p);
		}

		// File.writePaper는 값이 실제로 안 바뀌면 디스크에 다시 쓰지 않는다 — 그래서
		// S2가 citationCount를 실제로 다른 값으로 돌려줘야 각 논문마다 진짜 쓰기가
		// 일어난다. arXiv id_list 응답은 빈 결과로 둬도 무방(runQuietly라 그냥 넘어감).
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				const body = JSON.parse(param.body ?? '{}') as { ids: string[] };
				const results = body.ids.map((id) => ({
					externalIds: { ArXiv: id.replace('ARXIV:', '') },
					citationCount: 5,
					references: [],
				}));
				return response(200, JSON.stringify(results));
			}
			return response(200, feed([])); // id_list 재조회 — 빈 결과여도 무방
		});

		let writeCount = 0;
		const originalCreate = vault.create.bind(vault);
		const originalModify = vault.modify.bind(vault);
		vault.create = (path: string, text: string) => {
			if (path.startsWith('PaperGraph3D/') && path.endsWith('.json')) {
				writeCount += 1;
				if (writeCount === 2) {
					return Promise.reject(new Error('디스크 쓰기 실패(테스트) — 두 번째 논문'));
				}
			}
			return originalCreate(path, text);
		};
		vault.modify = (file, text) => {
			if (file.path.startsWith('PaperGraph3D/') && file.path.endsWith('.json')) {
				writeCount += 1;
				if (writeCount === 2) {
					return Promise.reject(new Error('디스크 쓰기 실패(테스트) — 두 번째 논문'));
				}
			}
			return originalModify(file, text);
		};

		const flow = collectFlow();
		await withFastTimers(() => flow.refreshAll());

		console.log('저장 시도 횟수(실패 포함):', writeCount);
		console.log('lastRefreshStats:', flow.lastRefreshStats);

		// 격리 전이었다면 세 번째 논문은 시도조차 안 됐을 것 — 이제 3편 다 시도된다
		// (2번은 실패로, 1·3번은 성공으로).
		assert.equal(writeCount, 3, '세 번째 논문까지 저장 시도가 도달하지 않았다 — 격리가 안 걸렸다');
		assert.equal(flow.lastRefreshStats?.citationsRefreshed, 2, '성공한 두 편이 집계에 안 잡혔다');
		assert.equal(flow.lastRefreshStats?.failedPapers.length, 1, '실패한 논문이 목록에 안 남았다');
		assert.equal(
			flow.lastRefreshStats?.failedPapers[0]?.sourceId,
			'arxiv:2501.00002',
			'실패한 논문의 sourceId가 정확히 안 남았다',
		);
	});
});

// ── F19 ──────────────────────────────────────────────────────────────
// 같은 구간을 두 번 backfill하면 같은 항목이 두 번 스킵된다. SkippedEntries.json에
// rawId가 중복 누적되면 재조회가 같은 id를 여러 번 물어보게 된다.
describe('F19: 스킵 항목 중복 누적', () => {
	it('같은 rawId가 다시 스킵돼도 레코드는 하나로 유지된다', async () => {
		// private 메서드를 직접 부른다 — TS의 private은 컴파일 타임 표시일 뿐이라 런타임에는
		// 그냥 메서드다. 교집합 타입으로 확장하면 "private이라 never로 축소된다"는 컴파일
		// 에러가 나므로, unknown을 거쳐 필요한 시그니처만 가진 타입으로 본다.
		type Internal = { appendSkippedEntries(records: unknown[]): Promise<void> };
		const flow = collectFlow() as unknown as Internal;

		const record = {
			rawId: 'http://arxiv.org/abs/2501.00001',
			title: '',
			reason: 'missing-fields' as const,
			apiName: 'arxiv',
			collectedQuery: { searchType: 'keyword', query: 'graph' },
			skippedAt: Date.now(),
		};

		await flow.appendSkippedEntries([record]);
		await flow.appendSkippedEntries([{ ...record, skippedAt: Date.now() + 1000 }]);

		const stored = await File.readSkippedEntries();
		console.log('중복 append 후 레코드 수:', stored.length);
		assert.equal(stored.length, 1, '같은 rawId가 두 건으로 쌓였다');
	});
});

// ── 파일명 정제 ───────────────────────────────────────────────────────
// baseNoteName은 금지문자를 '_'가 아니라 공백으로 바꾸고, 100자에서 단어 경계를
// 고려하지 않고 자른다. 크래시는 없지만 결과물이 어떻게 생기는지 못 박아둔다.
describe('파일명 정제 — 현재 동작 고정', () => {
	it('금지문자(? :)는 공백으로 치환되고 title 원문은 그대로 보존된다', async () => {
		const title = "Are You Sure You're Sure? On the Impact of Instruction Tuning";
		await File.writePaper(makePaper('arxiv:2608.13430', title));

		const stored = vault.storedPapers();
		assert.equal(stored.length, 1);
		const path = stored[0]?.path ?? '';
		console.log('생성된 경로:', path);

		assert.ok(!path.includes('?'), '파일명에 ? 가 남았다');
		assert.ok(!path.includes('_'), '금지문자가 _ 가 아니라 공백으로 치환되는 게 현재 동작이다');
		assert.equal(stored[0]?.paper.title, title, 'frontmatter의 title은 원문이어야 한다');
	});

	it('100자를 넘는 제목은 단어 중간에서 잘린다 (개선 여지 있음)', async () => {
		const title =
			'Towards Context-Aware Clinical Motion Understanding in Daily Living at Home: ' +
			'Freezing of Gait Detection with Egocentric Vision';
		await File.writePaper(makePaper('arxiv:2608.13283', title));

		const path = vault.storedPapers()[0]?.path ?? '';
		const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');
		console.log('잘린 파일명:', stem);

		// (localId) 부분을 뺀 제목 조각이 100자 이하로 잘려 있다.
		const titlePart = stem.slice(0, stem.lastIndexOf(' ('));
		assert.ok(titlePart.length <= 100, `제목 조각이 100자를 넘는다: ${titlePart.length}자`);
		assert.ok(title.startsWith(titlePart.slice(0, 20)), '앞부분은 원문과 같아야 한다');
	});

	it('제목이 금지문자뿐이면 sourceId 폴백으로 파일을 만든다', async () => {
		await File.writePaper(makePaper('arxiv:2501.99999', '???:::'));

		const path = vault.storedPapers()[0]?.path ?? '';
		console.log('폴백 경로:', path);
		assert.ok(path.length > 0, '파일이 아예 안 만들어졌다');
		assert.ok(path.includes('2501.99999'), 'sourceId 폴백이 안 걸렸다');
	});
});

// ── L2 ───────────────────────────────────────────────────────────────
// "2026-01-01부터"라고 입력했는데 12/31 논문이 걸리는 현상의 근거.
// parseLocalDateInput은 로컬 자정을 쓰므로 UTC로는 전날이 된다(KST 기준 -9시간).
describe('L2: 날짜 입력의 로컬/UTC 경계', () => {
	it('입력한 날짜는 로컬 자정으로 해석된다 — UTC로는 전날일 수 있다', () => {
		const ms = parseLocalDateInput('2026-01-01');
		assert.ok(ms !== undefined);

		const local = new Date(ms);
		assert.equal(local.getFullYear(), 2026);
		assert.equal(local.getMonth(), 0);
		assert.equal(local.getDate(), 1);
		assert.equal(local.getHours(), 0, '로컬 자정이 아니다');

		console.log('로컬 입력 2026-01-01 → UTC:', new Date(ms).toISOString());
		console.log('  (UTC+9 환경이면 2025-12-31T15:00:00.000Z가 나온다)');
	});

	it('형식이 안 맞으면 undefined', () => {
		assert.equal(parseLocalDateInput(''), undefined);
		assert.equal(parseLocalDateInput('2026-1-1'), undefined);
		assert.equal(parseLocalDateInput('nope'), undefined);
	});
});

// ── 15 ───────────────────────────────────────────────────────────────
// prefillFromStore는 인용수/임베딩은 "성공 플래그가 선 경우만" 복원하는데(조건부),
// extra는 무조건 복원한다(무조건). 이 차이가, 미들웨어가 실패 도중 남긴 "덜 된" 값도
// "성공적으로 만들어진 값"처럼 영구히 되살린다는 걸 보여준다.
//
// 시나리오: forEach 미들웨어가 요약을 만들다 도중에 던진다. runMiddlewares는 예외를
// 잡아 로그만 남기고 계속 진행하므로(CollectAndSave.ts:1271), 던지기 직전까지 mutate한
// paper.extra.summary(부분 값)는 그대로 저장된다. 재스캔 창(4일) 안이라 같은 논문이
// 다음 recent 실행에도 또 걸리는데, prefillFromStore가 그 부분 값을 조건 없이 복원하고
// 미들웨어는 "extra.summary가 이미 있다"고 보고 재시도를 건너뛴다 — 실패가 성공으로
// 영구히 위장된다.
describe('15: extra는 조건 없이 복원된다 — 실패 도중 남긴 값도 영구 고정된다', () => {
	it('forEach 미들웨어가 요약 생성 중 실패해도, 실패 전에 쓴 부분 값이 저장되고 다음 재스캔에서 재시도를 막는다', async () => {
		writeSubscriptionsFile();
		// 재스캔 창(4일) 안에 두 번 다 걸리도록 발행 시각을 "지금"으로 둔다.
		const atom = feed(
			[entry({ id: 'http://arxiv.org/abs/2501.00001v1', published: new Date().toISOString() })],
			1,
		);

		let attempts = 0;
		const flakySummaryMiddleware: Middleware = {
			type: 'forEach',
			run: (context) => {
				const paper = context as Paper;
				const extra = paper.extra as unknown as { summary?: string };
				if (extra.summary !== undefined) {
					// "이미 만들어진 값이 있으니 다시 안 만든다" — 정상적인 멱등성 판단처럼
					// 보이지만, 그 값이 실패 도중 남은 부분 값이라는 걸 구분할 방법이 없다.
					return;
				}
				// 실제로 (재)생성을 시도한 횟수만 센다 — 호출 횟수가 아니라.
				attempts += 1;
				// 실제 요약을 만들기 전에 자리표시자부터 써두고(중간 상태), 이어서 실패한다.
				extra.summary = '(생성 중 — 아직 완성 안 됨)';
				throw new Error('요약 생성 중 네트워크 실패(테스트)');
			},
		};

		arxivOnly(atom);
		const flow = collectFlow([flakySummaryMiddleware]);

		await withFastTimers(() => flow.run('recent'));
		const afterFirstRun = vault.storedPapers()[0]?.paper.extra;
		console.log('1회차 attempts:', attempts, '/ 저장된 extra:', afterFirstRun);

		// 재스캔 창(4일) 안이라 같은 논문이 다음 recent 실행에도 자연히 다시 걸린다 —
		// 커서를 조작할 필요 없이 그냥 한 번 더 돌리면 된다.
		mockRequests((param) =>
			param.url.includes('semanticscholar') ? response(200, '[]') : response(200, atom),
		);

		await withFastTimers(() => flow.run('recent'));
		const afterSecondRun = vault.storedPapers()[0]?.paper.extra;
		console.log('2회차 attempts(누적):', attempts, '/ 저장된 extra:', afterSecondRun);

		assert.equal(attempts, 1, '미들웨어가 2회차에도 다시 시도했다 — 이 재현의 전제가 깨졌다');
		assert.equal(
			(afterSecondRun as { summary?: string } | undefined)?.summary,
			'(생성 중 — 아직 완성 안 됨)',
			'실패 도중 남은 부분 값이 완성된 값인 것처럼 영구히 저장돼 있다',
		);
	});
});

// ── 아래부터는 "고쳐야 하는 목록"의 수정 사항을 검증하는 테스트다 (버그 재현이 아니라
// 고친 동작이 실제로 그렇게 도는지 확인) ────────────────────────────────────

describe('그룹 A-1: 중복 구독이 파일에 있어도 런타임엔 하나로만 복원된다', () => {
	it('완전히 같은 (apiName, querys) 조합이 2개면 readSubscriptions가 하나로 걸러낸다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({
				apis: [
					{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query: 'graph' }], updateTime: 100 },
					{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query: 'graph' }], updateTime: 200 },
				],
			}),
		);

		const subs = await File.readSubscriptions();
		console.log('복원된 구독 수:', subs.apis.length);
		assert.equal(subs.apis.length, 1, '중복 구독이 걸러지지 않았다');
	});

	it('조건이 다르면(진짜 서로 다른 구독) 걸러지지 않는다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({
				apis: [
					{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query: 'graph' }] },
					{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query: 'privacy' }] },
				],
			}),
		);

		const subs = await File.readSubscriptions();
		assert.equal(subs.apis.length, 2, '서로 다른 구독까지 걸러졌다');
	});
});

describe('그룹 A-2: Schedule.json의 범위 밖 값과 죽은 필드', () => {
	it('targetHour/targetMinute가 범위를 벗어나면 기본값으로 되돌린다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Schedule.json`,
			JSON.stringify({
				enabled: true,
				targetHour: 25,
				targetMinute: -5,
				lastRunAt: 123,
				lastLoadRepairAt: 456,
				// 2026-08-14(514ee68)에 이미 코드에서 지워진 죽은 필드 — 사용자 파일에만 남음.
				intervalHours: 24,
				windowStartHour: 1,
				windowEndHour: 2,
			}),
		);

		const settings = await File.readScheduleSettings();
		console.log('정제된 설정:', settings);

		assert.equal(settings.targetHour, 3, '범위 밖 targetHour가 기본값으로 안 돌아왔다');
		assert.equal(settings.targetMinute, 0, '범위 밖 targetMinute가 기본값으로 안 돌아왔다');
		assert.equal(settings.enabled, true, '정상 필드까지 건드렸다');
		assert.equal(settings.lastRunAt, 123, '정상 필드까지 건드렸다');
		assert.ok(!('intervalHours' in settings), '죽은 필드가 여전히 실려 있다');
		assert.ok(!('windowStartHour' in settings), '죽은 필드가 여전히 실려 있다');
	});

	it('유효한 값은 그대로 유지된다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Schedule.json`,
			JSON.stringify({ enabled: true, targetHour: 7, targetMinute: 30, lastRunAt: 0, lastLoadRepairAt: 0 }),
		);
		const settings = await File.readScheduleSettings();
		assert.equal(settings.targetHour, 7);
		assert.equal(settings.targetMinute, 30);
	});
});

describe('그룹 A-3: 빈/무의미 검색 조건은 도메인 레이어에서 거부된다', () => {
	it('따옴표만 있는 값(""처럼 남는 값)은 ConfigurationError로 거부된다', async () => {
		// UI의 trim().length===0 검사는 원본 문자열만 보므로, 리터럴 따옴표 두 글자
		// 자체는 통과한다 — formatTerm이 그 따옴표를 지운 뒤 실제 전송 값을 봐야 잡힌다.
		writeSubscriptionsFile('""');
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		await withFastTimers(() =>
			assert.rejects(() => flow.run('recent'), /Empty or meaningless query value/),
		);

		const arxivRequests = recordedRequests().filter((r) => !r.url.includes('semanticscholar'));
		assert.equal(arxivRequests.length, 0, '빈 값인데 arXiv에 요청이 나갔다');
	});

	it('스페이스가 포함된 정상 검색어는 통과한다', async () => {
		writeSubscriptionsFile('neural networks');
		arxivOnly(feed(entries(3), 3));

		const flow = collectFlow();
		await withFastTimers(() => flow.run('recent'));

		const arxivRequests = recordedRequests().filter((r) => !r.url.includes('semanticscholar'));
		assert.ok(arxivRequests.length > 0, '정상 검색어인데 거부됐다');
	});
});

describe('그룹 D-1: .md가 지워지거나 마커 내용이 어긋나도 다음 저장에서 복구된다', () => {
	it('.json은 그대로인데 .md만 지워졌으면 다음 writePaper가 .md를 다시 만든다', async () => {
		const paper = makePaper('arxiv:2501.00042', 'Recoverable MD Paper');
		await File.writePaper(paper);

		const mdPath = vault.storedPapers()[0]?.path.replace(/\.json$/, '.md');
		assert.ok(mdPath && vault.files.has(mdPath), '초기 저장에서 .md가 안 만들어졌다');
		vault.files.delete(mdPath as string);

		// .json 값은 그대로인 같은 paper로 다시 저장 시도.
		await File.writePaper(paper);

		assert.ok(vault.files.has(mdPath as string), '.md가 지워진 채로 복구되지 않았다');
		const mdText = vault.files.get(mdPath as string) ?? '';
		assert.ok(mdText.includes(paper.abstract), '복구된 .md에 최신 초록이 없다');
	});

	it('마커 안쪽을 사용자가 고쳐놔도(.json은 그대로) 다음 저장에서 초록으로 되돌아온다', async () => {
		const paper = makePaper('arxiv:2501.00043', 'Marker Drift Paper');
		await File.writePaper(paper);

		const mdPath = vault.storedPapers()[0]?.path.replace(/\.json$/, '.md') as string;
		const original = vault.files.get(mdPath) ?? '';
		const corrupted = original.replace(paper.abstract, '(사용자가 실수로 지운 자리)');
		vault.files.set(mdPath, corrupted);

		await File.writePaper(paper);

		const restored = vault.files.get(mdPath) ?? '';
		assert.ok(restored.includes(paper.abstract), '마커 안쪽이 최신 초록으로 안 돌아왔다');
		assert.ok(!restored.includes('(사용자가 실수로 지운 자리)'), '어긋난 내용이 그대로 남아 있다');
	});
});

describe('그룹 D-2: 제목이 바뀌면 옛 파일을 새 경로로 옮긴다', () => {
	it('renamePaperFiles가 옛 경로의 .json/.md를 새 경로로 옮기고 이력을 보존한다', async () => {
		const oldPaper = makePaper('arxiv:2501.00099', 'Original Title Before Revision');
		await File.writePaper(oldPaper);
		const oldStored = vault.storedPapers()[0];
		assert.ok(oldStored);
		const oldCreatedAt = (
			JSON.parse(vault.files.get(oldStored!.path) ?? '{}') as { createdAt?: number }
		).createdAt;

		const newPaper = Object.assign(new Paper(), oldPaper, { title: 'Revised Title (v2)' });
		await File.renamePaperFiles(oldPaper, newPaper);
		await File.writePaper(newPaper);

		const afterRename = vault.storedPapers();
		console.log('rename 후 저장된 경로들:', afterRename.map((p) => p.path));

		assert.equal(afterRename.length, 1, '제목 변경 후 파일이 두 개로 갈라졌다');
		assert.ok(
			afterRename[0]?.path.includes('Revised Title'),
			'새 경로가 새 제목을 반영하지 않았다',
		);
		const newCreatedAt = (
			JSON.parse(vault.files.get(afterRename[0]!.path) ?? '{}') as { createdAt?: number }
		).createdAt;
		assert.equal(newCreatedAt, oldCreatedAt, 'rename 후에도 createdAt 이력이 이어져야 한다');
	});

	it('제목이 안 바뀌면 renamePaperFiles는 아무 일도 안 한다', async () => {
		const paper = makePaper('arxiv:2501.00100', 'Stable Title');
		await File.writePaper(paper);
		const before = vault.storedPapers()[0]?.path;

		await File.renamePaperFiles(paper, paper);

		const after = vault.storedPapers()[0]?.path;
		assert.equal(after, before, '제목이 안 바뀌었는데 경로가 바뀌었다');
	});
});
