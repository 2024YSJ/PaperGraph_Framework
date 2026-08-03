// 검색 쿼리 정보. 2필드로 고정 확정 (docs/devLog/002.md, 2026-08-03).
// Paper.collectedQuery가 이 타입에 의존하므로 필드 이름/타입은 유지 전제이며,
// 신빈이 추후 필드를 추가하는 것은 무방하나 기존 2필드는 바꾸지 않는다.
export interface SearchQuery {
	searchType: string; // 검색하는 방법
	query: string; // 검색 쿼리 문자열
}
