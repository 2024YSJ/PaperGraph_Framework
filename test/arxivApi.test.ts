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

	// 라운드당 상한(MAX_PAGES=20페이지=2000건)에 걸려도 Backfill은 거기서 끝내지 않는다.
	// 잘린 지점부터 새 구간으로 다시 훑기를 반복해 요청한 범위를 완주해야 한다.
	// 아래 목은 실제 arXiv처럼 submittedDate 필터를 해석해, 이어받기가 정말로 남은
	// 구간만 가져오는지 검사한다(필터를 무시하는 목은 이걸 증명하지 못한다).
	describe('라운드 이어받기 — 상한을 넘겨도 구간을 완주한다', () => {
		// 2025-01-02부터 1분 간격으로 제출된 논문 corpusSize편.
		function mockArxivCorpus(corpusSize: number): void {
			const base = Date.UTC(2025, 0, 2, 0, 0);
			const at = (i: number): number => base + i * 60_000;

			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(200, '[]');
				}
				const params = queryParams(param.url);
				const range = /submittedDate:\[(\d{12}) TO (\d{12})\]/.exec(
					params.get('search_query') ?? '',
				);
				assert.ok(range, 'Backfill 요청에는 항상 제출일 구간 필터가 있어야 한다');
				const parse = (s: string): number =>
					Date.UTC(
						Number(s.slice(0, 4)),
						Number(s.slice(4, 6)) - 1,
						Number(s.slice(6, 8)),
						Number(s.slice(8, 10)),
						Number(s.slice(10, 12)),
					);
				// arXiv의 범위는 양끝 포함 — 경계 논문이 다음 라운드에 또 걸리는 원인이다.
				const lo = parse(range[1]!);
				const hi = parse(range[2]!);

				const matched: number[] = [];
				for (let i = 0; i < corpusSize; i += 1) {
					if (at(i) >= lo && at(i) <= hi) {
						matched.push(i);
					}
				}
				const start = Number(params.get('start'));
				const page = matched.slice(start, start + 100);
				return response(
					200,
					feed(
						page.map((i) =>
							entry({
								id: `http://arxiv.org/abs/2501.${String(i).padStart(5, '0')}v1`,
								title: `Paper ${i}`,
								published: new Date(at(i)).toISOString(),
							}),
						),
						matched.length,
					),
				);
			});
		}

		it('2000건을 넘겨도 끊지 않고 요청한 범위를 전부 가져온다', async () => {
			mockArxivCorpus(2500);

			const api = new ArxivAPI([KEYWORD]);
			const papers = await withFastTimers(() => api.Backfill(FROM, TO));

			// 라운드 1에서 2000건, 이어받아 나머지 500건. 한 편도 잃지 않아야 한다.
			assert.equal(papers.length, 2500);
			assert.equal(new Set(papers.map((p) => p.sourceId)).size, 2500);

			const coverage = api.lastCoverage;
			assert.ok(coverage);
			// 완주했으므로 잘리지 않았고, 커서는 요청한 끝까지 인정된다.
			assert.equal(coverage.truncated, false);
			assert.equal(coverage.coveredThrough, TO);
			// 페이지 수는 라운드에 걸쳐 누적된다(20 + 나머지).
			assert.ok(coverage.pages > 20, `pages=${coverage.pages}`);
		});

		it('이어받기 경계에서 생긴 중복은 sourceId로 걸러낸다', async () => {
			// 경계 분(分)의 논문은 [A TO B]가 양끝을 포함하는 탓에 반드시 두 번 온다.
			// 그래도 최종 결과에 중복이 남으면 안 된다.
			mockArxivCorpus(2100);

			const api = new ArxivAPI([KEYWORD]);
			const papers = await withFastTimers(() => api.Backfill(FROM, TO));

			const ids = papers.map((p) => p.sourceId);
			assert.equal(ids.length, new Set(ids).size, '중복 논문이 남아 있다');
			assert.equal(papers.length, 2100);
		});
	});

	it('커서가 전진하지 않으면 무한 루프에 빠지지 않고 truncated로 끝낸다', async () => {
		// 필터를 무시하고 항상 같은 구간을 돌려주는 목 — 이어받아도 커서가 그대로다.
		// 실제로는 한 분에 2000건이 몰린 경우에 해당한다. 여기서 멈추지 못하면 무한 루프다.
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			const start = Number(queryParams(param.url).get('start'));
			return response(200, feed(entries(100, start, 20), 99_999));
		});

		const api = new ArxivAPI([KEYWORD]);
		const papers = await withFastTimers(() => api.Backfill(FROM, TO));

		// 라운드 1(20페이지) + 진행 없음을 확인하는 라운드 2(20페이지)에서 종료.
		assert.equal(arxivRequests().length, 40);
		assert.equal(papers.length, 2000); // 2라운드는 같은 논문이라 중복 제거됨

		const coverage = api.lastCoverage;
		assert.ok(coverage);
		// 커서는 windowTo가 아니라 마지막으로 실제 확인한 제출 시각이어야 한다.
		// 이걸 windowTo로 저장하면 못 본 구간이 영구 누락된다.
		assert.equal(coverage.truncated, true);
		assert.ok(coverage.coveredThrough < TO);
		assert.equal(new Date(coverage.coveredThrough).toISOString().slice(0, 10), '2025-01-20');
	});

	// CollectOptions.onTotal — 진행률 UI가 "지금까지 받은 페이지 수"가 아니라 진짜
	// 총계를 분모로 쓸 수 있게 첫 페이지 응답에서 한 번 알려준다.
	describe('CollectOptions.onTotal — 진짜 총계를 한 번만 보고한다', () => {
		it('첫 페이지 응답에서 곧바로 총계를 알려준다 — 전체를 다 받을 때까지 기다리지 않는다', async () => {
			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(200, '[]');
				}
				const start = Number(queryParams(param.url).get('start'));
				// 총 250건: 100 + 100 + 50, 3페이지에 걸쳐 받는다.
				const remaining = Math.max(0, 250 - start);
				return response(200, feed(entries(Math.min(100, remaining), start), 250));
			});

			const totals: number[] = [];
			const api = new ArxivAPI([KEYWORD]);
			await withFastTimers(() =>
				api.Backfill(FROM, TO, { onTotal: (total) => totals.push(total) }),
			);

			// 페이지가 3개인데도 한 번만, 그것도 250(진짜 총계)으로 불려야 한다 — 받은
			// 페이지 수(100/200/300)를 총계로 착각하면 안 된다.
			assert.deepEqual(totals, [250]);
		});

		it('여러 라운드로 나뉘어도(상한 초과) 총계는 첫 라운드 값 그대로, 한 번만 보고된다', async () => {
			const base = Date.UTC(2025, 0, 2, 0, 0);
			const at = (i: number): number => base + i * 60_000;
			const corpusSize = 2500;

			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(200, '[]');
				}
				const params = queryParams(param.url);
				const range = /submittedDate:\[(\d{12}) TO (\d{12})\]/.exec(
					params.get('search_query') ?? '',
				);
				assert.ok(range);
				const parse = (s: string): number =>
					Date.UTC(
						Number(s.slice(0, 4)),
						Number(s.slice(4, 6)) - 1,
						Number(s.slice(6, 8)),
						Number(s.slice(8, 10)),
						Number(s.slice(10, 12)),
					);
				const lo = parse(range[1]!);
				const hi = parse(range[2]!);
				const matched: number[] = [];
				for (let i = 0; i < corpusSize; i += 1) {
					if (at(i) >= lo && at(i) <= hi) {
						matched.push(i);
					}
				}
				const start = Number(params.get('start'));
				const page = matched.slice(start, start + 100);
				return response(
					200,
					feed(
						page.map((i) =>
							entry({
								id: `http://arxiv.org/abs/2501.${String(i).padStart(5, '0')}v1`,
								published: new Date(at(i)).toISOString(),
							}),
						),
						// 라운드 2부터는 dateFilter가 좁아져 matched.length(남은 건수)가
						// 2500보다 작아진다 — onTotal이 이 값을 보고하면 버그다.
						matched.length,
					),
				);
			});

			const totals: number[] = [];
			const api = new ArxivAPI([KEYWORD]);
			await withFastTimers(() =>
				api.Backfill(FROM, TO, { onTotal: (total) => totals.push(total) }),
			);

			// 라운드가 여러 개 돌았을 텐데(2500건은 2000건 상한을 넘음) 첫 라운드의
			// 진짜 총계(2500) 한 번만 보고돼야 한다.
			assert.deepEqual(totals, [2500]);
		});

		it('구간에 결과가 하나도 없으면 총계 0으로 보고한다', async () => {
			// totalResults(0)도 "arXiv가 읽어준 값"이라 -1(못 읽음)과는 다르다 — 0/0으로
			// 표시되는 게 "아직 모름"보다 정확하다.
			arxivOnly(feed([], 0));

			const totals: number[] = [];
			const api = new ArxivAPI([KEYWORD]);
			await withFastTimers(() =>
				api.Backfill(FROM, TO, { onTotal: (total) => totals.push(total) }),
			);

			assert.deepEqual(totals, [0]);
		});

		it('arXiv가 총계를 못 읽어주면(-1) 부르지 않는다', async () => {
			arxivOnly(feed(entries(1))); // totalResults 태그 없음 -> -1 폴백
			const totals: number[] = [];
			const api = new ArxivAPI([KEYWORD]);
			await withFastTimers(() =>
				api.Backfill(FROM, TO, { onTotal: (total) => totals.push(total) }),
			);

			assert.deepEqual(totals, []);
		});
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

	// arXiv Atom 응답에는 참고문헌이 아예 없다. 이 S2 배치 조회가 paper.references가
	// 채워지는 유일한 경로다 — 시각화(008의 CitationEdgeMiddleware)가 이 값으로 인용
	// 엣지를 그리므로, 비어 있으면 그래프에 엣지가 하나도 안 그려진다.
	describe('references — 인용 그래프 엣지의 유일한 공급원', () => {
		it('references.externalIds 필드를 함께 요청한다', async () => {
			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(200, '[]');
				}
				return response(200, okFeed);
			});

			await new ArxivAPI([KEYWORD]).SearchBase();
			const url = s2Requests()[0]?.url ?? '';
			assert.ok(
				decodeURIComponent(url).includes('references.externalIds'),
				`references를 요청하지 않았다: ${url}`,
			);
		});

		it('arXiv id가 있는 참고문헌만 sourceId 형태로 채운다', async () => {
			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(
						200,
						JSON.stringify([
							{
								externalIds: { ArXiv: '2501.00001' },
								citationCount: 42,
								references: [
									{ externalIds: { ArXiv: '1706.03762v5' } }, // 버전 접미사는 떼야 한다
									{ externalIds: { DOI: '10.1000/journal' } }, // arXiv 아님 → 버린다
									{ externalIds: { ArXiv: '2010.11929' } },
									null, // S2가 가끔 null을 섞어 보낸다
									{ externalIds: null },
								],
							},
							{ externalIds: { ArXiv: '2501.00002' }, citationCount: 7, references: [] },
						]),
					);
				}
				return response(200, okFeed);
			});

			const papers = await new ArxivAPI([KEYWORD]).SearchBase();
			// arXiv에 없는 참고문헌은 이 코퍼스의 노드가 될 수 없어 저장하지 않는다.
			assert.deepEqual(papers[0]?.references, ['arxiv:1706.03762', 'arxiv:2010.11929']);
			assert.deepEqual(papers[1]?.references, []);
		});

		it('같은 논문을 버전만 다르게 여러 번 인용해도 하나로 합친다', async () => {
			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					return response(
						200,
						JSON.stringify([
							{
								externalIds: { ArXiv: '2501.00001' },
								citationCount: 1,
								references: [
									{ externalIds: { ArXiv: '1706.03762v1' } },
									{ externalIds: { ArXiv: '1706.03762v5' } },
									{ externalIds: { ArXiv: '1706.03762' } },
								],
							},
						]),
					);
				}
				return response(200, okFeed);
			});

			const papers = await new ArxivAPI([KEYWORD]).SearchBase();
			assert.deepEqual(papers[0]?.references, ['arxiv:1706.03762']);
		});

		it('S2가 references를 안 주면 빈 배열로 남긴다 — 인용수는 정상 반영', async () => {
			mockRequests((param) => {
				if (param.url.includes('semanticscholar')) {
					// references 필드 자체가 없는 응답(구버전 API/부분 응답 등)
					return response(
						200,
						JSON.stringify([{ externalIds: { ArXiv: '2501.00001' }, citationCount: 3 }]),
					);
				}
				return response(200, okFeed);
			});

			const papers = await new ArxivAPI([KEYWORD]).SearchBase();
			assert.deepEqual(papers[0]?.references, []);
			assert.equal(papers[0]?.citationCount, 3);
			assert.equal(papers[0]?.citationsKnown, true);
		});
	});
});

// ── 응답 없는 요청 ────────────────────────────────────────────────────
// Obsidian requestUrl에는 타임아웃 옵션이 없다(RequestUrlParam에 필드 자체가 없음).
// 시한을 걸지 않으면 응답이 안 오는 요청 하나가 Promise를 영원히 붙들어, 에러도 Notice도
// 없이 수집 전체가 멈춘다 — 스로틀 중인 서버에서 실제로 겪은 증상이다.
describe('요청 타임아웃 — 응답이 안 와도 멈추지 않는다', () => {
	it('시한을 넘기면 재시도하고, 끝내 응답이 없으면 에러로 끝낸다', async () => {
		mockRequests((param) => {
			if (param.url.includes('semanticscholar')) {
				return response(200, '[]');
			}
			// 영원히 resolve하지 않는다 = 서버가 연결만 잡고 응답을 안 주는 상태.
			return new Promise<never>(() => {
				/* 의도적으로 아무것도 하지 않는다 */
			});
		});

		const api = new ArxivAPI([KEYWORD]);

		// withFastTimers가 setTimeout 지연을 0으로 만들어 60초를 기다리지 않는다.
		await assert.rejects(
			() => withFastTimers(() => api.SearchBase()),
			// 타임아웃은 재시도 가능 계열이라 시도를 다 소진한 뒤 "temporary"로 끝난다.
			/응답 없음\(timeout\).*temporary/,
		);

		// 기본 재시도 횟수(3회)만큼 실제로 다시 시도했어야 한다 — 한 번 멈추고 포기하면
		// 일시적 장애에서 불필요하게 실패한다.
		assert.equal(arxivRequests().length, 3);
	});
});
