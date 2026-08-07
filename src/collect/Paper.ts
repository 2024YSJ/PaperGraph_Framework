import { SearchQuery } from './SearchQuery';

// 논문 한 편을 나타내는 데이터 객체. 필드 확정 근거는 docs/devLog/002.md 참고
// (2026-08-03, 실제 저장 JSON schemaVersion:3 대조 기준).
export class Paper {
	// 기본 서지 정보
	title!: string;
	authors!: string[];
	abstract!: string;
	sourceId!: string;
	references!: string[];

	// 발행 시점: publicationYear(연도)를 제거하고 ISO 날짜 문자열로 대체("2025-11-07").
	// 연도가 필요하면 이 값에서 파생한다.
	publicationDate!: string;

	// 인용
	citationCount!: number;
	citationsKnown!: boolean; // (+) 인용수가 확인된 논문인가

	// 수집 출처: "어떤 방법(들)으로 수집됐는가" = 어떤 API로, 어떤 검색 쿼리로 수집했는가.
	// 같은 논문을 서로 다른 구독이 각각 발견할 수 있으므로 배열이다 — 두 배열은 같은
	// 인덱스가 한 쌍(같은 구독)을 이룬다. (recent/backfill 구분이 아니다 — 그건
	// CollectAndSave.run()의 실행 모드다.)
	collectedApis!: string[]; // (+) 수집한 API 식별자들 (Secret 맵의 provider 키와 동일 체계)
	collectedQueries!: SearchQuery[]; // (+) 수집에 사용된 검색 쿼리들 (collectedApis와 같은 인덱스가 한 쌍)

	// 임베딩
	embedding!: number[]; // 임베딩 벡터 (PCA/시각화 입력)
	embeddingModel!: string;
	embeddingSource!: string;
	// 임베딩 성공/실패를 T/F로 표기 (기존 embeddingFailure 값/null 조합의 대체).
	embeddingSucceeded!: boolean;
}
