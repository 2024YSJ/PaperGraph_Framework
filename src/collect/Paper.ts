// 빈 껍데기 — 실제 필드 확정/검증 로직은 우빈이 채운다.
//
// 아래 필드 목록은 docs/Structure/PaperGraph3D_Class_Diagram.md의 (+)/(-) 표기를
// 문자 그대로 반영한 것이다 ((+) = 새 Paper에 추가, (-) = 새 Paper에서 제거).
//
// 주의: (-) 표기로 publicationYear를 제거했지만, 기존 PaperGraph3D 프로젝트에서는
// publicationYear가 그래프 z축/backfill 윈도우/refresh 판단 등 여러 곳에서 핵심적으로
// 쓰였다 (src/models/paper.ts, src/graph/*). 정말 제거해도 되는지 우빈이 구현 전에
// 팀과 한 번 더 확인이 필요하다 (2026-08-02 다이어그램 회의 원문: "발행 년도 (-)").
export class Paper {
	title!: string;
	authors!: string[];
	citationCount!: number;
	citationsKnown!: boolean; // (+) 인용수가 확인된 논문인가
	collectionMethod!: 'recent' | 'backfill'; // (+) 어떤 방법으로 수집된 것인가
	// 임베딩 성공/실패를 T/F로 교체 (기존 embedding/embeddingFailure 조합의 대체).
	embeddingSucceeded!: boolean;
	abstract!: string;
	sourceId!: string;
	references!: string[];
}
