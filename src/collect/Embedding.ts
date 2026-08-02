// 빈 껍데기 — 임베딩에 필요한 데이터/함수는 성진이 채운다 (3순위, 수요일).
//
// isModelInstalled/installModel은 다이어그램에 명시된 필드/함수는 아니지만, 기존
// PaperGraph3D 프로젝트의 설정탭에 있던 "임베딩 모델 설치" UI가 결합해야 할 함수라
// 오늘(빈 클래스 + UI 결합 함수 선언) 범위에 맞춰 시그니처만 먼저 선언해둔다.
export class Embedding {
	// 실행 계열: 아직 미구현.
	async isModelInstalled(): Promise<boolean> {
		throw new Error('Not implemented: Embedding.isModelInstalled');
	}

	// 실행 계열: 아직 미구현. onProgress는 설치 진행률(0~1)을 전달하는 용도.
	async installModel(onProgress?: (progress: number) => void): Promise<void> {
		throw new Error('Not implemented: Embedding.installModel');
	}
}
