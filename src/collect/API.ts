import { SearchQuery, combineQueries } from './SearchQuery';
import { Paper } from './Paper';
import {
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

// [2] 정책 — 필수 필드(id/title/summary)가 없는 항목은 undefined를 반환해 호출자가
// 그 논문만 건너뛰게 한다. 전체 수집을 실패시키지 않는다.
function parseEntry(entry: Element, collectedQuery: SearchQuery): Paper | undefined {
	const rawId = text(entry.querySelector('id'));
	const title = text(entry.querySelector('title')).replace(/\s+/g, ' ');
	const abstract = text(entry.querySelector('summary'));
	if (!hasRequiredFields(rawId, title, abstract)) {
		return undefined;
	}

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

// [1] 정책 — 요청/파싱 실패는 throw로 전파된다(requestWithRetry, parseXml).
async function fetchAndParse(url: string, collectedQuery: SearchQuery): Promise<Paper[]> {
	const response = await requestWithRetry({ url });
	const xml = parseXml(response.text, 'arXiv');
	const papers: Paper[] = [];
	for (const entry of Array.from(xml.querySelectorAll('entry'))) {
		const paper = parseEntry(entry, collectedQuery);
		if (paper) {
			papers.push(paper);
		}
	}
	return papers;
}

// ── S2 인용수 보강 ──────────────────────────────────────────────────
// API 객체는 "하나의 외부 서비스"가 아니라 "Paper를 완성하는 하나의 방법"이다(2026-08-04
// 팀 논의, 우빈). 인용수는 Paper의 필수 정보인데 arXiv가 제공하지 않으므로, ArxivAPI가
// 반환 전에 Semantic Scholar로 채워 넣는다. 공용 함수로 둔 것은 다른 API 구현체도
// 같은 보강이 필요하면 재사용하기 위함이다.

const S2_BATCH_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const S2_BATCH_CHUNK_SIZE = 500; // S2 배치 엔드포인트의 요청당 최대 id 수

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

// 논문 하나씩 S2를 호출하면 수십~수백 건에서 rate limit에 바로 걸린다. POST .../paper/batch
// 로 최대 500개씩 한 번에 조회한다 — 응답은 요청한 id 순서와 1:1 대응, 매칭 안 되는
// 항목은 null. 청크 단위로 [3] 정책을 적용해, 한 청크가 실패해도 나머지 청크는 계속 채운다.
async function fetchCitationBatch(arxivIds: string[]): Promise<Map<string, number>> {
	const result = new Map<string, number>();

	for (const ids of chunk(arxivIds, S2_BATCH_CHUNK_SIZE)) {
		await enrichQuietly(async () => {
			const response = await requestWithRetry({
				url: `${S2_BATCH_ENDPOINT}?fields=citationCount`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify({ ids: ids.map((id) => `ARXIV:${id}`) }),
			});
			const parsed: unknown = response.json;
			const array = Array.isArray(parsed) ? parsed : [];
			for (let i = 0; i < ids.length; i += 1) {
				const element = array[i] as { citationCount?: number } | null;
				const id = ids[i];
				if (element && typeof element.citationCount === 'number' && id) {
					result.set(id, element.citationCount);
				}
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

	// 수집 후 반환 전에 S2 인용수 보강까지 마친다 — "API = Paper를 완성하는 방법".
	// 수집([1])은 실패 시 throw로 전파되지만, 보강([3])은 실패해도 수집 결과를 그대로 반환한다.
	private async collect(dateFilter?: string): Promise<Paper[]> {
		const papers = await fetchAndParse(this.buildUrl(dateFilter), combineQueries(this.querys));
		await enrichQuietly(() => enrichCitations(papers));
		return papers;
	}

	SearchBase(): Promise<Paper[]> {
		return this.collect();
	}

	SearchRecentPaper(hours: number): Promise<Paper[]> {
		const to = Date.now();
		const from = to - hours * 60 * 60 * 1000;
		return this.collect(`submittedDate:[${formatArxivDate(from)}+TO+${formatArxivDate(to)}]`);
	}

	Backfill(from: number, to: number): Promise<Paper[]> {
		return this.collect(`submittedDate:[${formatArxivDate(from)}+TO+${formatArxivDate(to)}]`);
	}
}
