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

// "이 논문의 임베딩을 다시 계산해야 하는가"를 판단하기 위한 비교용 키.
//
// 새로고침(CollectAndSave.refreshAllBody)이 API 재조회 전후로 이 값을 떠서 비교한다. 이게
// 없으면 재조회 경로가 `paper.title !== prev.title || paper.abstract !== prev.abstract`
// 처럼 필드 이름을 직접 알아야 하는데, 그러면 임베딩 입력이 바뀔 때(예: 저자를 입력에
// 포함) 재임베딩 판정이 조용히 어긋난다 — 필드가 늘었는데 비교는 옛 두 개만 하므로
// "안 바뀐 것"으로 오판한다.
//
// ⚠️ Embedding.buildModelInput이 실제로 모델에 넣는 필드와 항상 같은 집합이어야 한다.
// 두 함수를 하나로 합치지는 않는다 — 저쪽은 "모델 학습 포맷"(SPECTER2의 [SEP])이라
// 모델을 교체하면 바뀌고, 이쪽은 "무엇이 달라지면 다시 계산해야 하는가"라는 도메인
// 판단이다. 포맷이 아니라 필드 집합만 맞으면 되므로 구분자는 일부러 다르게 둔다 —
// 제목 끝과 초록 앞이 우연히 이어붙어 서로 다른 논문이 같은 키를 갖는 일만 막으면 된다.
export function embeddingSourceOf(paper: Paper): string {
	return `${paper.title}\u0000${paper.abstract}`;
}

// 미들웨어가 만들어내는 값을 담는 자리. 요약이나 클러스터 라벨처럼 수집·임베딩이
// 보장하지 않는 값은 Paper의 필수 필드로 둘 수 없어서 여기에 모은다.
// 미들웨어를 새로 만들 때 그 미들웨어가 채울 필드를 여기에 optional로 추가한다.
// (예: summary?: string) — 필드가 늘어도 Paper의 필수 필드와 File의 저장/비교
// 로직은 그대로다.
export class ExtraData {
	// 클러스터 번호 (0부터, 큰 덩어리가 0). 밀도가 낮아 어느 덩어리에도 안 들어간 논문은
	// 값이 없다 — "아직 안 나눴다"와 "나눠봤지만 어디에도 안 속한다"가 둘 다 없음으로
	// 표현되지만, 시각화는 둘 다 기본색으로 그리므로 구분할 필요가 없다.
	clusterId?: number;
}
