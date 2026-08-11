// 시각화(visual) 미들웨어 모음. VisualizationFlow.run이 init 후 render 전에 type === 'visual'
// 미들웨어들의 run(GraphData)을 순서대로 부른다. 새 visual 미들웨어는 이 파일에 추가한다.
import { App, TFile } from 'obsidian';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { Middleware, MiddlewareType } from '../common/Middleware';
import { File } from '../common/File';
import { GraphData, GraphNode } from './GraphData';
import { Clustering, ClusterResult } from './Clustering';

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

// 클러스터별 색. 색맹 친화 팔레트에서 고른 값들로, 인접한 번호끼리 잘 구분된다.
// 덩어리가 이보다 많으면 앞에서부터 다시 쓴다 — 번호가 크기순이라 큰 덩어리부터
// 서로 다른 색을 갖는다.
const CLUSTER_COLORS = [
	'#e6194b',
	'#3cb44b',
	'#ffe119',
	'#4363d8',
	'#f58231',
	'#911eb4',
	'#46f0f0',
	'#f032e6',
	'#bcf60c',
	'#008080',
];
const COLOR_UNCLUSTERED = '#8a8a8a'; // 회색 — 어느 덩어리에도 안 속한 논문

// 시각화 미들웨어: 논문을 임베딩으로 묶어 덩어리마다 다른 색을 칠한다.
//
// 기본은 꺼짐이다. 켜져 있지 않으면 계산조차 하지 않으므로 시각화를 여는 속도에 영향이 없다.
// 켜고 끄는 것은 버튼 쪽에서 toggle()로 한다 — 이 미들웨어는 버튼을 만들지 않는다.
//
// 덩어리 번호는 paper.extra.clusterId에 들어간다(Clustering). 이 미들웨어는 그 값을 색으로
// 옮기기만 하므로, 다른 미들웨어도 같은 값을 읽어 쓸 수 있다.
export class ClusterColorMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	private readonly clustering = new Clustering();
	private graph: GraphData | undefined;
	// 켜기 전의 색(다른 미들웨어가 칠해둔 것)을 노드 id별로 기억했다가 끌 때 되돌린다.
	private previousColors = new Map<string, string | undefined>();
	private forceGraph: ForceGraph3DInstance | undefined;
	private on = false;
	private result: ClusterResult | undefined;

	// 버튼이 읽는 상태 — 지금 켜져 있는가, 어떻게 나뉘었는가(덩어리 수·보류된 논문 수).
	get enabled(): boolean {
		return this.on;
	}

	get lastResult(): ClusterResult | undefined {
		return this.result;
	}

	run(context: unknown): void {
		const graph = context as GraphData;
		this.graph = graph;
		this.previousColors = new Map();
		// render가 3d-force-graph를 만든 뒤 인스턴스를 받아 둔다. 버튼으로 껐다 켤 때 다시
		// 그리지 않고 색만 바꾸기 위한 통로다(다시 그리면 PCA부터 새로 돈다).
		graph.renderHooks.push((forceGraph) => {
			this.forceGraph = forceGraph;
		});
		if (this.on) {
			this.paint();
		}
	}

	// 버튼이 부른다. 켜면 (캐시가 없으면 계산한 뒤) 덩어리 색으로, 끄면 원래 색으로 되돌린다.
	toggle(): ClusterResult | undefined {
		this.on = !this.on;
		if (this.on) {
			this.paint();
		} else {
			this.restore();
		}
		return this.result;
	}

	// 논문을 묶어(캐시가 있으면 재사용) 노드 색을 바꾼다.
	private paint(): void {
		const graph = this.graph;
		if (!graph) {
			return;
		}
		this.result = this.clustering.run(graph.nodes.map((node) => node.paper));
		for (const node of graph.nodes) {
			if (!this.previousColors.has(node.id)) {
				this.previousColors.set(node.id, node.color);
			}
			const cluster = node.paper.extra?.clusterId;
			node.color =
				cluster === undefined ? COLOR_UNCLUSTERED : CLUSTER_COLORS[cluster % CLUSTER_COLORS.length];
		}
		this.refresh();
	}

	// 켜기 전 색으로 되돌린다.
	private restore(): void {
		for (const node of this.graph?.nodes ?? []) {
			node.color = this.previousColors.get(node.id);
		}
		this.refresh();
	}

	// 이미 그려진 그래프에 색 변경을 반영한다. 같은 접근자를 다시 넣으면 3d-force-graph가
	// 노드 색을 다시 읽는다. 아직 그리기 전이면(render 전에 toggle) 할 일이 없다 — render가
	// node.color를 그대로 쓰기 때문이다.
	private refresh(): void {
		this.forceGraph?.nodeColor((node) => (node as GraphNode).color ?? COLOR_CITED);
	}
}
