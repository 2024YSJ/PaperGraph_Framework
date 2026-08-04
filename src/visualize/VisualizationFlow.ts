import { PCA } from './PCA';
import { Visualization } from './Visualization';
import { Middleware } from '../common/Middleware';

export class VisualizationFlow {
	pca!: PCA;
	visual!: Visualization;
	middlewares: Middleware[] = [];

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
	// PCA 호출은 this.pca.run(papers) 한 줄이면 된다 — 축은 PCA가 내부에 캐시해두므로
	// 논문이 늘어도 기존 점이 제자리에 남는다. 다른 코퍼스를 보여줄 때만 pca.resetBasis()를 부른다.
	// 유효 논문이 부족하면 PCAError가 나는데, 여기서 삼키지 말고 main까지 올린다
	// (재수집 여부는 main이 판단한다 — 8/1 회의 합의).
	async run(): Promise<void> {
		throw new Error('Not implemented: VisualizationFlow.run');
	}
}
