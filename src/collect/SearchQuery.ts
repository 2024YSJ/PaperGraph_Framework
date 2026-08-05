// 검색 쿼리 정보. 2필드로 고정 확정 (docs/devLog/002.md, 2026-08-03).
// Paper.collectedQueries가 이 타입에 의존하므로 필드 이름/타입은 유지 전제이며,
// 신빈이 추후 필드를 추가하는 것은 무방하나 기존 2필드는 바꾸지 않는다.
export interface SearchQuery {
	searchType: string; // 검색하는 방법
	query: string; // 검색 쿼리 문자열
}

// 구독 조건은 최대 3개, 전부 AND로 결합한다 (2026-08-04 확정). Paper.collectedQueries의
// 항목 하나는 "구독 하나"를 나타내므로, 한 구독 안에서 AND로 묶인 여러 조건은 하나의
// 대표 SearchQuery로 합성해 기록한다(개별 조건 중 어느 것에 "매칭됐는지" 구분할 필요가
// 없는 AND 결합이라 이 표현으로 충분하다). 서로 다른 구독이 같은 논문을 각각 발견하는
// 경우는 collectedApis/collectedQueries 배열에 항목이 늘어나는 것으로 표현된다 —
// combineQueries는 그 배열의 항목 하나를 만드는 함수다.
// arXiv 전용 로직이 아니라 SearchQuery[] 자체의 성질이므로, 모든 API 구현체가 공유한다.
export function combineQueries(querys: SearchQuery[]): SearchQuery {
	return {
		searchType: 'combined',
		query: querys.map((q) => `${q.searchType}:${q.query}`).join(' AND '),
	};
}
