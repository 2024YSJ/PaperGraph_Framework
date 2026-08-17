import { PCA, PCAResult } from './PCA';
import { Visualization } from './Visualization';
import { Middleware } from '../common/Middleware';
import { File } from '../common/File';

export class VisualizationFlow {
	pca!: PCA;
	visual!: Visualization;
	middlewares: Middleware[] = [];

	// run()이 성공(PCAError 없이 끝남)했을 때의 마지막 PCAResult — malformed/duplicateId로
	// 제외된 논문이 있어도 needsReembedding에는 안 잡히고(재임베딩으로 못 고치는 손상이라)
	// 무알림이었던 문제를 호출자(VisualizationView)가 여기서 읽어 알릴 수 있게 남겨둔다.
	// run() 자체의 흐름(로드 -> PCA -> init -> 미들웨어 -> render)은 그대로다 — 마지막에
	// 결과를 필드에 저장만 추가한다.
	lastResult: PCAResult | undefined;

	// 등록 계열: 안전하게 동작한다.
	setMiddleware(mw: Middleware): void {
		this.middlewares.push(mw);
	}

	// 시각화 파이프라인 전체를 조립한다 (설계: docs/devLog/007.md, 008.md).
	//   논문 로드 -> PCA -> init -> 미들웨어 -> render
	// 흐름 제어는 이 run() 안에서만 하고, 세부 함수가 미들웨어를 직접 호출하지 않는다.
	//
	// - PCA는 축을 내부에 캐시하므로 논문이 늘어도 기존 점이 제자리에 남는다. 여기서는
	//   resetBasis()를 부르지 않는다(다른 코퍼스로 갈아탈 때만 호출자가 별도로 reset).
	// - 유효 논문이 부족하면 PCA가 PCAError를 던지는데, 여기서 삼키지 말고 그대로 올린다
	//   (재수집 여부는 main/뷰가 판단 — 8/1 회의 합의).
	// - render가 graph.container를 쓰므로, run() 전에 뷰가 visual.setContainer(div)를
	//   호출해 둔 상태여야 한다.
	async run(): Promise<void> {
		const papers = await File.readAllPapers();
		const pca = this.pca.run(papers); // PCAError는 잡지 않고 그대로 전파
		this.lastResult = pca;
		const graph = this.visual.init(pca);
		// 시각화 미들웨어(type === 'visual')만, GraphData를 인자로 실행한다.
		for (const middleware of this.middlewares) {
			if (middleware.type === 'visual') {
				await middleware.run(graph);
			}
		}
		this.visual.render(graph);
	}
}
