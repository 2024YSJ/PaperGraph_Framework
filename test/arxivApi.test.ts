// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { ArxivAPI, S2_SECRET_PROVIDER } from '../src/collect/API';
import { Secret } from '../src/collect/Secret';
import type { SearchQuery } from '../src/collect/SearchQuery';
import { mockRequests, recordedRequests, response } from './stubs/obsidian';
import {
	entries,
	entry,
	errorFeed,
	feed,
	installDomParser,
	queryParams,
	withFastTimers,
} from './helpers/arxivFixtures';

// 네트워크(requestUrl)만 대역으로 바꾸고 나머지는 전부 실제 코드가 도는 통합 테스트.
// 검증 대상은 "가짜 arXiv 응답이 들어왔을 때 우리 파이프라인이 어떤 Paper[]와 어떤
// lastCoverage를 만들어내는가"다.

installDomParser();

const KEYWORD: SearchQuery = { searchType: 'keyword', query: 'graph neural network' };

// arXiv 조회에는 정상 피드로, S2 배치(POST)에는 빈 배열로 답하는 기본 핸들러.
// 인용수 보강은 [3] 정책이라 실패해도 수집이 안 깨지지만, 매 테스트마다 "핸들러 없음"
// 예외가 나는 걸 막기 위해 명시적으로 응답을 준다.
function arxivOnly(atom: string): void {
	mockRequests((param) => {
		if (param.url.includes('semanticscholar')) {
			return response(200, '[]');
		}
		return response(200, atom);
	});
}

function arxivRequests(): ReturnType<typeof recordedRequests> {
	return recordedRequests().filter((r) => r.url.includes('arxiv.org'));
}

function s2Requests(): ReturnType<typeof recordedRequests> {
	return recordedRequests().filter((r) => r.url.includes('semanticscholar'));
}

describe('ArxivAPI.SearchBase — 핵심 진입점(엔진 1회 호출)', () => {
	beforeEach(() => {
		arxivOnly(feed([entry()], 1));
	});

	it('요청을 정확히 한 번만 보낸다', async () => {
		await new ArxivAPI([KEYWORD]).SearchBase();
		assert.equal(arxivRequests().length, 1);
	});

	it('날짜 필터 없이, 최신순으로, 기본 조회 단위(50건)를 요청한다', async () => {
		await new ArxivAPI([KEYWORD]).SearchBase();

		const params = queryParams(arxivRequests()[0]!.url);
		assert.equal(params.get('search_query'), 'all:"graph neural network"');
		assert.equal(params.get('start'), '0');
		assert.equal(params.get('max_results'), '50');
		assert.equal(params.get('sortBy'), 'submittedDate');
		assert.equal(params.get('sortOrder'), 'descending');
	});

	it('커버리지 책임을 지지 않는다 — lastCoverage는 undefined로 남는다', async () => {
		const api = new ArxivAPI([KEYWORD]);
		await api.SearchBase();
		assert.equal(api.lastCoverage, undefined);
	});

	it('구독 조건이 비어 있으면 요청 전에 throw한다', async () => {
		await assert.rejects(() => new ArxivAPI([]).SearchBase(), /querys is empty/);
		assert.equal(arxivRequests().length, 0);
	});
});

describe('쿼리 조립 (formatTerm / buildSearchQuery)', () => {
	beforeEach(() => {
		arxivOnly(feed([entry()], 1));
	});

	it('조건 여러 개를 AND로 묶는다', async () => {
		await new ArxivAPI([
			KEYWORD,
			{ searchType: 'author', query: 'Hinton' },
			{ searchType: 'category', query: 'cs.AI' },
		]).SearchBase();

		assert.equal(
			queryParams(arxivRequests()[0]!.url).get('search_query'),
			'all:"graph neural network" AND au:"Hinton" AND cat:cs.AI',
		);
	});

	it('값 안의 따옴표를 제거해 구문 검색이 깨지지 않게 한다', async () => {
		await new ArxivAPI([{ searchType: 'keyword', query: 'say "hello" now' }]).SearchBase();
		assert.equal(
			queryParams(arxivRequests()[0]!.url).get('search_query'),
			'all:"say hello now"',
		);
	});

	it('공백이 없어도 구문 검색으로 감싼다 — 괄호 같은 문자가 문법을 깨지 않도록', async () => {
		await new ArxivAPI([{ searchType: 'keyword', query: 'foo)' }]).SearchBase();
		assert.equal(queryParams(arxivRequests()[0]!.url).get('search_query'), 'all:"foo)"');
	});

	it('모르는 searchType은 [1] 정책으로 throw한다', async () => {
		await assert.rejects(
			() => new ArxivAPI([{ searchType: 'domain', query: 'cs.AI' }]).SearchBase(),
			/Unknown searchType/,
		);
	});

	it('프로토타입 체인의 이름(toString 등)을 searchType으로 줘도 throw한다', async () => {
		await assert.rejects(
			() => new ArxivAPI([{ searchType: 'toString', query: 'x' }]).SearchBase(),
			/Unknown searchType/,
		);
	});
});

describe('필드 매핑 (parseEntry)', () => {
	it('Atom entry를 Paper로 옮긴다', async () => {
		arxivOnly(
			feed(
				[
					entry({
						id: 'http://arxiv.org/abs/2501.12345v3',
						title: 'Attention   Is\n  All You Need',
						summary: 'We propose the Transformer.',
						published: '2025-01-15T10:30:00Z',
						authors: ['Alice Kim', 'Bob Lee'],
					}),
				],
				1,
			),
		);

		const [paper] = await new ArxivAPI([KEYWORD]).SearchBase();
		assert.ok(paper);
		// 버전 접미사(v3)를 떼고 provider prefix를 붙인다
		assert.equal(paper.sourceId, 'arxiv:2501.12345');
		// 연속 공백/개행을 한 칸으로 정리한다
		assert.equal(paper.title, 'Attention Is All You Need');
		assert.equal(paper.abstract, 'We propose the Transformer.');
		assert.deepEqual(paper.authors, ['Alice Kim', 'Bob Lee']);
		// ISO 타임스탬프에서 날짜 부분만
		assert.equal(paper.publicationDate, '2025-01-15');
		// 인용수는 arXiv가 안 주므로 보강 전까지 미확인
		assert.equal(paper.citationCount, 0);
		assert.equal(paper.citationsKnown, false);
		// 임베딩은 이 API의 책임이 아니다 — 기본값만
		assert.deepEqual(paper.embedding, []);
		assert.equal(paper.embeddingSucceeded, false);
	});

	it('수집 출처를 배열로 기록한다 — 같은 인덱스가 한 쌍', async () => {
		arxivOnly(feed([entry()], 1));

		const [paper] = await new ArxivAPI([
			KEYWORD,
			{ searchType: 'category', query: 'cs.LG' },
		]).SearchBase();

		assert.ok(paper);
		assert.deepEqual(paper.collectedApis, ['arxiv']);
		assert.equal(paper.collectedQueries.length, 1);
		// 한 구독의 AND 조건들은 대표 쿼리 하나로 합성된다(combineQueries)
		assert.equal(paper.collectedQueries[0]?.searchType, 'combined');
		assert.equal(
			paper.collectedQueries[0]?.query,
			'keyword:graph neural network AND category:cs.LG',
		);
		assert.equal(paper.collectedApis.length, paper.collectedQueries.length);
	});
});

describe('[2] 정책 — 개별 논문이 불완전하면 그 논문만 제외', () => {
	it('summary가 없는 항목만 건너뛰고 나머지는 살린다', async () => {
		arxivOnly(
			feed(
				[
					entry({ id: 'http://arxiv.org/abs/2501.00001v1', title: 'Good' }),
					entry({ id: 'http://arxiv.org/abs/2501.00002v1', title: 'Bad', summary: null }),
					entry({ id: 'http://arxiv.org/abs/2501.00003v1', title: 'Also Good' }),
				],
				3,
			),
		);

		const papers = await new ArxivAPI([KEYWORD]).SearchBase();
		assert.equal(papers.length, 2);
		assert.deepEqual(
			papers.map((p) => p.sourceId),
			['arxiv:2501.00001', 'arxiv:2501.00003'],
		);
	});

	it('/abs/ 없는 id는 arXiv 논문 id가 아니므로 건너뛴다', async () => {
		arxivOnly(
			feed(
				[
					entry({ id: 'http://arxiv.org/something/else' }),
					entry({ id: 'http://arxiv.org/abs/2501.00002v1' }),
				],
				2,
			),
		);

		const papers = await new ArxivAPI([KEYWORD]).SearchBase();
		assert.equal(papers.length, 1);
		assert.equal(papers[0]?.sourceId, 'arxiv:2501.00002');
	});

	it('스킵된 건수를 lastCoverage.skippedEntries로 보고한다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(
				200,
				feed([entry({ summary: null }), entry({ title: null }), entry()], 3),
			);
		});

		const api = new ArxivAPI([KEYWORD]);
		const papers = await withFastTimers(() => api.Backfill(1_700_000_000_000, 1_700_100_000_000));

		assert.equal(papers.length, 1);
		assert.equal(api.lastCoverage?.skippedEntries, 2);
	});
});

describe('[1] 정책 — 수집 자체가 불가능하면 throw', () => {
	it('arXiv가 200 OK로 돌려주는 에러 피드를 논문으로 오인하지 않는다', async () => {
		arxivOnly(errorFeed('incorrect id format for 2501.abcde'));

		await assert.rejects(
			() => new ArxivAPI([KEYWORD]).SearchBase(),
			/arXiv rejected the query: incorrect id format/,
		);
	});

	it('XML이 깨졌으면 "결과 없음"으로 삼키지 않고 throw한다', async () => {
		arxivOnly('<feed><entry></feed>');
		await assert.rejects(() => new ArxivAPI([KEYWORD]).SearchBase(), /well-formed XML/);
	});

	it('재시도 대상이 아닌 HTTP 에러는 즉시 throw한다', async () => {
		mockRequests(() => response(400, 'bad request'));

		await assert.rejects(() => new ArxivAPI([KEYWORD]).SearchBase(), /HTTP 400/);
		// 400은 다시 보내도 같은 결과이므로 재시도하지 않는다
		assert.equal(arxivRequests().length, 1);
	});

	it('구간이 NaN이면 요청을 보내기 전에 throw한다', async () => {
		arxivOnly(feed([entry()], 1));

		const api = new ArxivAPI([KEYWORD]);
		await assert.rejects(() => api.Backfill(Number.NaN, Date.now()), /invalid date window/);
		assert.equal(arxivRequests().length, 0);
	});
});

describe('재시도 (일시적 장애만)', () => {
	it('503을 만나면 재시도하고, 성공하면 그 결과를 쓴다', async () => {
		let attempt = 0;
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			attempt += 1;
			return attempt < 3 ? response(503, 'busy') : response(200, feed([entry()], 1));
		});

		const papers = await withFastTimers(() => new ArxivAPI([KEYWORD]).SearchBase());
		assert.equal(papers.length, 1);
		assert.equal(arxivRequests().length, 3);
	});

	it('재시도를 다 쓰면 "temporary"를 밝히며 throw한다', async () => {
		mockRequests(() => response(503, 'busy'));

		await assert.rejects(
			() => withFastTimers(() => new ArxivAPI([KEYWORD]).SearchBase()),
			/HTTP 503 \(temporary\) after 3 attempts/,
		);
		assert.equal(arxivRequests().length, 3);
	});

	it('Retry-After 헤더가 있으면 그 값을 따른다', async () => {
		let attempt = 0;
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			attempt += 1;
			return attempt === 1
				? response(429, 'slow down', { 'Retry-After': '1' })
				: response(200, feed([entry()], 1));
		});

		const papers = await withFastTimers(() => new ArxivAPI([KEYWORD]).SearchBase());
		assert.equal(papers.length, 1);
		assert.equal(arxivRequests().length, 2);
	});
});

describe('날짜 구간 수집 — 페이지네이션과 커버리지', () => {
	const FROM = Date.UTC(2025, 0, 1, 0, 0);
	const TO = Date.UTC(2025, 0, 31, 0, 0);

	it('제출일 구간 필터를 arXiv 문법으로 만든다', async () => {
		arxivOnly(feed([entry()], 1));

		await withFastTimers(() => new ArxivAPI([KEYWORD]).Backfill(FROM, TO));

		const searchQuery = queryParams(arxivRequests()[0]!.url).get('search_query');
		assert.equal(
			searchQuery,
			'all:"graph neural network" AND submittedDate:[202501010000 TO 202501310000]',
		);
		// URLSearchParams가 '+'로 인코딩해야 arXiv가 range 문법으로 읽는다.
		// 문자열에 '+'를 직접 넣으면 '%2B'로 이스케이프돼 필터가 통째로 무시된다.
		assert.ok(arxivRequests()[0]!.url.includes('TO+202501310000'));
	});

	it('구간 수집은 ascending으로 요청한다 — 잘려도 이어받을 수 있도록', async () => {
		arxivOnly(feed([entry()], 1));

		await withFastTimers(() => new ArxivAPI([KEYWORD]).Backfill(FROM, TO));
		assert.equal(queryParams(arxivRequests()[0]!.url).get('sortOrder'), 'ascending');
	});

	it('한 페이지를 다 채우면 다음 페이지를 이어 받는다', async () => {
		// 100 + 100 + 30 = 230건
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			const count = start >= 200 ? 30 : 100;
			return response(200, feed(entries(count, start), 230));
		});

		const api = new ArxivAPI([KEYWORD]);
		const papers = await withFastTimers(() => api.Backfill(FROM, TO));

		assert.equal(papers.length, 230);
		assert.deepEqual(
			arxivRequests().map((r) => queryParams(r.url).get('start')),
			['0', '100', '200'],
		);
		assert.equal(api.lastCoverage?.pages, 3);
		assert.equal(api.lastCoverage?.truncated, false);
		assert.equal(api.lastCoverage?.totalResults, 230);
		// 구간 전체를 훑었으므로 커서는 요청한 끝까지 인정
		assert.equal(api.lastCoverage?.coveredThrough, TO);
	});

	it('totalResults에 도달하면 페이지가 꽉 찼어도 멈춘다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			return response(200, feed(entries(100, start), 200));
		});

		const api = new ArxivAPI([KEYWORD]);
		await withFastTimers(() => api.Backfill(FROM, TO));

		assert.equal(arxivRequests().length, 2);
		assert.equal(api.lastCoverage?.pages, 2);
		assert.equal(api.lastCoverage?.truncated, false);
	});

	it('totalResults 태그가 없어도(-1) 페이지가 안 찬 시점에 멈춘다', async () => {
		arxivOnly(feed(entries(40))); // totalResults 태그 없음

		const api = new ArxivAPI([KEYWORD]);
		await withFastTimers(() => api.Backfill(FROM, TO));

		assert.equal(arxivRequests().length, 1);
		assert.equal(api.lastCoverage?.totalResults, -1);
		assert.equal(api.lastCoverage?.truncated, false);
	});

	it('상한(MAX_PAGES)에 걸리면 truncated로 표시하고 실제로 훑은 지점까지만 인정한다', async () => {
		// 매 페이지가 꽉 차고 totalResults도 크게 보고 → 20페이지에서 강제 중단
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			// 페이지가 진행될수록 제출일이 늦어진다(ascending 가정과 같은 모양)
			const day = Math.min(28, 1 + Math.floor(start / 100));
			return response(200, feed(entries(100, start, day), 99_999));
		});

		const api = new ArxivAPI([KEYWORD]);
		const papers = await withFastTimers(() => api.Backfill(FROM, TO));

		assert.equal(papers.length, 2000);
		assert.equal(arxivRequests().length, 20);

		const coverage = api.lastCoverage;
		assert.ok(coverage);
		assert.equal(coverage.truncated, true);
		assert.equal(coverage.pages, 20);
		// 커서는 windowTo가 아니라 마지막으로 실제 확인한 제출 시각이어야 한다.
		// 이걸 windowTo로 저장하면 못 본 구간이 영구 누락된다.
		assert.ok(coverage.coveredThrough < TO);
		assert.equal(new Date(coverage.coveredThrough).toISOString().slice(0, 10), '2025-01-20');
	});

	it('빈/역전 구간은 요청조차 하지 않고 즉시 끝낸다', async () => {
		arxivOnly(feed([entry()], 1));

		const api = new ArxivAPI([KEYWORD]);
		const papers = await api.Backfill(TO, FROM); // from >= to

		assert.deepEqual(papers, []);
		assert.equal(arxivRequests().length, 0);
		assert.equal(api.lastCoverage?.pages, 0);
		assert.equal(api.lastCoverage?.truncated, false);
		assert.equal(api.lastCoverage?.coveredThrough, FROM);
	});

	it('SearchRecentPaper는 now-hours ~ now 구간으로 조회한다', async () => {
		arxivOnly(feed([entry()], 1));

		const before = Date.now();
		await withFastTimers(() => new ArxivAPI([KEYWORD]).SearchRecentPaper(24));
		const after = Date.now();

		const searchQuery = queryParams(arxivRequests()[0]!.url).get('search_query') ?? '';
		const match = /submittedDate:\[(\d{12}) TO (\d{12})\]/.exec(searchQuery);
		assert.ok(match, `구간 필터를 찾지 못함: ${searchQuery}`);

		const parse = (s: string): number =>
			Date.UTC(
				Number(s.slice(0, 4)),
				Number(s.slice(4, 6)) - 1,
				Number(s.slice(6, 8)),
				Number(s.slice(8, 10)),
				Number(s.slice(10, 12)),
			);
		const spanMs = parse(match[2]!) - parse(match[1]!);
		// 분 단위로 잘리므로 24시간에서 최대 1분 오차
		assert.ok(Math.abs(spanMs - 24 * 60 * 60 * 1000) <= 60_000, `구간 길이: ${spanMs}ms`);
		assert.ok(parse(match[2]!) >= before - 60_000 && parse(match[2]!) <= after + 60_000);
	});
});

describe('[3] 정책 — S2 인용수 보강은 실패해도 수집을 깨지 않는다', () => {
	const okFeed = feed(
		[
			entry({ id: 'http://arxiv.org/abs/2501.00001v1' }),
			entry({ id: 'http://arxiv.org/abs/2501.00002v2' }),
		],
		2,
	);

	it('배치 응답의 citationCount로 채우고 citationsKnown을 켠다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(
					200,
					JSON.stringify([
						{ externalIds: { ArXiv: '2501.00001' }, citationCount: 42 },
						{ externalIds: { ArXiv: '2501.00002' }, citationCount: 7 },
					]),
				);
			}
			return response(200, okFeed);
		});

		const papers = await new ArxivAPI([KEYWORD]).SearchBase();
		assert.deepEqual(
			papers.map((p) => [p.sourceId, p.citationCount, p.citationsKnown]),
			[
				['arxiv:2501.00001', 42, true],
				['arxiv:2501.00002', 7, true],
			],
		);
	});

	it('요청 id를 ARXIV: 접두사로 배치 조회한다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, okFeed);
		});

		await new ArxivAPI([KEYWORD]).SearchBase();

		const s2 = s2Requests();
		assert.equal(s2.length, 1);
		const batch = s2[0];
		assert.ok(batch);
		assert.equal(batch.method, 'POST');
		assert.deepEqual(JSON.parse(batch.body ?? ''), {
			ids: ['ARXIV:2501.00001', 'ARXIV:2501.00002'],
		});
	});

	it('응답 순서가 밀리면 그 항목을 버린다 — 틀린 인용수를 넣지 않는다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				// 한 칸 밀린 응답: 첫 자리에 두 번째 논문의 레코드가 들어왔다
				return response(
					200,
					JSON.stringify([
						{ externalIds: { ArXiv: '2501.00002' }, citationCount: 7 },
						{ externalIds: { ArXiv: '2501.00003' }, citationCount: 99 },
					]),
				);
			}
			return response(200, okFeed);
		});

		const papers = await new ArxivAPI([KEYWORD]).SearchBase();
		// 둘 다 id가 안 맞으므로 아무것도 채우지 않는다 → 다음 수집에서 재시도 가능
		assert.deepEqual(
			papers.map((p) => p.citationsKnown),
			[false, false],
		);
	});

	it('id를 밝히지 않는 레코드는 순서를 신뢰한다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, JSON.stringify([{ citationCount: 5 }, null]));
			}
			return response(200, okFeed);
		});

		const papers = await new ArxivAPI([KEYWORD]).SearchBase();
		assert.equal(papers[0]?.citationCount, 5);
		assert.equal(papers[0]?.citationsKnown, true);
		// null 자리는 매칭 실패 → 미확인으로 남는다
		assert.equal(papers[1]?.citationsKnown, false);
	});

	it('S2가 통째로 실패해도 수집 결과는 그대로 반환한다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(500, 'boom');
			}
			return response(200, okFeed);
		});

		const papers = await withFastTimers(() => new ArxivAPI([KEYWORD]).SearchBase());
		assert.equal(papers.length, 2);
		assert.deepEqual(
			papers.map((p) => p.citationsKnown),
			[false, false],
		);
	});

	it('Secret에 키가 있으면 x-api-key로 실어 보낸다', async () => {
		const secret = Secret.fromJSON({ [S2_SECRET_PROVIDER]: 'sk-test-123' });
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, okFeed);
		});

		await new ArxivAPI([KEYWORD], secret).SearchBase();
		assert.equal(s2Requests()[0]?.headers?.['x-api-key'], 'sk-test-123');
	});

	it('키가 없으면 헤더 없이 익명으로 호출한다 — 키는 선택 사항', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			return response(200, okFeed);
		});

		await new ArxivAPI([KEYWORD]).SearchBase();
		assert.equal(s2Requests()[0]?.headers, undefined);
	});
});
