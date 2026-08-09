// 시각화(visual) 미들웨어 모음. VisualizationFlow.run이 init 후 render 전에 type === 'visual'
// 미들웨어들의 run(GraphData)을 순서대로 부른다. 새 visual 미들웨어는 이 파일에 추가한다.
import { App, TFile } from 'obsidian';
import { Middleware, MiddlewareType } from '../common/Middleware';
import { File } from '../common/File';
import { GraphData, GraphNode } from './GraphData';

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

// 시각화 미들웨어: 노드를 클릭하면 그 논문의 .md 노트를 새 탭에 연다.
// graph.events.nodeClick에 핸들러를 등록하면 render가 3d-force-graph의 클릭에 연결한다.
// (미들웨어는 씬이 만들어지기 전에 돌므로, 직접 이벤트를 걸지 않고 GraphData에 핸들러만 남긴다.)
export class OpenNoteOnClickMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	constructor(private app: App) {}

	run(context: unknown): void {
		const graph = context as GraphData;
		graph.events.nodeClick.push((node) => {
			void this.openNote(node);
		});
	}

	private async openNote(node: GraphNode): Promise<void> {
		const path = File.paperNotePath(node.paper);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf('tab').openFile(file);
		}
	}
}

// 시각화 미들웨어: 논문 간 인용 관계를 엣지로 추가한다.
// paper.references(이 논문이 인용하는 논문들의 sourceId) 중, 그래프에 함께 있는 논문만
// 엣지로 잇는다(로드 안 된 논문으로는 선을 그을 수 없으므로). graph.links에 push하면
// render가 3d-force-graph에 함께 넘겨 그린다.
const CITATION_ARROW_LENGTH = 4; // 인용 방향 화살표 길이

export class CitationEdgeMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	run(context: unknown): void {
		const graph = context as GraphData;
		const nodeIds = new Set(graph.nodes.map((node) => node.id));
		for (const node of graph.nodes) {
			if (!Array.isArray(node.paper.references)) {
				continue;
			}
			for (const ref of node.paper.references) {
				if (nodeIds.has(ref)) {
					graph.links.push({ source: node.id, target: ref });
				}
			}
		}
		// 인용 방향(source→target)을 화살표로 표시 — render 후크로 3d-force-graph 인스턴스에
		// 직접 건다(render를 고치지 않고 확장). 화살표는 target 끝(=인용된 논문)에.
		graph.renderHooks.push((forceGraph) => {
			forceGraph.linkDirectionalArrowLength(CITATION_ARROW_LENGTH).linkDirectionalArrowRelPos(1);
		});
	}
}
