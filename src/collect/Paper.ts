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

	// 미들웨어가 덧붙이는 값들 (요약, 클러스터 라벨 등). 위 필드들과 달리 채워지지 않을
	// 수 있어서, 미들웨어가 안 돌아도 항상 빈 객체는 있도록 여기서 바로 만들어 둔다
	// (= 쓰는 쪽에서 undefined 검사를 안 해도 된다).
	extra: ExtraData = new ExtraData();
}

// 미들웨어가 만들어내는 값을 담는 자리. 요약이나 클러스터 라벨처럼 수집·임베딩이
// 보장하지 않는 값은 Paper의 필수 필드로 둘 수 없어서 여기에 모은다.
// 미들웨어를 새로 만들 때 그 미들웨어가 채울 필드를 여기에 optional로 추가한다.
// (예: summary?: string) — 필드가 늘어도 Paper의 필수 필드와 File의 저장/비교
// 로직은 그대로다.
export class ExtraData {}
