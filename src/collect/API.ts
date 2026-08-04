import { SearchQuery, combineQueries } from './SearchQuery';
import { Paper } from './Paper';
import {
	delay,
	enrichQuietly,
	hasRequiredFields,
	parseXml,
	requestWithRetry,
} from './ApiSupport';

// 빈 껍데기 — 나머지 필요한 함수는 신빈이 채운다.
export interface API {
	// 이 API의 식별자(예: 'arxiv', 'semanticScholar'). Subscriptions.json에 저장되고,
	// 나중에 저장된 구독을 다시 읽을 때 어떤 API 구현체로 복원할지 판별하는 키로 쓴다
	// (API 팩토리/레지스트리 — 신빈의 API 구현 시 확정). 002.md 참고.
	apiName: string;
	querys: SearchQuery[];
	SearchBase(): Promise<Paper[]>;
	SearchRecentPaper(hours: number): Promise<Paper[]>;
	Backfill(from: number, to: number): Promise<Paper[]>;
}

// SearchQuery.searchType 허용값 (2026-08-04 확정, docs/devLog/004.md 예정).
// 구독은 API 단위 + 최대 3조건, 조건들은 전부 AND로 묶는다(넓히는 OR이 아니라 좁히는 AND).
// - keyword: 제목+초록+저자 등 전체 검색 (arXiv all:)
// - author: 저자명 (arXiv au:)
// - category: 분류, arXiv 전용 값 체계(cs.AI 등) — 다른 API에서는 안 쓰일 수 있음
const ARXIV_FIELD_PREFIX: Record<string, string> = {
	keyword: 'all',
	author: 'au',
	category: 'cat',
};

const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';

// SearchBase()처럼 "맛보기" 성격의 단발 조회에서 가져올 건수.
const MAX_RESULTS = 50;

// 날짜 구간 수집(SearchRecentPaper/Backfill)의 페이지 설정. 이 두 경로는 "구간 안의
// 논문을 빠짐없이" 가져오는 게 목적이라 단발 조회로는 안 되고 start를 올려가며 이어받는다.
// - PAGE_SIZE: arXiv는 요청당 최대 2000건까지 허용하지만 응답이 커질수록 타임아웃/스로틀
//   확률이 올라가므로 100건씩 나눠 받는다.
// - MAX_PAGES: 구간을 잘못 준 경우 무한정 긁는 사고를 막는 상한 (최대 2000건).
// - ARXIV_PAGE_DELAY_MS: arXiv 이용약관이 권장하는 연속 호출 간격.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ARXIV_PAGE_DELAY_MS = 3_000;

// arXiv 에러 응답의 <id>에 들어가는 표식. 아래 assertNotErrorEntry 참고.
const ARXIV_ERROR_ID_MARK = 'arxiv.org/api/errors';

const OPENSEARCH_NS = 'http://a9.com/-/spec/opensearch/1.1/';

// timestamp(ms) -> arXiv submittedDate 필터가 요구하는 "YYYYMMDDHHMM"(UTC) 포맷.
function formatArxivDate(timestampMs: number): string {
	const d = new Date(timestampMs);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return (
		String(d.getUTCFullYear()) +
		pad(d.getUTCMonth() + 1) +
		pad(d.getUTCDate()) +
		pad(d.getUTCHours()) +
		pad(d.getUTCMinutes())
	);
}

// 제출일 구간 필터를 만든다. 구분자는 반드시 "진짜 공백"이어야 한다 — buildUrl의
// URLSearchParams가 공백을 '+'로 인코딩해 주기 때문이다. 예전처럼 '+'를 문자열에 직접
// 넣으면 URLSearchParams가 그걸 리터럴 플러스로 보고 '%2B'로 이스케이프해서, arXiv가
// range 문법(`[A TO B]`)으로 인식하지 못하고 날짜 필터가 통째로 무시된다.
// 두 호출부(SearchRecentPaper/Backfill)가 같은 실수를 반복하지 않도록 여기로 모았다.
function buildDateFilter(fromMs: number, toMs: number): string {
	return `submittedDate:[${formatArxivDate(fromMs)} TO ${formatArxivDate(toMs)}]`;
}

// 조건 하나를 "prefix:value" 항으로 변환.
// 값 안의 따옴표는 제거한다 — 남겨두면 값이 구문 검색의 닫는 따옴표를 먼저 끝내버려
// 쿼리 구조가 깨진다. 그리고 "공백이 있을 때만 감싸기"는 `foo)`처럼 공백 없이도 문법을
// 깨뜨리는 값을 놓치므로, keyword/author는 길이와 무관하게 항상 구문 검색으로 감싼다.
// category(cat:)는 cs.AI 같은 고정 토큰이라 감싸지 않는다.
function formatTerm(query: SearchQuery): string {
	// typeof로 검사하는 이유: Subscriptions.json은 사용자가 편집할 수 있고, searchType이
	// 'toString'/'constructor' 같은 값이면 프로토타입 체인을 타고 함수가 잡힌다. 그러면
	// truthy라서 "Unknown searchType" 가드를 통과해버리고 쿼리에 함수 소스가 박힌다.
	const prefix = ARXIV_FIELD_PREFIX[query.searchType];
	if (typeof prefix !== 'string') {
		throw new Error(`Unknown searchType for arXiv: ${query.searchType}`);
	}
	const value = query.query.replace(/"/g, '');
	return prefix === 'cat' ? `${prefix}:${value}` : `${prefix}:"${value}"`;
}

// 여러 조건을 AND로 묶은 arXiv search_query 문자열로 변환.
function buildSearchQuery(querys: SearchQuery[]): string {
	return querys.map(formatTerm).join(' AND ');
}

function text(el: Element | null): string {
	return el?.textContent?.trim() ?? '';
}

// "2501.12345v2" -> "2501.12345". arXiv id는 어디서 왔든(피드의 <id>, S2의 externalIds)
// 버전 접미사가 붙어 올 수 있으므로, 비교/저장 전에 항상 이걸 통과시킨다.
function stripArxivVersion(id: string): string {
	return id.replace(/v\d+$/, '');
}

// "http://arxiv.org/abs/2501.12345v2" -> "2501.12345".
// /abs/ 세그먼트가 없는 id는 arXiv 논문 id가 아니므로 원본을 그대로 돌려주지 않고 ''을
// 반환한다. 예전에는 `?? rawId`로 원본을 흘려보내서 호출자의 빈 값 가드가 절대 걸리지
// 않았고, 그 탓에 에러 응답의 URL이 sourceId로 둔갑했다.
function extractArxivId(rawId: string): string {
	const abs = rawId.split('/abs/')[1];
	if (!abs) {
		return '';
	}
	return stripArxivVersion(abs);
}

// <published>(제출 시각, ISO 8601)를 epoch ms로. 커버리지 커서로 쓰므로 날짜 단위인
// Paper.publicationDate가 아니라 원본 타임스탬프를 그대로 읽는다.
function publishedEpochMs(entry: Element): number | undefined {
	const raw = text(entry.querySelector('published'));
	if (!raw) {
		return undefined;
	}
	const ms = new Date(raw).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

// [1] 정책 — arXiv는 잘못된 쿼리에 HTTP 에러가 아니라 <entry> 1개짜리 "정상" Atom 피드를
// 돌려준다 (<title>Error</title>, <id>http://arxiv.org/api/errors#...</id>).
// id/title/summary가 모두 채워져 있어 필수 필드 검사를 통과해버리므로, 여기서 걸러
// 예외로 올리지 않으면 쿼리가 깨져도 "가짜 논문 1건"만 조용히 반환된다.
function assertNotErrorEntry(entry: Element): void {
	const rawId = text(entry.querySelector('id'));
	if (!rawId.includes(ARXIV_ERROR_ID_MARK)) {
		return;
	}
	const reason = text(entry.querySelector('summary')) || rawId;
	throw new Error(`arXiv rejected the query: ${reason}`);
}

// <opensearch:totalResults>를 읽어 이 검색의 전체 건수를 돌려준다. 페이지를 더 받을지
// 판단하는 데 쓴다. 읽지 못하면 -1을 반환해 호출자가 다른 기준으로 종료하게 한다.
//
// 빈 문자열을 먼저 걸러야 한다 — Number('')는 NaN이 아니라 0이라, 그냥 Number()에
// 넘기면 "태그를 못 읽음"이 "전체 0건"으로 둔갑한다. 그러면 호출자가 첫 페이지 직후
// 수집을 끝내면서 전 구간을 다 훑었다고 기록해버린다.
function readTotalResults(xml: Document): number {
	const el =
		xml.getElementsByTagNameNS(OPENSEARCH_NS, 'totalResults')[0] ??
		xml.getElementsByTagName('opensearch:totalResults')[0];
	const raw = text(el ?? null);
	if (!raw) {
		return -1;
	}
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : -1;
}

// [2] 정책 — 필수 필드(id/title/summary)가 없는 항목은 undefined를 반환해 호출자가
// 그 논문만 건너뛰게 한다. 전체 수집을 실패시키지 않는다.
function parseEntry(entry: Element, collectedQuery: SearchQuery): Paper | undefined {
	const rawId = text(entry.querySelector('id'));
	const title = text(entry.querySelector('title')).replace(/\s+/g, ' ');
	const abstract = text(entry.querySelector('summary'));
	if (!hasRequiredFields(rawId, title, abstract)) {
		return undefined;
	}

	// arXiv 논문 id로 해석되지 않는 항목(예: /abs/ 없는 id)은 sourceId를 만들 수 없으므로
	// [2] 정책대로 이 항목만 건너뛴다.
	const arxivId = extractArxivId(rawId);
	if (!arxivId) {
		return undefined;
	}

	const paper = new Paper();
	paper.title = title;
	paper.authors = Array.from(entry.querySelectorAll('author > name')).map((n) => text(n));
	paper.abstract = abstract;
	paper.sourceId = `arxiv:${arxivId}`;
	paper.references = [];

	// <published>는 최초 버전 제출일(ISO 8601) — 앞 10자(YYYY-MM-DD)만 취한다.
	paper.publicationDate = text(entry.querySelector('published')).slice(0, 10);

	// arXiv 응답엔 인용수가 없다. [3] 정책 — 보강 단계에서 채워지며, 실패하면 false로 남는다.
	paper.citationCount = 0;
	paper.citationsKnown = false;

	paper.collectedApi = 'arxiv';
	paper.collectedQuery = collectedQuery;

	// 임베딩은 이 API의 책임이 아니다 (성진 담당) — 기본값만 채운다.
	paper.embedding = [];
	paper.embeddingModel = '';
	paper.embeddingSource = '';
	paper.embeddingSucceeded = false;

	return paper;
}

// 한 페이지 응답의 파싱 결과. entryCount/totalResults는 "다음 페이지가 남았는가"를
// 판단하는 데만 쓴다 — papers.length는 [2] 정책으로 건너뛴 항목만큼 줄어들 수 있어
// 마지막 페이지 판정에 쓰면 안 된다.
interface ArxivPage {
	papers: Paper[];
	entryCount: number;
	totalResults: number; // 못 읽으면 -1
	// 이 페이지에서 읽어낸 가장 늦은 제출 시각. 정렬이 ascending이므로 페이지가 진행될수록
	// 커지고, 잘렸을 때 "여기까지는 확실히 훑었다"는 커서가 된다. 못 읽으면 undefined.
	latestPublishedMs: number | undefined;
}

// [1] 정책 — 요청/파싱 실패는 throw로 전파된다(requestWithRetry, parseXml,
// assertNotErrorEntry).
async function fetchAndParse(url: string, collectedQuery: SearchQuery): Promise<ArxivPage> {
	const response = await requestWithRetry({ url });
	const xml = parseXml(response.text, 'arXiv');
	const entries = Array.from(xml.querySelectorAll('entry'));
	const papers: Paper[] = [];
	let latestPublishedMs: number | undefined;

	for (const entry of entries) {
		assertNotErrorEntry(entry);

		// 커버리지 커서는 Paper로 승격되지 못한 항목([2] 정책으로 건너뛴 것)에서도 읽는다.
		// 그 항목도 "이 구간은 훑었다"는 사실 자체는 증명하기 때문이다.
		const published = publishedEpochMs(entry);
		if (published !== undefined) {
			latestPublishedMs =
				latestPublishedMs === undefined ? published : Math.max(latestPublishedMs, published);
		}

		const paper = parseEntry(entry, collectedQuery);
		if (paper) {
			papers.push(paper);
		}
	}

	return {
		papers,
		entryCount: entries.length,
		totalResults: readTotalResults(xml),
		latestPublishedMs,
	};
}

// ── S2 인용수 보강 ──────────────────────────────────────────────────
// API 객체는 "하나의 외부 서비스"가 아니라 "Paper를 완성하는 하나의 방법"이다(2026-08-04
// 팀 논의, 우빈). 인용수는 Paper의 필수 정보인데 arXiv가 제공하지 않으므로, ArxivAPI가
// 반환 전에 Semantic Scholar로 채워 넣는다. 공용 함수로 둔 것은 다른 API 구현체도
// 같은 보강이 필요하면 재사용하기 위함이다.

const S2_BATCH_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const S2_BATCH_CHUNK_SIZE = 500; // S2 배치 엔드포인트의 요청당 최대 id 수
// externalIds를 함께 받는 이유는 아래 fetchCitationBatch의 정렬 검증 때문이다.
// 이게 없으면 응답이 자기 arXiv id를 안 알려줘서 검증 자체가 불가능하다.
const S2_BATCH_FIELDS = 'externalIds,citationCount';

// "arxiv:2501.12345" -> "2501.12345". S2가 못 다루는 출처(arxiv가 아님)면 null.
function toArxivLocalId(sourceId: string): string | null {
	const [provider, localId] = sourceId.split(':');
	return provider === 'arxiv' && localId ? localId : null;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// S2 배치 응답 한 칸. externalIds.ArXiv는 이 레코드가 스스로 밝히는 arXiv id다.
interface S2BatchElement {
	citationCount?: number;
	externalIds?: { ArXiv?: string } | null;
}

// 논문 하나씩 S2를 호출하면 수십~수백 건에서 rate limit에 바로 걸린다. POST .../paper/batch
// 로 최대 500개씩 한 번에 조회한다 — 응답은 요청한 id 순서와 1:1 대응, 매칭 안 되는
// 항목은 null. 청크 단위로 [3] 정책을 적용해, 한 청크가 실패해도 나머지 청크는 계속 채운다.
//
// "순서가 1:1로 대응한다"는 건 응답이 그렇게 오리라는 가정일 뿐이다. S2가 한 칸이라도
// 밀거나 재정렬하면 A 논문의 인용수가 B 논문에 조용히 붙는다 — 눈에 안 띄면서 데이터만
// 틀리는 종류의 사고다. 그래서 응답이 자기 arXiv id를 밝히면 우리가 물어본 id와 같은지
// 확인하고, 다르면 그 항목을 버린다. 버려진 논문은 citationsKnown=false로 남아 다음
// 수집에서 다시 시도된다([3] 정책) — 틀린 값을 넣는 것보다 낫다.
async function fetchCitationBatch(arxivIds: string[]): Promise<Map<string, number>> {
	const result = new Map<string, number>();

	for (const ids of chunk(arxivIds, S2_BATCH_CHUNK_SIZE)) {
		await enrichQuietly(async () => {
			const response = await requestWithRetry({
				url: `${S2_BATCH_ENDPOINT}?fields=${S2_BATCH_FIELDS}`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({ ids: ids.map((id) => `ARXIV:${id}`) }),
			});
			const parsed: unknown = response.json;
			const array = Array.isArray(parsed) ? parsed : [];

			for (let i = 0; i < ids.length; i += 1) {
				const element = array[i] as S2BatchElement | null;
				const id = ids[i];
				if (!element || !id || typeof element.citationCount !== 'number') {
					continue;
				}
				// id를 밝히지 않는 레코드는 불일치를 증명할 수 없으므로 기존대로 신뢰한다.
				const echoed = element.externalIds?.ArXiv;
				if (typeof echoed === 'string' && stripArxivVersion(echoed) !== id) {
					continue;
				}
				result.set(id, element.citationCount);
			}
		});
	}

	return result;
}

// [3] 정책 — citationsKnown=false인 논문만 골라 S2에서 citationCount를 채운다. 실패해도
// 예외를 던지지 않고 citationsKnown=false로 남겨 다음 수집에서 다시 시도되게 한다.
async function enrichCitations(papers: Paper[]): Promise<void> {
	const idToPapers = new Map<string, Paper[]>();
	for (const paper of papers) {
		if (paper.citationsKnown) {
			continue;
		}
		const localId = toArxivLocalId(paper.sourceId);
		if (!localId) {
			continue;
		}
		const list = idToPapers.get(localId) ?? [];
		list.push(paper);
		idToPapers.set(localId, list);
	}
	if (idToPapers.size === 0) {
		return;
	}

	const citations = await fetchCitationBatch(Array.from(idToPapers.keys()));
	for (const [localId, count] of citations) {
		for (const paper of idToPapers.get(localId) ?? []) {
			paper.citationCount = count;
			paper.citationsKnown = true;
		}
	}
}

// 직전 날짜 구간 수집이 실제로 어디까지 훑었는지.
//
// CollectAndSave.run()이 수집 커서(Subscriptions.updateTime)를 저장할 때 요청한 구간의
// 끝(window.to)을 그냥 쓰면 안 된다 — 상한에 걸려 잘렸으면 거기까지 간 게 아니어서,
// 못 본 구간을 봤다고 기록하게 된다. truncated면 coveredThrough를 저장하고 다음 패스가
// 거기서부터 이어받아야 한다.
export interface CollectionCoverage {
	truncated: boolean;
	coveredThrough: number; // epoch ms
}

// 예시용 구현체 — arXiv API. apiName은 'arxiv' 고정(Subscriptions 복원 시 판별 키).
export class ArxivAPI implements API {
	readonly apiName = 'arxiv';
	querys: SearchQuery[];

	// 직전 SearchRecentPaper/Backfill 호출의 커버리지. 단발 조회(SearchBase)나 아직 한 번도
	// 수집하지 않았으면 undefined. 커서 저장은 run()의 책임이라 여기서는 노출만 한다.
	lastCoverage: CollectionCoverage | undefined;

	constructor(querys: SearchQuery[] = []) {
		this.querys = querys;
	}

	private buildUrl(
		dateFilter: string | undefined,
		start: number,
		maxResults: number,
		sortOrder: 'ascending' | 'descending',
	): string {
		if (this.querys.length === 0) {
			throw new Error('ArxivAPI: querys is empty');
		}
		const baseQuery = buildSearchQuery(this.querys);
		const searchQuery = dateFilter ? `${baseQuery} AND ${dateFilter}` : baseQuery;
		const params = new URLSearchParams({
			search_query: searchQuery,
			start: String(start),
			max_results: String(maxResults),
			sortBy: 'submittedDate',
			sortOrder,
		});
		return `${ARXIV_ENDPOINT}?${params.toString()}`;
	}

	// 날짜 구간 없이 한 페이지만 가져오는 단발 조회. "요즘 뭐 올라왔나"를 보는 용도라
	// 최신순(descending)이 맞다.
	private async collectOnce(): Promise<Paper[]> {
		const page = await fetchAndParse(
			this.buildUrl(undefined, 0, MAX_RESULTS, 'descending'),
			combineQueries(this.querys),
		);
		return page.papers;
	}

	// 날짜 구간 수집. start를 올려가며 구간 안의 논문을 끝까지 받는다.
	//
	// 정렬이 **ascending**인 게 핵심이다. descending으로 받으면 상한에 걸렸을 때 구간의
	// 오래된 쪽이 잘려나가는데, 그 구멍은 "어디까지 봤다"는 값 하나로 표현할 수 없어
	// 이어받을 방법이 없다. ascending이면 훑은 구간이 항상 [from, coveredThrough]라는
	// 연속 구간이라, 잘려도 다음 패스가 coveredThrough부터 이어받으면 아무것도 안 잃는다.
	private async collectPaged(
		dateFilter: string,
		windowFrom: number,
		windowTo: number,
	): Promise<Paper[]> {
		const collectedQuery = combineQueries(this.querys);
		const papers: Paper[] = [];
		let latestPublishedMs: number | undefined;

		for (let page = 0; page < MAX_PAGES; page += 1) {
			if (page > 0) {
				await delay(ARXIV_PAGE_DELAY_MS);
			}

			const start = page * PAGE_SIZE;
			const result = await fetchAndParse(
				this.buildUrl(dateFilter, start, PAGE_SIZE, 'ascending'),
				collectedQuery,
			);
			papers.push(...result.papers);
			// 커서는 절대 뒤로 가지 않게 max로 누적한다. ascending이라 보통은 페이지마다
			// 커지지만, 그 정렬을 커서 정확성의 전제로 삼지는 않는다.
			if (result.latestPublishedMs !== undefined) {
				latestPublishedMs =
					latestPublishedMs === undefined
						? result.latestPublishedMs
						: Math.max(latestPublishedMs, result.latestPublishedMs);
			}

			// 응답이 비었거나 한 페이지를 다 못 채웠으면 마지막 페이지다.
			// (totalResults를 못 읽는 경우를 위한 안전망이기도 하다.)
			if (result.entryCount < PAGE_SIZE) {
				this.lastCoverage = { truncated: false, coveredThrough: windowTo };
				return papers;
			}
			// totalResults를 읽었다면 그 기준으로도 종료를 판정한다.
			if (result.totalResults >= 0 && start + result.entryCount >= result.totalResults) {
				this.lastCoverage = { truncated: false, coveredThrough: windowTo };
				return papers;
			}
		}

		// 상한에 걸려 중단 — 구간에 논문이 예상보다 많다. 커서를 windowTo까지 올려버리면
		// 못 본 구간을 봤다고 기록하는 셈이니, 실제로 훑은 지점까지만 인정한다.
		// 읽어낼 제출 시각이 하나도 없었으면 전진 없음(windowFrom)으로 둔다.
		this.lastCoverage = {
			truncated: true,
			coveredThrough: latestPublishedMs ?? windowFrom,
		};
		console.warn(
			`ArxivAPI: reached MAX_PAGES(${MAX_PAGES}) for ${dateFilter} — ` +
				`collected ${papers.length} papers, covered through ` +
				`${new Date(this.lastCoverage.coveredThrough).toISOString()}. ` +
				`Resume from there or narrow the date range.`,
		);
		return papers;
	}

	// 수집 후 반환 전에 S2 인용수 보강까지 마친다 — "API = Paper를 완성하는 방법".
	// 수집([1])은 실패 시 throw로 전파되지만, 보강([3])은 실패해도 수집 결과를 그대로 반환한다.
	private async collect(window?: { from: number; to: number }): Promise<Paper[]> {
		this.lastCoverage = undefined;

		// 빈/역전 구간(시계 되돌림, 잘못 준 Backfill 인자 등)은 요청할 게 없다. 굳이 호출해
		// arXiv에 빈 범위를 물어보는 대신 즉시 끝내고, 커서는 요청한 끝까지 인정한다.
		if (window && window.from >= window.to) {
			this.lastCoverage = { truncated: false, coveredThrough: window.to };
			return [];
		}

		const papers = window
			? await this.collectPaged(buildDateFilter(window.from, window.to), window.from, window.to)
			: await this.collectOnce();
		await enrichQuietly(() => enrichCitations(papers));
		return papers;
	}

	SearchBase(): Promise<Paper[]> {
		return this.collect();
	}

	SearchRecentPaper(hours: number): Promise<Paper[]> {
		const to = Date.now();
		const from = to - hours * 60 * 60 * 1000;
		return this.collect({ from, to });
	}

	Backfill(from: number, to: number): Promise<Paper[]> {
		return this.collect({ from, to });
	}
}
