import { SearchQuery } from './SearchQuery';
import { Paper } from './Paper';

// 빈 껍데기 — 나머지 필요한 함수는 신빈이 채운다.
export interface API {
	querys: SearchQuery[];
	SearchBase(): Promise<Paper[]>;
	SearchRecentPaper(hours: number): Promise<Paper[]>;
	Backfill(from: number, to: number): Promise<Paper[]>;
}
