import { Middleware, MiddlewareType } from '../common/Middleware';
import { GraphData } from './GraphData';

const COLOR_CITED = '#4f9dff'; // 파랑 — 피인용수가 있는 논문
const COLOR_UNCITED = '#ff9800'; // 주황 — 피인용수가 없는 논문

// 시각화 미들웨어: 피인용수에 따라 노드 색을 정한다.
//   citationCount > 0 → 파랑, 0(없음) → 주황.
// VisualizationFlow.run이 init 후 render 전에 이 run(graph)을 호출한다(type === 'visual').
// GraphData의 node.color를 제자리에서 바꾸면 render가 그 색으로 노드를 그린다.
export class CitationColorMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	run(context: unknown): void {
		const graph = context as GraphData;
		for (const node of graph.nodes) {
			node.color = node.paper.citationCount > 0 ? COLOR_CITED : COLOR_UNCITED;
		}
	}
}
