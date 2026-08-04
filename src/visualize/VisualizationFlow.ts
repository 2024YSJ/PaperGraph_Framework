import { PCA, type PCABasis } from './PCA';
import { Visualization } from './Visualization';
import { Middleware } from '../common/Middleware';

export class VisualizationFlow {
	pca!: PCA;
	visual!: Visualization;
	middlewares: Middleware[] = [];

	// PCA가 찾은 축(평균 벡터 + 두 주성분). 논문이 추가돼도 기존 점이 제자리에 있게 하려면
	// 이 값을 보관했다가 다음 호출에 그대로 넘겨야 한다. PCA는 상태를 남기지 않으므로
	// 보관은 호출 측인 여기의 몫이다 (docs/Structure/PCA_Spec.md 9절).
	//
	// 재사용할지 다시 계산할지는 PCA가 스스로 판단하므로(모델 변경·편수 20% 증감 등)
	// 여기서는 정책을 알 필요 없이 보관과 전달만 하면 된다.
	basis?: PCABasis;

	// 등록 계열: 안전하게 동작한다.
	setMiddleware(mw: Middleware): void {
		this.middlewares.push(mw);
	}

	// 실행 계열: 아직 미구현.
	//
	// 구현 시 지킬 흐름 (다이어그램 명시):
	//   json 파일 읽기 -> PCA -> 시각화 일부 작업 -> 미들웨어 -> 시각화 마무리
	// 이 흐름 제어는 run() 안에서만 하고, 세부 함수가 미들웨어를 직접 호출하지 않는다.
	//
	// PCA 호출은 아래 두 줄이면 된다 (좌표 고정까지 포함):
	//   const result = this.pca.run(papers, this.basis);
	//   this.basis = result.basis;
	// 유효 논문이 부족하면 PCAError가 나는데, 여기서 삼키지 말고 main까지 올린다
	// (재수집 여부는 main이 판단한다 — 8/1 회의 합의).
	async run(): Promise<void> {
		throw new Error('Not implemented: VisualizationFlow.run');
	}
}
