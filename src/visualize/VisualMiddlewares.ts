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

// 시각화 미들웨어: 그래프 위에 스위치를 얹어 엣지(링크)를 껐다 켤 수 있게 한다.
// render 후크로 3d-force-graph 인스턴스를 받아 링크 표시 여부를 이 미들웨어의 상태(visible)로
// 제어하고, 컨테이너에 토글 스위치 UI를 오버레이로 붙인다. 상태는 뷰를 다시 그려도 유지된다.
export class EdgeToggleMiddleware implements Middleware {
	type: MiddlewareType = 'visual';
	private visible = true;

	run(context: unknown): void {
		const graph = context as GraphData;
		const container = graph.container;
		graph.renderHooks.push((forceGraph) => {
			// 링크 표시 여부를 visible 상태로 제어(3d-force-graph 링크 가시성 접근자).
			forceGraph.linkVisibility(() => this.visible);
			if (!container) {
				return;
			}
			// 스위치 UI(오버레이): "인용 엣지" 라벨 + 토글 스위치.
			const wrap = container.createDiv({ cls: 'papergraph3d-edge-toggle' });
			wrap.createSpan({ text: '인용 엣지' });
			const label = wrap.createEl('label', { cls: 'papergraph3d-switch' });
			const input = label.createEl('input', { attr: { type: 'checkbox' } });
			input.checked = this.visible;
			label.createSpan({ cls: 'slider' });
			input.addEventListener('change', () => {
				this.visible = input.checked;
				forceGraph.linkVisibility(() => this.visible); // 표시 갱신
			});
		});
	}
}

// 클러스터별 색. 서로 잘 구분되도록 고른 값들로, 앞쪽일수록 차이가 크다 — 번호가 크기순이라
// 큰 덩어리부터 뚜렷한 색을 갖는다. 개수는 Clustering.MAX_K(20)와 맞춰, 상한까지 나눠도
// 색이 겹치지 않게 했다(그보다 많아지면 앞에서부터 다시 쓴다).
const CLUSTER_COLORS = [
	'#e6194b',
	'#3cb44b',
	'#4363d8',
	'#f58231',
	'#911eb4',
	'#46f0f0',
	'#f032e6',
	'#bcf60c',
	'#008080',
	'#9a6324',
	'#800000',
	'#aaffc3',
	'#808000',
	'#ffd8b1',
	'#000075',
	'#a9a9a9',
	'#fabed4',
	'#dcbeff',
	'#fffac8',
	'#ffe119',
];
const COLOR_UNCLUSTERED = '#8a8a8a'; // 회색 — 어느 덩어리에도 안 속한 논문

// 시각화 미들웨어: 논문을 임베딩으로 묶어 덩어리마다 다른 색을 칠한다.
//
// 기본은 꺼짐이다. 켜져 있지 않으면 계산조차 하지 않으므로 시각화를 여는 속도에 영향이 없다.
// 켜고 끄는 것은 버튼 쪽에서 toggle()로 한다 — 이 미들웨어는 버튼을 만들지 않는다.
//
// 덩어리 번호는 paper.extra.clusterId에 들어간다(Clustering). 이 미들웨어는 그 값을 색으로
// 옮기기만 하므로, 다른 미들웨어도 같은 값을 읽어 쓸 수 있다. 값은 메모리에만 남는다 —
// 시각화 흐름에는 저장 단계가 없고, 계산이 결정적이라 다시 열면 같은 색이 나온다.
//
// 노드 색을 칠하는 다른 미들웨어(CitationColorMiddleware)보다 뒤에 등록해야 한다. 앞에 두면
// 켜놓아도 뒤에 오는 미들웨어가 색을 도로 덮어쓴다.
//
// ⚠️ 껐다 켜려면 그래프와 3d-force-graph 인스턴스를 계속 들고 있어야 한다(Middleware에는
// 뷰가 닫힐 때 알려주는 자리가 없다). 그래서 뷰를 닫아도 직전 그래프 하나가 메모리에 남는다.
// 다음에 뷰를 열면 새 것으로 교체되므로 쌓이지는 않는다.
export class ClusterColorMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	private readonly clustering = new Clustering();
	private graph: GraphData | undefined;
	// 켜기 전의 색(다른 미들웨어가 칠해둔 것)을 노드 id별로 기억했다가 끌 때 되돌린다.
	private previousColors = new Map<string, string | undefined>();
	private forceGraph: ForceGraph3DInstance | undefined;
	private on = false;
	private result: ClusterResult | undefined;
	// 사용자가 정한 덩어리 수. 0이면 구독 개수에서 자동으로 정한다(Clustering.chooseK).
	private requestedCount = 0;

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
		// 같은 시점에 스위치 UI도 컨테이너에 붙인다(render 후라 replaceChildren에 안 지워진다).
		graph.renderHooks.push((forceGraph) => {
			this.forceGraph = forceGraph;
			this.addSwitch(graph.container);
		});
		if (this.on) {
			this.paint();
		}
	}

	// 그래프 위에 이 미들웨어만의 조작부를 얹는다 — 켜고 끄는 스위치와, 몇 덩어리로 나눌지
	// 직접 넣는 칸. 다른 미들웨어(EdgeToggleMiddleware)와 같은 방식으로 자기 UI를 소유한다.
	//
	// 덩어리 수는 데이터만으로 정해지지 않는다 — 실루엣·CH지수·BIC를 실제 볼트로 재봤더니
	// 각각 2, 2, 14+를 가리켰다(Clustering 주석 참고). "몇 덩어리로 볼 것인가"는 크게 볼지
	// 잘게 볼지의 선택에 가까워서, 비워두면 구독 개수로 정하되 사용자가 덮어쓸 수 있게 한다.
	private addSwitch(container: HTMLElement | undefined): void {
		if (!container) {
			return;
		}
		const wrap = container.createDiv({ cls: 'papergraph3d-cluster-toggle' });
		wrap.createSpan({ text: '클러스터 색' });
		const label = wrap.createEl('label', { cls: 'papergraph3d-switch' });
		const input = label.createEl('input', { attr: { type: 'checkbox' } });
		input.checked = this.on;
		label.createSpan({ cls: 'slider' });

		// 덩어리 수 입력칸. 범위는 논문 수에 따라 달라진다(적은 논문을 잘게 쪼개면 덩어리당
		// 몇 편 안 남는다). 넘겨도 Clustering이 잘라내지만, 여기서 미리 알려주는 편이 낫다.
		const maxCount = Clustering.maxK(this.graph?.nodes.length ?? 0);
		const count = wrap.createEl('input', {
			cls: 'papergraph3d-cluster-count',
			attr: {
				type: 'number',
				min: String(Clustering.minK),
				max: String(maxCount),
				placeholder: '자동',
				title: `덩어리 수 (${Clustering.minK}~${maxCount}, 비우면 구독 개수)`,
			},
		});
		count.value = this.requestedCount > 0 ? String(this.requestedCount) : '';

		const info = wrap.createSpan({ cls: 'papergraph3d-cluster-info' });
		const showResult = (): void => {
			if (!this.on || !this.result) {
				info.setText('');
				return;
			}
			// 요청한 값이 잘렸으면 그 사실을 알려준다 — 안 그러면 왜 숫자가 다른지 알 수 없다.
			const { clusterCount, requestedCount } = this.result;
			const clamped = requestedCount > 0 && requestedCount !== clusterCount;
			info.setText(clamped ? `${clusterCount}개 덩어리 (${requestedCount}에서 조정)` : `${clusterCount}개 덩어리`);
			count.value = this.requestedCount > 0 ? String(clusterCount) : '';
		};
		showResult();

		input.addEventListener('change', () => {
			this.toggle();
			showResult();
		});
		count.addEventListener('change', () => {
			const value = Number(count.value);
			this.requestedCount = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
			// 켜져 있을 때만 다시 칠한다(꺼져 있으면 켜는 순간 새 값으로 계산된다). paint는
			// previousColors를 이미 채워둔 노드는 건너뛰므로, 클러스터 색을 "원래 색"으로
			// 잘못 기억하지 않는다.
			if (this.on) {
				this.paint();
			}
			showResult();
		});
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
		this.result = this.clustering.run(graph.nodes.map((node) => node.paper), this.requestedCount);
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

	// 이미 그려진 그래프에 색 변경을 반영한다. 3d-force-graph는 접근자를 다시 넣어야 노드 색을
	// 다시 읽으므로, 지금 쓰고 있는 접근자를 꺼내 그대로 돌려준다(인자 없이 부르면 게터다).
	// 접근자를 새로 지어내면 render가 정한 기본색을 여기서 한 번 더 적어야 해서, 나중에 한쪽만
	// 바뀌면 조용히 어긋난다.
	//
	// 아직 그리기 전이면(render 전에 toggle) 할 일이 없다 — render가 node.color를 그대로 읽는다.
	private refresh(): void {
		const forceGraph = this.forceGraph;
		forceGraph?.nodeColor(forceGraph.nodeColor());
	}
}
