import { SearchQuery, combineQueries, hasMeaningfulQueryValue } from './SearchQuery';
import { Paper } from './Paper';
import type { Secret } from './Secret';
import { Log } from '../common/Log';
import {
	chunk,
	ConfigurationError,
	delay,
	hasRequiredFields,
	parseXmlOrThrow,
	requestWithRetry,
	runQuietly,
	type RetryPolicy,
} from './ApiSupport';

// ── 수집 실패 처리 정책 ──────────────────────────────────────────────
// 모든 API 구현체가 공유하는 정책이다. 새 API(예: PubMed)를 추가할 때도 이 세 규칙을
// 그대로 따르면 실패 동작이 API마다 달라지지 않는다. 실패 유형은 크게 세 가지다.
//
//   [1] 수집 자체가 불가능 -> throw
//       설정 오류, 응답 없음/깨짐 등 "결과를 신뢰할 수 없는" 경우. 호출자가 이번 수집을
//       실패로 판단해야 하므로 조용히 빈 배열을 반환하지 않는다.
//       -> requestWithRetry / parseXmlOrThrow
//
//   [2] 개별 논문이 불완전 -> 그 논문만 제외
//       필수 필드가 없는 항목 하나 때문에 나머지 정상 논문까지 버리지 않는다.
//       -> hasRequiredFields
//
//   [3] 보강(선택 정보)이 실패 -> 논문은 살리고 플래그로 표시
//       인용수처럼 없어도 Paper 자체는 유효한 정보. citationsKnown=false로 남겨 다음
//       수집에서 다시 시도되게 둔다. -> runQuietly

export interface API {
	// 이 API의 식별자(예: 'arxiv', 'semanticScholar'). Subscriptions.json에 저장되고,
	// 나중에 저장된 구독을 다시 읽을 때 어떤 API 구현체로 복원할지 판별하는 키로 쓴다
	// (API 팩토리/레지스트리 — File.createApi). 002.md 참고.
	readonly apiName: string;
	querys: SearchQuery[];

	// 이 구독(apiName+querys)의 수집 커서 — "recent 수집이 여기부터 이어서 훑으면 된다"는
	// 지점(epoch ms). 0이면 아직 한 번도 수집한 적이 없다는 뜻.
	//
	// 구독마다 독립이다. 예전에는 Subscriptions 하나에 커서가 하나뿐이라(전역 updateTime),
	// 새 구독을 추가해도 그 구독은 "최근"만 보고 과거를 영영 못 봤고, 여러 API를 묶을 때도
	// 서로 다른 색인 지연을 무시하고 가장 보수적인 값(Math.max) 하나로 전부를 다시 훑어야
	// 했다. 커서를 API 인스턴스에 실어 apis[] 배열 항목과 함께 저장하면(File.writeSubscriptions
	// 참고) 이 문제가 없어진다 — 구독이 배열 어디로 옮겨져도(추가/삭제) 커서가 그 구독을
	// 계속 따라간다. 값을 정하는 건 CollectAndSave의 책임이므로 여기서는 그냥 필드로 둔다
	// (readonly가 아닌 이유는 그 갱신 때문).
	updateTime: number;

	// "최근" 수집이 색인 지연을 놓치지 않으려면 커서보다 얼마나 뒤로 물러나 다시 훑어야
	// 하는지 — 이 API가 얼마나 늦게 논문을 색인하는지는 이 API만 아는 사정이라 여기 둔다
	// (ArxivAPI.ARXIV_RETRY의 재시도 간격을 ApiSupport가 아니라 여기 둔 것과 같은 이유:
	// "3초는 arXiv의 사정이지 HTTP의 사정이 아니다"). CollectAndSave의 resolveWindow가
	// 구독(이 API 인스턴스)마다 자기 커서(updateTime)와 이 값으로 각자의 recent 구간을
	// 계산한다 — 구독마다 독립이라 다른 구독의 색인 지연에 끌려다니지 않는다.
	readonly recentRescanWindowMs: number;

	// 이 API에 연달아 요청을 보낼 때 지켜야 하는 최소 간격. CollectAndSave가 구독을
	// 순차로 도는 루프에서, 한 구독의 마지막 요청과 다음 구독의 첫 요청 사이에도 이만큼
	// 쉰다 — 두 구독이 우연히 같은 서비스(예: arXiv 두 개)면 그 사이에 쉬지 않을 이유가
	// 없고, 다른 서비스라도 손해가 크지 않다.
	readonly requestDelayMs: number;

	// 이 API와 통신해 데이터를 가져오는 가장 근본적인 핵심 진입점(엔진). 날짜 조건 없이
	// 현재 querys만으로 이 API에 실제로 접근하는 최소 단위의 통신을 수행한다.
	// SearchRecentPaper/Backfill은 별도의 통신 로직을 새로 구현하지 않는다 — 어떤 구간을
	// 어떤 조건으로 조회할지만 계산한 뒤, 이 핵심 로직을 반복/확장해서 동작한다.
	// "몇 건을 가져오는가"는 계약이 아니다 — 각 구현체가 자기 API에 맞는 기본 조회 단위를
	// 정한다(arXiv는 최신순 한 페이지).
	SearchBase(): Promise<Paper[]>;

	// 지정 구간을 빠짐없이 훑는 수집 경로. 내부적으로 SearchBase가 쓰는 것과 같은 통신
	// 엔진을 날짜 필터/페이지를 바꿔가며 반복 호출한다. SearchBase와 달리 "구간을 어디까지
	// 실제로 훑었는가"에 책임을 지며, 그 결과를 lastCoverage로 보고한다.
	SearchRecentPaper(hours: number, options?: CollectOptions): Promise<Paper[]>;
	Backfill(from: number, to: number, options?: CollectOptions): Promise<Paper[]>;

	// [3] 정책의 재시도 경로. 기본은 citationsKnown=false인 논문만 골라 보강을 다시 시도하고,
	// 나머지는 건드리지 않는다. 수집 경로는 내부에서 자동으로 호출하므로 외부에서 부를
	// 일은 "저장돼 있던 논문을 다시 읽어와 재시도하는" 보정 패스(CollectAndSave.repair)다.
	// options.force로 이미 아는 값까지 강제로 다시 묻는 쪽은 각 구현체의 Refresh()인데,
	// 그건 이 인터페이스의 계약이 아니라 구현체 내부의 결정이다(ArxivAPI.Refresh 참고).
	// 실패해도 throw하지 않는다 — 플래그가 false로 남아 다음 기회에 또 시도된다.
	EnrichCitations(papers: Paper[], options?: { force?: boolean }): Promise<void>;

	// 새로고침(CollectAndSave.refreshAll())의 유일한 진입점 — "이 논문들의 최신 상태를
	// 반영하라". 넘어온 Paper를 제자리에서 갱신한다.
	//
	// ⚠️ 무엇이 "최신 상태"인지는 전적으로 구현체의 사정이다. arXiv 구현체는 인용수 강제
	// 재조회와 제목/초록/저자 재조회를 함께 하지만, 그 조합은 arXiv의 결정이지 계약이
	// 아니다 — 호출자는 갱신 결과를 Paper에서 다시 읽을 뿐, 어떤 필드가 왜 바뀌었는지
	// 알지 않는다. 예전에는 새로고침 몸통이 EnrichCitations(force)와 콘텐츠 재조회를
	// 직접 순서대로 불렀는데, 그러면 출처를 갈아끼울 때마다 "인용수"·"제목/초록" 같은
	// 도메인 지식이 박힌 그 몸통을 함께 고쳐야 했다. 계약을 이 한 줄로 좁히면 새로고침
	// 로직이 아는 API 표면은 apiName과 이 메서드뿐이 된다.
	//
	// 실제로 값이 달라졌는지, 그래서 재임베딩할지는 도메인(CollectAndSave.refreshAllBody)이
	// 호출 전후 스냅샷(Paper.embeddingSourceOf)으로 판단한다 — 이 메서드는 "최신값을
	// 가져와 반영한다"까지만 책임진다(EnrichCitations가 인용수만 채우고 그걸 어디에 쓸지는
	// 호출부가 정하는 것과 같은 구도). 모든 출처가 재조회를 지원하는 건 아니므로 선택
	// 구현이다 — 구현하지 않은 API의 논문은 새로고침 대상에서 자연히 빠진다.
	Refresh?(papers: Paper[]): Promise<void>;

	// [2] 정책으로 스킵된 항목 중 "id는 있는데 제목/초록만 없었던" 부류만 재조회한다
	// (SkippedEntryRecord.reason === 'missing-fields'). id 자체가 없는 부류는 애초에
	// 이 메서드의 대상이 아니다 — 호출자(CollectAndSave.retrySkippedEntries)가 미리
	// 걸러서 넘긴다. 모든 출처가 이 재조회를 지원하는 건 아니므로 선택 구현이다.
	RetryMissingEntries?(
		rawIds: string[],
		collectedQuery: SearchQuery,
	): Promise<{ recovered: Paper[]; stillMissingRawIds: string[] }>;

	// 직전 SearchRecentPaper/Backfill 호출의 커버리지. 단발 조회(SearchBase)나 아직 한 번도
	// 수집하지 않았으면 undefined. 커서 저장(CollectAndSave.run)과 결과 표시(UI)가 읽는
	// 값이라 인터페이스에 포함한다. 값을 정하는 건 구현체의 책임이므로 readonly다.
	readonly lastCoverage: CollectionCoverage | undefined;
}

// 구간 수집(SearchRecentPaper/Backfill)의 선택 옵션.
//
// 둘 다 "수집한 논문을 전부 배열로 돌려준다"는 단순한 계약을 깨기 위해 있다. 구간이
// 커지면(무제한 Backfill) 전량을 메모리에 들고 있을 수도, 끝날 때까지 한 편도 저장하지
// 않을 수도 없기 때문이다.
export interface CollectOptions {
	// 한 청크가 파싱된 직후, 보강([3] 정책) 전에 불린다. 호출자가 저장본에 이미 있는 값
	// (인용수·임베딩 등)을 얹을 기회다. 여기서 citationsKnown이 true가 된 논문은
	// EnrichCitations가 자연히 건너뛰므로, 이미 아는 값을 얻으려고 S2를 다시 두드리지 않는다.
	//
	// 구현체는 이 콜백이 무엇을 채우는지 알 필요가 없다 — citationsKnown만 본다.
	prefill?: (papers: Paper[]) => Promise<void>;

	// 청크가 완성될 때마다(보강까지 끝난 뒤) 불린다. 주면 반환 배열에 논문을 쌓지 않는다 —
	// 호출자가 청크를 받는 즉시 저장하고 버릴 것을 전제로 한 계약이다. 안 주면 예전처럼
	// 전량을 모아서 반환한다(단발 조회나 테스트처럼 규모가 작을 때 쓴다).
	onChunk?: (papers: Paper[]) => Promise<void>;

	// 이 구간(from~to)에 실제로 몇 편이 있는지 arXiv가 알려주는 즉시(첫 페이지 응답) 한
	// 번만 불린다. 진행률 UI가 "지금까지 받은 페이지 수"가 아니라 진짜 총계를 분모로
	// 쓸 수 있게 하려는 용도다 — 이 값이 없으면 청크가 도착할 때마다 총계 자체가 같이
	// 늘어나는 것처럼 보인다(청크 스트리밍으로 바뀌며 생긴 표시 버그).
	//
	// 상한(MAX_PAGES)에 걸려 여러 라운드로 나뉘어도 이 값은 **첫 라운드에서 한 번만**
	// 보고된다 — 이후 라운드는 좁아진 남은 구간의 건수라 원래 요청한 전체 구간의
	// 총계가 아니다(collectRounds 주석 참고). 구간에 결과가 없거나 arXiv가 총계를
	// 못 읽어주면(-1) 호출되지 않는다.
	onTotal?: (total: number) => void;
}

// 직전 날짜 구간 수집이 실제로 어디까지 훑었는지.
//
// CollectAndSave.run()이 수집 커서(API.updateTime)를 저장할 때 요청한 구간의
// 끝(window.to)을 그냥 쓰면 안 된다 — 상한에 걸려 잘렸으면 거기까지 간 게 아니어서,
// 못 본 구간을 봤다고 기록하게 된다. truncated면 coveredThrough를 저장하고 다음 패스가
// 거기서부터 이어받아야 한다.
export interface CollectionCoverage {
	truncated: boolean;
	coveredThrough: number; // epoch ms
	// 실제로 요청한 페이지 수. 페이지네이션이 정말 돌았는지(1페이지에서 안 끝났는지)를
	// 밖에서 확인할 수 있는 유일한 값이라 테스트 UI가 이걸 표시한다.
	pages: number;
	// API가 보고한 이 검색의 전체 건수. 못 읽으면 -1.
	// "받아온 편수"와 비교하면 빠뜨린 게 있는지 바로 드러난다.
	totalResults: number;
	// [2] 정책으로 건너뛴 항목 수(필수 필드 없음, arXiv id로 해석 안 됨 등). entry는
	// 받았지만 Paper로 승격되지 못한 것들 — 조용히 사라지면 "이런 논문이 있었다"는
	// 사실 자체가 안 남으므로, 몇 건이 왜 빠졌는지 밖에서 확인할 수 있게 누적한다.
	skippedEntries: number;
	// skippedEntries의 상세 기록. 7번(부분 재조회) 전용 — 이 필드가 없어도 수집 자체는
	// 아무 영향을 안 받는다(카운트만으로도 [2] 정책은 이미 완결돼 있었다). CollectAndSave가
	// 이걸 읽어 SkippedEntries.json에 임시로 남기고, 그중 재시도 가능한 것만 나중에
	// RetryMissingEntries로 재조회한다 — 이 기능 자체가 통째로 사라져도(devLog에 남긴 대로
	// "임시" 설계) 이 필드 하나만 걷어내면 된다.
	skipped: SkippedEntryRecord[];
	// 이번 수집에서 요청한 category 조건(searchType: 'category')과 실제 응답 entry의
	// <category> 태그가 하나도 안 맞은 건수. 정상 상황에서는 항상 0이다 — arXiv 자체가
	// 요청한 카테고리로 결과를 좁혀 돌려주므로. 0이 아니면 요청과 실제 응답이 어긋났다는
	// 뜻인데, 그 원인이 될 수 있는 것 중 하나가 프록시 등으로 요청이 중간에 변조된 경우다
	// (8번, 실제 재현됨: UI가 cs.LG를 보냈다고 표시하는 동안 서버로는 cs.CR이 나간 사례).
	// arXiv가 실제로 뭘 돌려줬는지는 이 카운트만으로 증명되지 않지만(카테고리 태그를
	// 아예 안 붙이는 등 다른 이유도 있을 수 있다), 0이 아니면 사용자가 확인해야 한다는
	// 신호로는 충분하다.
	categoryMismatches: number;
}

// [2] 정책으로 스킵된 항목의 사유. id를 arXiv id로 해석할 수 있었는지가 재시도 가능
// 여부를 가른다 — 있으면(제목/초록만 없었던 경우) id_list로 다시 물어볼 수 있고
// ('missing-fields'), 없으면 애초에 무엇을 다시 물어야 할지 특정할 수 없다('no-id').
export type SkippedEntryReason = 'no-id' | 'missing-fields';

// SkippedEntries.json에 임시로 남기는 레코드 한 건 — 재수집 대상을 고르는 데 필요한
// 최소한만 담는다(Paper 전체를 담지 않는다, 애초에 Paper가 못 됐으므로).
export interface SkippedEntryRecord {
	rawId: string;
	title: string;
	reason: SkippedEntryReason;
	apiName: string;
	// 재조회로 복구된 논문에 출처 조건을 다시 태그하려면 필요하다(parseEntry의
	// collectedQuery와 같은 역할) — 어느 구독에서 이 항목을 만났는지.
	collectedQuery: SearchQuery;
	skippedAt: number;
}

// Secret.json에 등록할 때 쓰는 provider 키. File.ts의 PAPER_URL_BUILDERS가 sourceId
// prefix로 쓰는 'semanticScholar'와 일부러 맞췄다 — 이 코드베이스에서 S2를 가리키는
// 이름을 하나로 통일해두면 나중에 헷갈릴 일이 없다. export하는 이유는 호출부(UI)가
// "키가 등록돼 있는지" 표시할 때 이 문자열을 다시 손으로 안 적게 하기 위함.
export const S2_SECRET_PROVIDER = 'semanticScholar';

// 한 페이지 응답의 파싱 결과. entryCount/totalResults는 "다음 페이지가 남았는가"를
// 판단하는 데만 쓴다 — papers.length는 [2] 정책으로 건너뛴 항목만큼 줄어들 수 있어
// 마지막 페이지 판정에 쓰면 안 된다. ArxivAPI 내부 타입이라 export하지 않는다.
interface ArxivPage {
	papers: Paper[];
	entryCount: number;
	totalResults: number; // 못 읽으면 -1
	// 이 페이지에서 읽어낸 가장 늦은 제출 시각. 정렬이 ascending이므로 페이지가 진행될수록
	// 커지고, 잘렸을 때 "여기까지는 확실히 훑었다"는 커서가 된다. 못 읽으면 undefined.
	latestPublishedMs: number | undefined;
	// 이 페이지에서 [2] 정책으로 건너뛴 항목의 상세 기록 — CollectionCoverage.skipped 참고.
	skipped: SkippedEntryRecord[];
	// 이 페이지에서 요청한 category 조건과 실제 응답 entry의 category가 어긋난 건수 —
	// CollectionCoverage.categoryMismatches 참고.
	categoryMismatches: number;
}

// S2 배치 응답 한 칸. externalIds.ArXiv는 이 레코드가 스스로 밝히는 arXiv id다.
// ArxivAPI의 인용수 보강에서만 쓰는 타입이라 export하지 않는다.
interface S2BatchElement {
	citationCount?: number;
	externalIds?: { ArXiv?: string } | null;
	// 이 논문이 인용하는 논문들. externalIds만 요청하므로(제목 등은 안 받음) 각 항목에서
	// ArXiv id 유무만 본다 — arXiv에 없는 참고문헌은 이 코퍼스의 노드가 될 수 없어서
	// 어차피 그래프에서 매칭되지 않는다.
	references?: ({ externalIds?: { ArXiv?: string } | null } | null)[] | null;
}

// S2 배치 조회가 논문 하나에 대해 알려주는 것. fetchCitationBatch의 반환 값 단위.
interface S2PaperInfo {
	citationCount: number;
	// 인용하는 논문들의 sourceId ("arxiv:2501.12345" 형태, 버전 제거·중복 제거 완료).
	references: string[];
}

// 예시용 구현체 — arXiv API. apiName은 'arxiv' 고정(Subscriptions 복원 시 판별 키).
//
// arXiv를 다루는 데 필요한 모든 지식(쿼리 문법, Atom 파싱, id 정규화, 그리고 arXiv가
// 에러를 200 OK로 돌려주는 기벽까지)은 이 클래스 안에 있다. 모듈 밖으로 새어나가면
// "arXiv 사정"이 공용 코드의 조건문으로 굳어지기 때문이다.
export class ArxivAPI implements API {
	public readonly apiName = 'arxiv';
	public querys: SearchQuery[];
	// 기본 0(아직 수집한 적 없음). File.readSubscriptions가 저장된 값(또는 구버전 전역
	// 커서에서 마이그레이션한 값)으로 갈아끼운다.
	public updateTime = 0;

	// arXiv는 논문을 실시간이 아니라 배치로 공지한다. 특히 금요일 마감 이후 제출분은
	// 월요일에야 뜨는 주말 갭이 있어, 최소 그 갭(~3일)을 덮어야 한다. 4일로 여유를 더 뒀다
	// — 이 저장소에서 실측한 값은 아니고 이전 프로젝트의 관행을 이어받은 것이다
	// (docs/devLog/004.md). 재현측이 나오면 이 상수만 조정하면 된다.
	public readonly recentRescanWindowMs = 4 * 24 * 60 * 60 * 1000;

	// PAGE_DELAY_MS(아래, 페이지 사이 간격)와 같은 값이다 — 이용약관이 요구하는 건 결국
	// "arXiv에 대한 연속 요청 간격"이라, 페이지 사이든 구독 사이든 같은 규칙을 적용한다.
	public readonly requestDelayMs = 3_000;

	// ── arXiv 쿼리 문법 ──
	// SearchQuery.searchType 허용값
	// 구독은 API 단위 + 최대 3조건, 조건들은 전부 AND로 묶는다
	// - keyword: 제목+초록+저자 등 전체 검색 (arXiv all:)
	// - author: 저자명 (arXiv au:)
	// - category: 분류, arXiv 전용 값 체계(cs.AI 등) — arxiv 전용
	private static readonly FIELD_PREFIX: Record<string, string> = {
		keyword: 'all',
		author: 'au',
		category: 'cat',
	};

	// 이 API가 인정하는 searchType인가 — File.writeSubscriptions가 저장 시점에 구독 조건을
	// 검증할 때 쓴다(9번: 개발자 도구로 UI를 우회해 keyword/author/category 밖의 조건을
	// Subscriptions.json에 심는 경로 방어). formatTerm도 결국 이 맵을 보고 거부하지만, 그건
	// "수집을 실행하는 시점"의 최종 방어선이고, 저장 시점에도 막아야 애초에 이상한 조건이
	// 파일에 남지 않는다.
	static isValidSearchType(searchType: string): boolean {
		return typeof ArxivAPI.FIELD_PREFIX[searchType] === 'string';
	}

	// arXiv 분류 코드(cs.AI, math.NA, astro-ph.GA, 또는 상위 아카이브만 있는 cs 같은 형태)의
	// 모양 — 소문자로 시작하는 영문/숫자/하이픈 토큰, 선택적으로 "."+영문/숫자/하이픈
	// 서브클래스. category는 formatTerm에서 따옴표로 감싸지 않고 `cat:${value}`로 그대로
	// 쿼리에 꽂히므로(69번: keyword/author는 따옴표 구문 검색이라 안의 AND/OR가 arXiv에서
	// 연산자로 해석되지 않지만, category는 감싸지 않아 공백/AND/OR/콜론/괄호를 넣으면 그
	// 자체로 새 쿼리 절이 삽입된다 — 실제 재현된 필터 우회), 이 형식을 벗어나면 애초에
	// 값 자체를 거부한다.
	private static readonly CATEGORY_PATTERN = /^[a-z][a-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)?$/;

	static isValidCategoryValue(value: string): boolean {
		return ArxivAPI.CATEGORY_PATTERN.test(value);
	}

	private static readonly ENDPOINT = 'https://export.arxiv.org/api/query';

	// SearchBase()가 한 번에 가져오는 건수. 인터페이스가 정한 값이 아니라 arXiv 구현체의
	// 선택이다 — "조건이 뭘 물어오는지 보기에 충분한 한 페이지".
	private static readonly BASE_PAGE_SIZE = 50;

	// 날짜 구간 수집(SearchRecentPaper/Backfill)의 페이지 설정. 이 두 경로는 "구간 안의
	// 논문을 빠짐없이" 가져오는 게 목적이라 단발 조회로는 안 되고 start를 올려가며 이어받는다.
	// - PAGE_SIZE: arXiv는 요청당 최대 2000건까지 허용하지만 응답이 커질수록 타임아웃/스로틀
	//   확률이 올라가므로 100건씩 나눠 받는다.
	// - MAX_PAGES: 구간을 잘못 준 경우 무한정 긁는 사고를 막는 상한 (라운드당 최대 2000건).
	//   여기 걸려도 수집이 끝나지는 않는다 — collectRounds가 남은 구간으로 다시 훑는다.
	// - PAGE_DELAY_MS: arXiv 이용약관이 권장하는 연속 호출 간격.
	private static readonly PAGE_SIZE = 100;
	private static readonly MAX_PAGES = 20;
	private static readonly PAGE_DELAY_MS = 3_000;

	// arXiv 에러 응답의 <id>에 들어가는 표식. assertNotErrorEntry 참고.
	private static readonly ERROR_ID_MARK = 'arxiv.org/api/errors';

	private static readonly OPENSEARCH_NS = 'http://a9.com/-/spec/opensearch/1.1/';

	// arXiv는 과부하 시 503을 쓰고, 이용약관이 3초 간격을 권한다. 이 값이 공용
	// ApiSupport가 아니라 여기 있는 이유다 — 3초는 arXiv의 사정이지 HTTP의 사정이 아니다.
	//
	// timeoutMs: arXiv 정상 응답은 한 페이지(100건)에 보통 1~3초다. 60초면 느린 응답을
	// 오판할 여지가 사실상 없으면서, 스로틀 중인 서버가 연결만 잡고 응답을 안 주는 경우에
	// 수집이 영원히 멈추지 않게 한다(requestUrl에는 타임아웃 옵션이 없다).
	private static readonly ARXIV_RETRY: RetryPolicy = { retryDelayMs: 3_000, timeoutMs: 60_000 };

	// ── S2 인용수 보강 ──
	// API 객체는 "하나의 외부 서비스"가 아니라 "Paper를 완성하는 하나의 방법"이다.
	// 인용수는 Paper의 필수 정보인데 arXiv가 제공하지 않으므로, ArxivAPI가 반환 전에
	// Semantic Scholar로 채워 넣는다. S2는 여기서 독립 수집원이 아니라 arXiv 논문의
	// 빈 인용수를 메우는 부품이므로, 별도 API 구현체가 아니라 이 클래스의 private으로 둔다.
	// (S2 자체를 수집원으로 쓸 일이 생기면 그때 별도의 implements API 클래스를 만든다.)
	private static readonly S2_BATCH_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/batch';
	// S2 배치 엔드포인트 자체는 요청당 최대 500개 id를 받지만, references까지 실으면서
	// 100으로 낮췄다 — 논문당 참고문헌이 보통 수십 개라 응답이 수십 배 커지는데, 응답이
	// 클수록 타임아웃/스로틀 확률이 올라간다(arXiv PAGE_SIZE를 2000이 아니라 100으로
	// 잡은 것과 같은 판단).
	private static readonly S2_BATCH_CHUNK_SIZE = 100;
	// externalIds를 함께 받는 이유는 fetchCitationBatch의 정렬 검증 때문이다.
	// 이게 없으면 응답이 자기 arXiv id를 안 알려줘서 검증 자체가 불가능하다.
	// references.externalIds는 인용 그래프 엣지용 — 시각화(CitationEdgeMiddleware)가
	// paper.references에서 엣지를 그리는데, arXiv 응답에는 참고문헌이 아예 없어서
	// 이 요청이 references가 채워지는 유일한 경로다.
	private static readonly S2_BATCH_FIELDS = 'externalIds,citationCount,references.externalIds';
	private static readonly S2_RETRY: RetryPolicy = { retryDelayMs: 3_000, timeoutMs: 60_000 };
	// 배치 청크 사이 간격. S2 익명 호출은 공용 rate limit(대략 초당 1회)을 다른 모든 익명
	// 사용자와 나눠 쓴다. 키가 있으면 더 여유롭지만, 키 유무로 값을 나누면 "키를 넣었더니
	// 429가 늘었다" 같은 상황을 만들기 쉬워 보수적인 쪽 하나로 통일한다.
	private static readonly S2_CHUNK_DELAY_MS = 1_500;

	// 직전 구간 수집의 커버리지. 값을 정하는 건 이 클래스의 책임이고 밖에서는 읽기만
	// 하므로, 필드는 private으로 감추고 getter만 인터페이스에 노출한다.
	private coverage: CollectionCoverage | undefined;

	// S2 인용수 보강에 쓸 API 키 보관소. arXiv 자체 조회는 인증이 필요 없어 안 쓰인다.
	// 없어도(undefined) 익명 호출로 동작한다 — 키는 선택 사항이지 필수가 아니다.
	private readonly secret?: Secret;

	constructor(querys: SearchQuery[] = [], secret?: Secret) {
		this.querys = querys;
		this.secret = secret;
	}

	public get lastCoverage(): CollectionCoverage | undefined {
		return this.coverage;
	}

	// ── 공개 진입점 ────────────────────────────────────────────────

	// 이 클래스가 arXiv에 접근하는 최소 단위 — fetchPage(엔진)를 그대로 한 번 노출한다.
	// 날짜 구간을 다루지 않으므로 lastCoverage는 건드리지 않는다(단발 조회는 커버리지
	// 개념이 없다 — 인터페이스 계약).
	public async SearchBase(): Promise<Paper[]> {
		const page = await this.fetchPage(undefined, 0, ArxivAPI.BASE_PAGE_SIZE, 'descending');
		if (page.entryCount > page.papers.length) {
			// [2] 정책 — 개별 논문 스킵은 재시도 대상이 아니지만(같은 응답을 다시 파싱해도
			// 똑같이 스킵된다), 조용히 사라지면 흔적이 안 남으므로 최소한 로그는 남긴다.
			console.warn(
				`ArxivAPI.SearchBase: ${page.entryCount - page.papers.length}건 스킵` +
					`(entry ${page.entryCount}건 중 ${page.papers.length}건만 Paper로 변환됨)`,
			);
		}
		await runQuietly(() => this.EnrichCitations(page.papers), 'SearchBase.EnrichCitations');
		return page.papers;
	}

	public SearchRecentPaper(hours: number, options?: CollectOptions): Promise<Paper[]> {
		const to = Date.now();
		const from = to - hours * 60 * 60 * 1000;
		return this.collectWindow(from, to, options);
	}

	public Backfill(from: number, to: number, options?: CollectOptions): Promise<Paper[]> {
		return this.collectWindow(from, to, options);
	}

	// ── 수집 흐름 ──────────────────────────────────────────────────
	//
	// fetchPage()가 이 클래스의 유일한 통신 엔진이다. SearchBase는 이 엔진을 그대로
	// 한 번 노출한 것이고(위), SearchRecentPaper/Backfill은 별도의 통신 로직을 갖지 않는다 —
	// 날짜 필터와 페이지 번호만 계산해서 같은 엔진을 반복 호출한다(collectPaged 참고).

	// SearchRecentPaper/Backfill의 공통 몸통. 구간을 검증하고, 페이지네이션으로 구간을
	// 끝까지 훑으며, 청크마다 S2 인용수 보강까지 마쳐 내보낸다 — "API = Paper를 완성하는 방법".
	// 수집([1])은 실패 시 throw로 전파되지만, 보강([3])은 실패해도 그 청크를 그대로 내보낸다.
	//
	// 보강을 마지막에 한 번이 아니라 청크마다 하는 이유: 구간이 무제한이라 전량을 모아두면
	// 메모리도 문제지만, 무엇보다 마지막에 실패하면 그때까지 받은 게 전부 버려진다.
	private async collectWindow(
		from: number,
		to: number,
		options?: CollectOptions,
	): Promise<Paper[]> {
		this.coverage = undefined;

		// [1] 정책 — 숫자가 아닌 구간은 여기서 끊는다. NaN을 그냥 흘려보내면
		// `from >= to` 비교가 false로 통과하고(NaN 비교는 항상 false) formatDate가
		// "NaNNaNNaNNaNNaN"을 만들어, 깨진 쿼리가 arXiv까지 나간 뒤 "arXiv rejected the
		// query"라는 엉뚱한 메시지로 실패한다. 원인을 호출부에서 바로 알 수 있게 한다.
		if (!Number.isFinite(from) || !Number.isFinite(to)) {
			throw new Error(`ArxivAPI: invalid date window (from=${from}, to=${to})`);
		}

		// 빈/역전 구간(시계 되돌림, 잘못 준 Backfill 인자 등)은 요청할 게 없다. 굳이 호출해
		// arXiv에 빈 범위를 물어보는 대신 즉시 끝내고, 커서는 요청한 끝까지 인정한다.
		if (from >= to) {
			this.coverage = {
				truncated: false,
				coveredThrough: to,
				pages: 0, // 호출 자체를 안 했다
				totalResults: -1,
				skippedEntries: 0,
				skipped: [],
				categoryMismatches: 0,
			};
			return [];
		}

		Log.info('arxiv.window', '구간 수집 시작', {
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			querys: this.querys.map((q) => `${q.searchType}:${q.query}`),
		});
		// onChunk를 준 호출자는 청크를 받는 즉시 저장하고 버린다 — 여기에 쌓지 않는다.
		const collected: Paper[] = [];
		let total = 0;

		await this.collectRounds(
			from,
			to,
			async (chunk) => {
				// 재스캔 구간이 이전에 이미 보강을 끝낸 논문을 다시 잡아올 수 있다. 호출자가 이미
				// 아는 값을 여기서 먼저 채워두면, 아래 EnrichCitations의 기존 필터
				// (`if (citationsKnown) continue`)가 이 논문들을 자연히 건너뛴다 — S2를 다시
				// 두드리지 않는다. 모르는 논문(이번에 새로 걸린 것)만 실제로 보강한다.
				if (options?.prefill) {
					await options.prefill(chunk);
				}
				await runQuietly(() => this.EnrichCitations(chunk), 'collectWindow.EnrichCitations');
				total += chunk.length;
				if (options?.onChunk) {
					await options.onChunk(chunk);
				} else {
					collected.push(...chunk);
				}
			},
			options?.onTotal,
		);

		Log.info('arxiv.window', '구간 수집 종료', { papers: total, coverage: this.coverage });
		return collected;
	}

	// 요청한 구간을 **끝까지** 훑는다. collectPaged 한 번은 MAX_PAGES(=2000건)에서 멈추는데,
	// 그건 "구간을 잘못 줬을 때 무한정 긁는 사고"를 막는 안전장치라 없앨 수 없다. 대신 잘렸을
	// 때 그 지점(coveredThrough)부터 새 구간으로 다시 훑기를 반복해, 상한은 유지하면서도
	// "요청한 범위는 다 가져온다"는 Backfill의 계약을 지킨다.
	//
	// 이어받기가 성립하는 근거는 collectPaged의 ascending 정렬이다(아래 주석 참고) —
	// 훑은 구간이 항상 [from, coveredThrough]라는 연속 구간이라 그 끝에서 이어붙일 수 있다.
	//
	// 논문은 모아서 돌려주지 않고 페이지 단위로 emit한다. 구간이 무제한이라 전량을 들고
	// 있으면 메모리가 구간 크기에 비례해 늘고, 무엇보다 마지막에 실패했을 때 그때까지 받은
	// 게 전부 사라진다. sourceId Set만 끝까지 들고 있는데, 이건 문자열이라 부담이 작다.
	private async collectRounds(
		from: number,
		to: number,
		emit: (papers: Paper[]) => Promise<void>,
		onTotal?: (total: number) => void,
	): Promise<void> {
		// 이어받기는 반드시 중복을 만든다: formatDate가 분 단위로 자르고 buildDateFilter의
		// 범위가 양끝 포함([A TO B])이라, 경계 분의 논문이 다음 라운드에 또 걸린다.
		const seen = new Set<string>();
		let cursor = from;
		let pages = 0;
		let skippedEntries = 0;
		const skipped: SkippedEntryRecord[] = [];
		let categoryMismatches = 0;
		let duplicates = 0;
		let unique = 0;
		// 첫 라운드의 값만 의미가 있다 — 이후 라운드는 좁아진 구간의 전체 건수라서
		// "이 수집이 총 몇 건짜리였나"를 나타내지 못한다.
		let totalResults = -1;
		let truncated = false;

		for (let round = 0; ; round += 1) {
			if (round > 0) {
				await delay(ArxivAPI.PAGE_DELAY_MS);
			}

			const dateFilter = ArxivAPI.buildDateFilter(cursor, to);
			let received = 0;
			await this.collectPaged(
				dateFilter,
				cursor,
				to,
				async (page) => {
					received += page.length;
					// 중복은 여기서 걸러 내보낸다 — 호출자가 같은 논문을 두 번 저장하지 않도록.
					const fresh = page.filter((paper) => {
						if (seen.has(paper.sourceId)) {
							duplicates += 1;
							return false;
						}
						seen.add(paper.sourceId);
						return true;
					});
					if (fresh.length > 0) {
						unique += fresh.length;
						await emit(fresh);
					}
				},
				// 첫 라운드의 총계만 "요청한 전체 구간"을 뜻한다 — 이후 라운드는 전달하지
				// 않아, 호출자가 좁아진 남은 구간의 건수를 전체 총계로 오해하지 않게 한다.
				round === 0 ? onTotal : undefined,
			);
			// collectPaged는 항상 this.coverage를 채우고 돌아온다.
			const roundCoverage = this.coverage as CollectionCoverage;

			pages += roundCoverage.pages;
			skippedEntries += roundCoverage.skippedEntries;
			skipped.push(...roundCoverage.skipped);
			categoryMismatches += roundCoverage.categoryMismatches;
			if (round === 0) {
				totalResults = roundCoverage.totalResults;
			}

			Log.info('arxiv.round', `라운드 ${round + 1} 완료`, {
				dateFilter,
				received,
				unique,
				duplicates,
				pages: roundCoverage.pages,
				truncated: roundCoverage.truncated,
				coveredThrough: new Date(roundCoverage.coveredThrough).toISOString(),
			});

			if (!roundCoverage.truncated) {
				break;
			}

			// 커서가 안 움직이면 다음 라운드가 같은 요청을 그대로 반복한다 — 무한 루프다.
			// 한 분 안에 2000건이 몰린 극단적인 경우인데, 여기서 멈추고 truncated로 보고해
			// 호출자(커서 저장)가 못 본 구간을 봤다고 기록하지 않게 한다.
			if (roundCoverage.coveredThrough <= cursor) {
				truncated = true;
				Log.warn('arxiv.round', '커서가 전진하지 않아 중단 — 구간을 좁혀 다시 시도해야 한다', {
					dateFilter,
					cursor: new Date(cursor).toISOString(),
					coveredThrough: new Date(roundCoverage.coveredThrough).toISOString(),
				});
				break;
			}
			cursor = roundCoverage.coveredThrough;
		}

		this.coverage = {
			truncated,
			// 완주했으면 요청한 끝까지 인정한다. 커서 정체로 멈췄으면 실제로 훑은 지점까지만.
			coveredThrough: truncated ? cursor : to,
			pages,
			totalResults,
			skippedEntries,
			skipped,
			categoryMismatches,
		};
	}

	// 날짜 구간 수집. 자체 통신 로직 없이, 같은 엔진(fetchPage)을 start를 올려가며 반복
	// 호출해 구간 안의 논문을 끝까지 받는다.
	//
	// 정렬이 **ascending**인 게 핵심이다. descending으로 받으면 상한에 걸렸을 때 구간의
	// 오래된 쪽이 잘려나가는데, 그 구멍은 "어디까지 봤다"는 값 하나로 표현할 수 없어
	// 이어받을 방법이 없다. ascending이면 훑은 구간이 항상 [from, coveredThrough]라는
	// 연속 구간이라, 잘려도 다음 패스가 coveredThrough부터 이어받으면 아무것도 안 잃는다.
	//
	// 페이지가 곧 청크다 — 받는 즉시 emit하고 여기서는 들고 있지 않는다.
	private async collectPaged(
		dateFilter: string,
		windowFrom: number,
		windowTo: number,
		emit: (papers: Paper[]) => Promise<void>,
		onTotal?: (total: number) => void,
	): Promise<void> {
		let emitted = 0;
		let latestPublishedMs: number | undefined;
		let totalResults = -1;
		// [2] 정책 — entry는 받았지만 필수 필드 누락 등으로 Paper가 못 된 항목의 누적 수.
		// 페이지마다 조용히 사라지지 않도록 coverage에 실어 밖에서 확인할 수 있게 한다.
		let skippedEntries = 0;
		const skipped: SkippedEntryRecord[] = [];
		let categoryMismatches = 0;

		for (let page = 0; page < ArxivAPI.MAX_PAGES; page += 1) {
			if (page > 0) {
				await delay(ArxivAPI.PAGE_DELAY_MS);
			}

			const start = page * ArxivAPI.PAGE_SIZE;
			const result = await this.fetchPage(dateFilter, start, ArxivAPI.PAGE_SIZE, 'ascending');
			// 첫 페이지에서 총계를 알자마자 보고한다 — 나머지 페이지(최대 20개, ~1분)를
			// 다 받을 때까지 기다리면 진행률 UI가 그동안 총계를 모르는 채로 있어야 한다.
			if (page === 0 && result.totalResults >= 0) {
				onTotal?.(result.totalResults);
			}
			if (result.papers.length > 0) {
				emitted += result.papers.length;
				await emit(result.papers);
			}
			totalResults = result.totalResults;
			skippedEntries += result.entryCount - result.papers.length;
			skipped.push(...result.skipped);
			categoryMismatches += result.categoryMismatches;
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
			//
			// totalResults를 읽었다면 그 기준으로도 종료를 판정한다.
			const filledPage = result.entryCount >= ArxivAPI.PAGE_SIZE;
			const reachedTotal =
				result.totalResults >= 0 && start + result.entryCount >= result.totalResults;
			if (!filledPage || reachedTotal) {
				this.coverage = {
					truncated: false,
					coveredThrough: windowTo,
					pages: page + 1,
					totalResults,
					skippedEntries,
					skipped,
					categoryMismatches,
				};
				Log.info('arxiv.paged', '구간 완주', {
					dateFilter,
					reason: !filledPage ? 'lastPage' : 'reachedTotal',
					pages: page + 1,
					papers: emitted,
					totalResults,
					skippedEntries,
				});
				if (skippedEntries > 0) {
					console.warn(`ArxivAPI: ${skippedEntries}건 스킵됨 (구간 ${dateFilter})`);
				}
				return;
			}
		}

		// 상한에 걸려 중단 — 구간에 논문이 예상보다 많다. 커서를 windowTo까지 올려버리면
		// 못 본 구간을 봤다고 기록하는 셈이니, 실제로 훑은 지점까지만 인정한다.
		// 읽어낼 제출 시각이 하나도 없었으면 전진 없음(windowFrom)으로 둔다.
		// 여기서 수집이 끝나지는 않는다 — collectRounds가 이 지점부터 다시 훑는다.
		this.coverage = {
			truncated: true,
			coveredThrough: latestPublishedMs ?? windowFrom,
			pages: ArxivAPI.MAX_PAGES,
			totalResults,
			skippedEntries,
			skipped,
			categoryMismatches,
		};
		Log.info('arxiv.paged', '라운드 상한(MAX_PAGES) 도달 — 남은 구간은 다음 라운드로', {
			dateFilter,
			maxPages: ArxivAPI.MAX_PAGES,
			papers: emitted,
			totalResults,
			skippedEntries,
			coveredThrough: new Date(this.coverage.coveredThrough).toISOString(),
		});
	}

	// ── 통신 엔진 (SearchBase의 실체) ──────────────────────────────
	//
	// 이 클래스가 arXiv에 실제로 접근하는 유일한 지점. querys(+선택적 dateFilter)로 URL을
	// 만들고, 요청하고, 파싱까지 끝내 한 페이지 분량의 결과를 돌려준다. collectOnce(=
	// SearchBase)와 collectPaged(=SearchRecentPaper/Backfill)는 이 메서드 위에 얹힌
	// 얇은 래퍼일 뿐, 자기만의 요청/파싱 로직을 따로 갖지 않는다.
	//
	// [1] 정책 — 요청/파싱 실패는 throw로 전파된다(requestWithRetry, parseXmlOrThrow,
	// assertNotErrorEntry).
	private async fetchPage(
		dateFilter: string | undefined,
		start: number,
		maxResults: number,
		sortOrder: 'ascending' | 'descending',
	): Promise<ArxivPage> {
		const collectedQuery = combineQueries(this.querys);
		// 이번 구독이 실제로 요청한 category 조건들 — 프록시 등으로 요청이 변조돼도 이
		// 배열은 로컬에서 만든 원래 요청을 그대로 반영한다(변조는 네트워크 상에서
		// 일어나므로 여기 값 자체는 안 바뀐다). 응답 entry의 실제 category와 대조하는
		// 기준이 된다.
		const requestedCategories = this.querys
			.filter((q) => q.searchType === 'category')
			.map((q) => q.query);
		const url = this.buildUrl(dateFilter, start, maxResults, sortOrder);
		const startedAt = Date.now();
		// 실패하면 여기서 throw로 끊긴다([1] 정책). 어느 요청에서 끊겼는지 남기려면
		// 요청 직전에 한 줄 찍어둬야 한다 — 예외가 난 뒤에는 이 정보가 없다.
		Log.debug('arxiv.page', '요청', { url, start, maxResults, sortOrder });
		const response = await requestWithRetry({ url }, ArxivAPI.ARXIV_RETRY);
		const xml = parseXmlOrThrow(response.text, 'arXiv');
		const entries = Array.from(xml.querySelectorAll('entry'));
		const papers: Paper[] = [];
		const skipped: SkippedEntryRecord[] = [];
		let latestPublishedMs: number | undefined;
		let categoryMismatches = 0;

		for (const entry of entries) {
			ArxivAPI.assertNotErrorEntry(entry);

			// 커버리지 커서는 Paper로 승격되지 못한 항목([2] 정책으로 건너뛴 것)에서도 읽는다.
			// 그 항목도 "이 구간은 훑었다"는 사실 자체는 증명하기 때문이다.
			const published = ArxivAPI.publishedEpochMs(entry);
			if (published !== undefined) {
				latestPublishedMs =
					latestPublishedMs === undefined
						? published
						: Math.max(latestPublishedMs, published);
			}

			if (requestedCategories.length > 0) {
				const entryCategories = Array.from(entry.querySelectorAll('category')).map(
					(c) => c.getAttribute('term') ?? '',
				);
				if (!requestedCategories.some((rc) => entryCategories.includes(rc))) {
					categoryMismatches += 1;
				}
			}

			const paper = ArxivAPI.parseEntry(entry, collectedQuery);
			if (paper) {
				papers.push(paper);
			} else {
				// [2] 정책으로 건너뛴 항목 — 나중에 "이게 진짜 arXiv 데이터 문제인지, 우리
				// 파싱 버그인지"를 사람이 판단하려면 최소한 어떤 id였는지는 남아야 한다.
				// 개수만 세던 예전 방식은 원인 조사가 아예 불가능했다.
				const rawId = ArxivAPI.text(entry.querySelector('id'));
				const title = ArxivAPI.text(entry.querySelector('title'));
				Log.warn('arxiv.page', '[2] 정책 — 항목 스킵(필수 필드 없음 또는 id 해석 불가)', {
					rawId: rawId || '(없음)',
					title: title || '(없음)',
				});
				// 7번(부분 재조회) — id가 파싱되면 제목/초록만 없었다는 뜻이라 나중에
				// id_list로 다시 물어볼 수 있다('missing-fields'). id 자체가 안 되면 무엇을
				// 다시 물어야 할지조차 특정할 수 없다('no-id') — classifySkipReason 참고.
				skipped.push({
					rawId,
					title,
					reason: ArxivAPI.classifySkipReason(rawId),
					apiName: this.apiName,
					collectedQuery,
					skippedAt: Date.now(),
				});
			}
		}

		const totalResults = ArxivAPI.readTotalResults(xml);
		Log.debug('arxiv.page', '응답', {
			start,
			entryCount: entries.length,
			papers: papers.length,
			totalResults,
			elapsedMs: Date.now() - startedAt,
			latestPublished:
				latestPublishedMs === undefined ? undefined : new Date(latestPublishedMs).toISOString(),
		});
		if (categoryMismatches > 0) {
			// 요청-응답 불일치는 흔한 일이 아니므로 debug가 아니라 warn으로 남긴다 — 8번
			// (프록시로 요청이 변조된 사례)처럼 조용히 지나가면 안 되는 신호다.
			Log.warn('arxiv.page', '요청한 category와 응답 category가 어긋난 항목 발견', {
				requestedCategories,
				categoryMismatches,
			});
		}

		return {
			papers,
			entryCount: entries.length,
			totalResults,
			latestPublishedMs,
			skipped,
			categoryMismatches,
		};
	}

	// ── 쿼리 조립 ──────────────────────────────────────────────────

	private buildUrl(
		dateFilter: string | undefined,
		start: number,
		maxResults: number,
		sortOrder: 'ascending' | 'descending',
	): string {
		if (this.querys.length === 0) {
			throw new ConfigurationError('ArxivAPI: querys is empty');
		}
		const baseQuery = this.buildSearchQuery();
		const searchQuery = dateFilter ? `${baseQuery} AND ${dateFilter}` : baseQuery;
		const params = new URLSearchParams({
			search_query: searchQuery,
			start: String(start),
			max_results: String(maxResults),
			sortBy: 'submittedDate',
			sortOrder,
		});
		return `${ArxivAPI.ENDPOINT}?${params.toString()}`;
	}

	// 여러 조건을 AND로 묶은 arXiv search_query 문자열로 변환.
	private buildSearchQuery(): string {
		return this.querys.map((query) => ArxivAPI.formatTerm(query)).join(' AND ');
	}

	// 조건 하나를 "prefix:value" 항으로 변환.
	// 값 안의 따옴표는 제거한다 — 남겨두면 값이 구문 검색의 닫는 따옴표를 먼저 끝내버려
	// 쿼리 구조가 깨진다. 그리고 "공백이 있을 때만 감싸기"는 `foo)`처럼 공백 없이도 문법을
	// 깨뜨리는 값을 놓치므로, keyword/author는 길이와 무관하게 항상 구문 검색으로 감싼다.
	// category(cat:)는 cs.AI 같은 고정 토큰이라 감싸지 않는다.
	private static formatTerm(query: SearchQuery): string {
		// typeof로 검사하는 이유: Subscriptions.json은 사용자가 편집할 수 있고, searchType이
		// 'toString'/'constructor' 같은 값이면 프로토타입 체인을 타고 함수가 잡힌다. 그러면
		// truthy라서 "Unknown searchType" 가드를 통과해버리고 쿼리에 함수 소스가 박힌다.
		const prefix = ArxivAPI.FIELD_PREFIX[query.searchType];
		if (typeof prefix !== 'string') {
			throw new ConfigurationError(`Unknown searchType for arXiv: ${query.searchType}`);
		}
		const value = query.query.replace(/"/g, '');
		// UI(ApiManagementModal의 "필드에 추가")도 hasMeaningfulQueryValue로 같은 기준을
		// 검사해 저장 자체를 막지만, Subscriptions.json은 사용자가 직접 편집할 수 있는
		// 평문 파일이라 그 방어를 우회할 수 있다 — 여기가 최종 방어선이다.
		if (!hasMeaningfulQueryValue(query.query)) {
			throw new ConfigurationError(
				`Empty or meaningless query value for searchType "${query.searchType}"`,
			);
		}
		// category는 따옴표로 감싸지 않으므로(위 클래스 주석), 값 자체가 cs.AI 같은 고정
		// 토큰 모양이 아니면 거부한다 — 그렇지 않으면 공백+AND/OR+다른 필드로 쿼리 전체를
		// 조작할 수 있다(69번, 실제 재현됨).
		if (prefix === 'cat' && !ArxivAPI.isValidCategoryValue(value)) {
			throw new ConfigurationError(`Invalid arXiv category format: "${query.query}"`);
		}
		return prefix === 'cat' ? `${prefix}:${value}` : `${prefix}:"${value}"`;
	}

	// 제출일 구간 필터를 만든다. 구분자는 반드시 "진짜 공백"이어야 한다 — buildUrl의
	// URLSearchParams가 공백을 '+'로 인코딩해 주기 때문이다. 예전처럼 '+'를 문자열에 직접
	// 넣으면 URLSearchParams가 그걸 리터럴 플러스로 보고 '%2B'로 이스케이프해서, arXiv가
	// range 문법(`[A TO B]`)으로 인식하지 못하고 날짜 필터가 통째로 무시된다.
	// 두 호출부(SearchRecentPaper/Backfill)가 같은 실수를 반복하지 않도록 여기로 모았다.
	private static buildDateFilter(fromMs: number, toMs: number): string {
		return `submittedDate:[${ArxivAPI.formatDate(fromMs)} TO ${ArxivAPI.formatDate(toMs)}]`;
	}

	// timestamp(ms) -> arXiv submittedDate 필터가 요구하는 "YYYYMMDDHHMM"(UTC) 포맷.
	private static formatDate(timestampMs: number): string {
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

	// ── Atom 응답 파싱 ─────────────────────────────────────────────

	private static text(el: Element | null): string {
		return el?.textContent?.trim() ?? '';
	}

	// "2501.12345v2" -> "2501.12345". arXiv id의 버전 접미사를 떼는 규칙은 arXiv의
	// 지식이므로 이 클래스가 소유한다. 피드의 <id>를 파싱할 때와, 인용수 보강이 S2 응답의
	// externalIds.ArXiv를 우리가 물어본 id와 대조할 때 양쪽에서 쓴다 — 둘 다 클래스
	// 안이므로 공개할 이유가 없다.
	private static stripVersion(id: string): string {
		return id.replace(/v\d+$/, '');
	}

	// "http://arxiv.org/abs/2501.12345v2" -> "2501.12345".
	// /abs/ 세그먼트가 없는 id는 arXiv 논문 id가 아니므로 원본을 그대로 돌려주지 않고 ''을
	// 반환한다. 예전에는 `?? rawId`로 원본을 흘려보내서 호출자의 빈 값 가드가 절대 걸리지
	// 않았고, 그 탓에 에러 응답의 URL이 sourceId로 둔갑했다.
	private static extractId(rawId: string): string {
		const abs = rawId.split('/abs/')[1];
		if (!abs) {
			return '';
		}
		return ArxivAPI.stripVersion(abs);
	}

	// 7번(부분 재조회) — extractId 성공 여부만으로 재시도 가능성을 가른다. extractId가
	// 성공했는데도 parseEntry가 그 항목을 스킵했다면(fetchPage 호출부), 원인은 id가 아니라
	// hasRequiredFields(제목/초록)일 수밖에 없다 — parseEntry의 두 검사(hasRequiredFields,
	// extractId)가 정확히 이 함수의 두 갈래와 대응하기 때문이다.
	private static classifySkipReason(rawId: string): SkippedEntryReason {
		return ArxivAPI.extractId(rawId) ? 'missing-fields' : 'no-id';
	}

	// <published>(제출 시각, ISO 8601)를 epoch ms로. 커버리지 커서로 쓰므로 날짜 단위인
	// Paper.publicationDate가 아니라 원본 타임스탬프를 그대로 읽는다.
	private static publishedEpochMs(entry: Element): number | undefined {
		const raw = ArxivAPI.text(entry.querySelector('published'));
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
	//
	// 이 판정이 공용 모듈이 아니라 클래스 안에 있는 이유: "200 OK인데 실패"는 arXiv만의
	// 기벽이라, 범용 HTTP 도구가 알아야 할 사실이 아니다.
	private static assertNotErrorEntry(entry: Element): void {
		const rawId = ArxivAPI.text(entry.querySelector('id'));
		if (!rawId.includes(ArxivAPI.ERROR_ID_MARK)) {
			return;
		}
		const reason = ArxivAPI.text(entry.querySelector('summary')) || rawId;
		throw new ConfigurationError(`arXiv rejected the query: ${reason}`);
	}

	// <opensearch:totalResults>를 읽어 이 검색의 전체 건수를 돌려준다. 페이지를 더 받을지
	// 판단하는 데 쓴다. 읽지 못하면 -1을 반환해 호출자가 다른 기준으로 종료하게 한다.
	//
	// 빈 문자열을 먼저 걸러야 한다 — Number('')는 NaN이 아니라 0이라, 그냥 Number()에
	// 넘기면 "태그를 못 읽음"이 "전체 0건"으로 둔갑한다. 그러면 호출자가 첫 페이지 직후
	// 수집을 끝내면서 전 구간을 다 훑었다고 기록해버린다.
	private static readTotalResults(xml: Document): number {
		const el =
			xml.getElementsByTagNameNS(ArxivAPI.OPENSEARCH_NS, 'totalResults')[0] ??
			xml.getElementsByTagName('opensearch:totalResults')[0];
		const raw = ArxivAPI.text(el ?? null);
		if (!raw) {
			return -1;
		}
		const value = Number(raw);
		return Number.isFinite(value) && value >= 0 ? value : -1;
	}

	// [2] 정책 — 필수 필드(id/title/summary)가 없는 항목은 undefined를 반환해 호출자가
	// 그 논문만 건너뛰게 한다. 전체 수집을 실패시키지 않는다.
	private static parseEntry(entry: Element, collectedQuery: SearchQuery): Paper | undefined {
		const rawId = ArxivAPI.text(entry.querySelector('id'));
		const title = ArxivAPI.text(entry.querySelector('title')).replace(/\s+/g, ' ');
		const abstract = ArxivAPI.text(entry.querySelector('summary'));
		if (!hasRequiredFields(rawId, title, abstract)) {
			return undefined;
		}

		// arXiv 논문 id로 해석되지 않는 항목(예: /abs/ 없는 id)은 sourceId를 만들 수 없으므로
		// [2] 정책대로 이 항목만 건너뛴다.
		const arxivId = ArxivAPI.extractId(rawId);
		if (!arxivId) {
			return undefined;
		}

		const paper = new Paper();
		paper.title = title;
		paper.authors = Array.from(entry.querySelectorAll('author > name')).map((n) =>
			ArxivAPI.text(n),
		);
		paper.abstract = abstract;
		paper.sourceId = `arxiv:${arxivId}`;
		paper.references = [];

		// <published>는 최초 버전 제출일(ISO 8601) — 앞 10자(YYYY-MM-DD)만 취한다.
		paper.publicationDate = ArxivAPI.text(entry.querySelector('published')).slice(0, 10);

		// arXiv 응답엔 인용수가 없다. [3] 정책 — 보강 단계에서 채워지며, 실패하면 false로 남는다.
		paper.citationCount = 0;
		paper.citationsKnown = false;

		paper.collectedApis = ['arxiv'];
		paper.collectedQueries = [collectedQuery];

		// 임베딩은 이 API의 책임이 아니다 (성진 담당) — 기본값만 채운다.
		paper.embedding = [];
		paper.embeddingModel = '';
		paper.embeddingSource = '';
		paper.embeddingSucceeded = false;

		return paper;
	}

	// ── S2 인용수 보강 (arXiv 수집의 일부) ─────────────────────────

	// [3] 정책 — citationsKnown=false인 논문만 골라 S2에서 citationCount를 채운다. 실패해도
	// 예외를 던지지 않고 citationsKnown=false로 남겨 다음 수집에서 다시 시도되게 한다.
	// public인 이유: 보정 패스(CollectAndSave.repair)가 저장된 논문을 다시 읽어와 이 재시도
	// 필터를 실사용한다 — 인터페이스 주석 참고.
	public async EnrichCitations(papers: Paper[], options?: { force?: boolean }): Promise<void> {
		const idToPapers = new Map<string, Paper[]>();
		for (const paper of papers) {
			if (!options?.force && paper.citationsKnown) {
				continue;
			}
			const localId = ArxivAPI.toLocalId(paper.sourceId);
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

		const infos = await this.fetchCitationBatch(Array.from(idToPapers.keys()));
		for (const [localId, info] of infos) {
			for (const paper of idToPapers.get(localId) ?? []) {
				paper.citationCount = info.citationCount;
				// 참고문헌도 같은 응답에 실려 오므로 citationsKnown이 두 값의 "보강 완료"
				// 플래그를 겸한다 — 이 플래그가 서면 재스캔이 S2를 다시 두드리지 않고,
				// prefillFromStore가 저장본의 references를 함께 복원한다.
				paper.references = info.references;
				paper.citationsKnown = true;
			}
		}
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
	//
	// secret에 S2 키가 등록돼 있으면 x-api-key 헤더로 실어 보낸다 — 익명 호출은 S2의 공용
	// rate limit을 다른 모든 익명 사용자와 나눠 쓰므로 429가 잦다. 키가 없으면 지금까지처럼
	// 익명으로 호출한다(throw하지 않음 — 키는 선택 사항).
	private async fetchCitationBatch(arxivIds: string[]): Promise<Map<string, S2PaperInfo>> {
		const result = new Map<string, S2PaperInfo>();
		const apiKey = this.secret?.getKey(S2_SECRET_PROVIDER);
		const chunks = chunk(arxivIds, ArxivAPI.S2_BATCH_CHUNK_SIZE);

		for (const [index, ids] of chunks.entries()) {
			// 청크를 연달아 쏘면 S2 rate limit에 바로 걸린다. 대용량 Backfill이면 청크가
			// 수백 개가 되는데, 그 실패는 전부 [3] 정책으로 조용히 삼켜져 인용수만 빈 채로
			// 남는다 — 애초에 429를 만들지 않는 편이 낫다.
			if (index > 0) {
				await delay(ArxivAPI.S2_CHUNK_DELAY_MS);
			}
			await runQuietly(async () => {
				const response = await requestWithRetry(
					{
						url: `${ArxivAPI.S2_BATCH_ENDPOINT}?fields=${ArxivAPI.S2_BATCH_FIELDS}`,
						method: 'POST',
						contentType: 'application/json',
						headers: apiKey ? { 'x-api-key': apiKey } : undefined,
						body: JSON.stringify({ ids: ids.map((id) => `ARXIV:${id}`) }),
					},
					ArxivAPI.S2_RETRY,
				);
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
					if (typeof echoed === 'string' && ArxivAPI.stripVersion(echoed) !== id) {
						continue;
					}
					result.set(id, {
						citationCount: element.citationCount,
						references: ArxivAPI.extractArxivReferences(element),
					});
				}
			});
		}

		return result;
	}

	// "arxiv:2501.12345" -> "2501.12345". S2가 못 다루는 출처(arxiv가 아님)면 null.
	private static toLocalId(sourceId: string): string | null {
		const [provider, localId] = sourceId.split(':');
		return provider === 'arxiv' && localId ? localId : null;
	}

	// S2 응답의 참고문헌 목록에서 arXiv에 있는 것만 sourceId 형태로 골라낸다.
	//
	// arXiv id가 없는 참고문헌(저널 논문, 단행본 등)은 버린다 — 이 코퍼스는 arXiv
	// 논문만 수집하므로 그런 참고문헌은 그래프의 어떤 노드와도 매칭될 수 없고, 저장해봐야
	// 파일 크기만 늘린다. 버전 접미사(v1 등)는 sourceId 규칙에 맞춰 떼고, 같은 논문을
	// 두 번 인용한 것처럼 보이는 항목(버전만 다른 중복 등)은 하나로 합친다.
	private static extractArxivReferences(element: S2BatchElement): string[] {
		const ids = new Set<string>();
		for (const reference of element.references ?? []) {
			const arxivId = reference?.externalIds?.ArXiv;
			if (typeof arxivId === 'string' && arxivId.length > 0) {
				ids.add(`arxiv:${ArxivAPI.stripVersion(arxivId)}`);
			}
		}
		return Array.from(ids);
	}

	// ── 새로고침 ────────────────────────────────────────────────────────

	// API.Refresh 구현 — arXiv에서 "최신 상태"란 인용수와 콘텐츠(제목/초록/저자) 둘 다다.
	// 그 둘을 어떤 순서로 어떻게 가져오는지는 이 구현체의 사정이고, 호출자
	// (CollectAndSave.refreshAllBody)는 알지 않는다.
	//
	// 인용수를 force로 다시 묻는 이유: 새로고침은 repair 계열과 달리 "실패한 것만"이
	// 아니라 "이미 아는 값도 전부 다시" 확인하는 게 목적이다(citationsKnown=true인
	// 논문도 인용수는 시간이 지나면 변한다).
	public async Refresh(papers: Paper[]): Promise<void> {
		await this.EnrichCitations(papers, { force: true });
		await this.refreshContent(papers);
	}

	// id_list로 재조회해 arXiv이 지금 돌려주는 제목/초록/저자를 비교 없이 그대로 덮어쓴다
	// ("정말 달라졌는지"는 CollectAndSave.refreshAllBody가 호출 전후 스냅샷으로 판단해
	// 재임베딩 여부를 정한다 — 여기는 최신값을 가져와 반영하는 것까지만 책임진다). id_list에
	// 없는(철회/삭제된) 논문은 건드리지 않는다.
	private async refreshContent(papers: Paper[]): Promise<void> {
		const idToPapers = new Map<string, Paper[]>();
		for (const paper of papers) {
			const localId = ArxivAPI.toLocalId(paper.sourceId);
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

		const chunks = chunk(Array.from(idToPapers.keys()), ArxivAPI.PAGE_SIZE);
		for (const [index, ids] of chunks.entries()) {
			if (index > 0) {
				await delay(ArxivAPI.PAGE_DELAY_MS);
			}
			await runQuietly(async () => {
				const infos = await this.fetchIdListPage(ids);
				for (const [localId, info] of infos) {
					for (const paper of idToPapers.get(localId) ?? []) {
						paper.title = info.title;
						paper.abstract = info.abstract;
						paper.authors = info.authors;
					}
				}
			}, 'Refresh.fetchIdListPage');
		}
	}

	// 7번(부분 재조회) — SkippedEntryRecord 중 'missing-fields'만 여기 온다(id는 파싱됐지만
	// 제목/초록이 비어 있던 항목). id_list로 다시 물어 이번엔 필드가 채워져 있으면 정식
	// Paper로 승격한다. refreshContent와 달리 이미 있는 Paper를 갱신하는 게 아니라 아직
	// Paper가 아니었던 항목을 처음 완성하는 것이라, parseEntry를 그대로 재사용해 나머지
	// 필드(citationCount 등 기본값)까지 정상 경로와 동일하게 채운다.
	//
	// id_list에 없거나 여전히 필수 필드가 비어 있으면 stillMissingRawIds에 남긴다 — 호출자
	// (CollectAndSave.retrySkippedEntries)가 그 레코드를 SkippedEntries.json에 그대로 둔다.
	public async RetryMissingEntries(
		rawIds: string[],
		collectedQuery: SearchQuery,
	): Promise<{ recovered: Paper[]; stillMissingRawIds: string[] }> {
		const idToRawIds = new Map<string, string[]>();
		for (const rawId of rawIds) {
			const localId = ArxivAPI.extractId(rawId);
			if (!localId) {
				// classifySkipReason이 이미 걸렀어야 정상이라 여기 오면 안 되지만, 방어적으로
				// 그대로 stillMissing 취급되게 idToRawIds에 안 넣는다(아래 최종 계산 참고).
				continue;
			}
			const list = idToRawIds.get(localId) ?? [];
			list.push(rawId);
			idToRawIds.set(localId, list);
		}
		if (idToRawIds.size === 0) {
			return { recovered: [], stillMissingRawIds: rawIds };
		}

		const recovered: Paper[] = [];
		const recoveredLocalIds = new Set<string>();
		const chunks = chunk(Array.from(idToRawIds.keys()), ArxivAPI.PAGE_SIZE);
		for (const [index, ids] of chunks.entries()) {
			if (index > 0) {
				await delay(ArxivAPI.PAGE_DELAY_MS);
			}
			await runQuietly(async () => {
				const params = new URLSearchParams({ id_list: ids.join(','), max_results: String(ids.length) });
				const url = `${ArxivAPI.ENDPOINT}?${params.toString()}`;
				const response = await requestWithRetry({ url }, ArxivAPI.ARXIV_RETRY);
				const xml = parseXmlOrThrow(response.text, 'arXiv');
				const entries = Array.from(xml.querySelectorAll('entry'));
				for (const entry of entries) {
					const rawId = ArxivAPI.text(entry.querySelector('id'));
					if (rawId.includes(ArxivAPI.ERROR_ID_MARK)) {
						continue;
					}
					const paper = ArxivAPI.parseEntry(entry, collectedQuery);
					if (!paper) {
						// 다시 물어봐도 여전히 필드가 비어 있다 — 그대로 stillMissing에 남는다.
						continue;
					}
					recovered.push(paper);
					recoveredLocalIds.add(ArxivAPI.toLocalId(paper.sourceId) ?? '');
				}
			}, 'RetryMissingEntries.fetchIdList');
		}

		const stillMissingRawIds = rawIds.filter((rawId) => {
			const localId = ArxivAPI.extractId(rawId);
			return !localId || !recoveredLocalIds.has(localId);
		});
		return { recovered, stillMissingRawIds };
	}

	// id_list로 여러 논문을 한 번에 재조회한다. arXiv 에러 응답([1] 정책과 같은 기벽)은
	// 개별 entry로 섞여 올 수 있어 ERROR_ID_MARK로 걸러 스킵한다 — id_list 전체를 실패
	// 처리하지 않는다(요청한 id 중 일부가 이미 삭제/철회됐어도 나머지는 살린다).
	private async fetchIdListPage(
		ids: string[],
	): Promise<Map<string, { title: string; abstract: string; authors: string[] }>> {
		const params = new URLSearchParams({ id_list: ids.join(','), max_results: String(ids.length) });
		const url = `${ArxivAPI.ENDPOINT}?${params.toString()}`;
		const response = await requestWithRetry({ url }, ArxivAPI.ARXIV_RETRY);
		const xml = parseXmlOrThrow(response.text, 'arXiv');
		const entries = Array.from(xml.querySelectorAll('entry'));
		const result = new Map<string, { title: string; abstract: string; authors: string[] }>();
		for (const entry of entries) {
			const rawId = ArxivAPI.text(entry.querySelector('id'));
			if (rawId.includes(ArxivAPI.ERROR_ID_MARK)) {
				continue;
			}
			const localId = ArxivAPI.extractId(rawId);
			if (!localId) {
				continue;
			}
			result.set(localId, {
				title: ArxivAPI.text(entry.querySelector('title')).replace(/\s+/g, ' '),
				abstract: ArxivAPI.text(entry.querySelector('summary')),
				authors: Array.from(entry.querySelectorAll('author > name')).map((n) => ArxivAPI.text(n)),
			});
		}
		return result;
	}
}
