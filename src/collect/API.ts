import { requestUrl } from 'obsidian';
import { SearchQuery, combineQueries } from './SearchQuery';
import { Paper } from './Paper';

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

const ARXIV_ENDPOINT = 'http://export.arxiv.org/api/query';
const MAX_RESULTS = 50;

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

// 조건 하나를 "prefix:value" 항으로 변환. 공백이 있는 값은 구문 검색(따옴표)으로 감싼다.
function formatTerm(query: SearchQuery): string {
	const prefix = ARXIV_FIELD_PREFIX[query.searchType];
	if (!prefix) {
		throw new Error(`Unknown searchType for arXiv: ${query.searchType}`);
	}
	const value = /\s/.test(query.query) ? `"${query.query}"` : query.query;
	return `${prefix}:${value}`;
}

// 여러 조건을 AND로 묶은 arXiv search_query 문자열로 변환.
function buildSearchQuery(querys: SearchQuery[]): string {
	return querys.map(formatTerm).join(' AND ');
}

function text(el: Element | null): string {
	return el?.textContent?.trim() ?? '';
}

// "http://arxiv.org/abs/2501.12345v2" -> "2501.12345" (버전 접미사 제거)
function extractArxivId(rawId: string): string {
	const abs = rawId.split('/abs/')[1] ?? rawId;
	return abs.replace(/v\d+$/, '');
}

function parseEntry(entry: Element, collectedQuery: SearchQuery): Paper {
	const arxivId = extractArxivId(text(entry.querySelector('id')));

	const paper = new Paper();
	paper.title = text(entry.querySelector('title')).replace(/\s+/g, ' ');
	paper.authors = Array.from(entry.querySelectorAll('author > name')).map((n) => text(n));
	paper.abstract = text(entry.querySelector('summary'));
	paper.sourceId = `arxiv:${arxivId}`;
	paper.references = [];

	// <published>는 최초 버전 제출일(ISO 8601) — 앞 10자(YYYY-MM-DD)만 취한다.
	paper.publicationDate = text(entry.querySelector('published')).slice(0, 10);

	// arXiv 응답엔 인용수가 없다.
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

async function fetchAndParse(url: string, collectedQuery: SearchQuery): Promise<Paper[]> {
	const response = await requestUrl({ url });
	const xml = new DOMParser().parseFromString(response.text, 'application/xml');
	return Array.from(xml.querySelectorAll('entry')).map((entry) => parseEntry(entry, collectedQuery));
}

// 예시용 구현체 — arXiv API. apiName은 'arxiv' 고정(Subscriptions 복원 시 판별 키).
export class ArxivAPI implements API {
	readonly apiName = 'arxiv';
	querys: SearchQuery[];

	constructor(querys: SearchQuery[] = []) {
		this.querys = querys;
	}

	private buildUrl(dateFilter?: string): string {
		if (this.querys.length === 0) {
			throw new Error('ArxivAPI: querys is empty');
		}
		const baseQuery = buildSearchQuery(this.querys);
		const searchQuery = dateFilter ? `${baseQuery} AND ${dateFilter}` : baseQuery;
		const params = new URLSearchParams({
			search_query: searchQuery,
			start: '0',
			max_results: String(MAX_RESULTS),
			sortBy: 'submittedDate',
			sortOrder: 'descending',
		});
		return `${ARXIV_ENDPOINT}?${params.toString()}`;
	}

	SearchBase(): Promise<Paper[]> {
		return fetchAndParse(this.buildUrl(), combineQueries(this.querys));
	}

	SearchRecentPaper(hours: number): Promise<Paper[]> {
		const to = Date.now();
		const from = to - hours * 60 * 60 * 1000;
		const dateFilter = `submittedDate:[${formatArxivDate(from)}+TO+${formatArxivDate(to)}]`;
		return fetchAndParse(this.buildUrl(dateFilter), combineQueries(this.querys));
	}

	Backfill(from: number, to: number): Promise<Paper[]> {
		const dateFilter = `submittedDate:[${formatArxivDate(from)}+TO+${formatArxivDate(to)}]`;
		return fetchAndParse(this.buildUrl(dateFilter), combineQueries(this.querys));
	}
}
