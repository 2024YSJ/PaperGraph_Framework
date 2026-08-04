import { SearchQuery } from './SearchQuery';
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

// 예시용 구현체 — arXiv API. apiName은 'arxiv' 고정(Subscriptions 복원 시 판별 키).
// 실제 검색/수집 로직은 신빈이 채운다. 다른 API(semanticScholar 등)도 이 클래스처럼
// API를 implements하는 형태로 추가하면 된다.
export class ArxivAPI implements API {
	readonly apiName = 'arxiv';
	querys: SearchQuery[];

	constructor(querys: SearchQuery[] = []) {
		this.querys = querys;
	}

	SearchBase(): Promise<Paper[]> {
		return Promise.reject(new Error('Not implemented: ArxivAPI.SearchBase'));
	}

	SearchRecentPaper(hours: number): Promise<Paper[]> {
		return Promise.reject(new Error(`Not implemented: ArxivAPI.SearchRecentPaper(${hours})`));
	}

	Backfill(from: number, to: number): Promise<Paper[]> {
		return Promise.reject(new Error(`Not implemented: ArxivAPI.Backfill(${from}, ${to})`));
	}
}
