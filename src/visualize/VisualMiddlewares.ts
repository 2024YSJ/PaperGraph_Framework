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
// 경고를 띄워 두는 시간. 한글 한 문장을 읽기에 3초는 짧고, 더 길면 상태 표시가 오래 가려진다.
const WARNING_MS = 5000;
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
	// 결과·경고를 띄우는 자리. addSwitch가 만들고 showResult/showWarning이 갱신한다.
	private info: HTMLElement | undefined;
	// 경고를 지우는 예약. 새 경고가 오거나 결과를 다시 그릴 때 취소한다.
	private warningTimer: number | undefined;

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
		// 예약된 경고 지우기를 취소한다. 남겨두면 새로 그린 화면의 상태 표시를 나중에 덮는다.
		this.clearWarningTimer();
		// 덩어리 수는 뷰를 새로 열 때마다 비운다. 허용 범위가 논문 수에 따라 달라지므로,
		// 예전에 넣어둔 숫자는 지금 코퍼스에 맞는 값이라는 보장이 없다(논문 100편일 때 넣은
		// 5가 8000편이 된 뒤에도 남아 있으면 그건 의도가 아니라 흔적이다). 스위치 상태(on)는
		// 그대로 둔다 — "클러스터로 보고 싶다"는 의사는 논문 수와 무관하다.
		this.requestedCount = 0;
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
		// 허용 범위는 논문 수에 따라 달라진다 — 적은 논문을 잘게 쪼개면 덩어리당 몇 편 안 남는다.
		const maxCount = Clustering.maxK(this.graph?.nodes.length ?? 0);
		const range = `${Clustering.minK}~${maxCount}`;

		const wrap = container.createDiv({ cls: 'papergraph3d-cluster-toggle' });
		wrap.createSpan({ text: '클러스터 색' });
		const label = wrap.createEl('label', { cls: 'papergraph3d-switch' });
		const power = label.createEl('input', { attr: { type: 'checkbox' } });
		power.checked = this.on;
		label.createSpan({ cls: 'slider' });

		// 안내를 칸 안(placeholder)이 아니라 이름표와 범위로 나눠 둔다 — 칸이 좁아 문장이
		// 안 들어가고, placeholder는 값을 넣는 순간 사라져 범위를 다시 확인할 수 없다.
		wrap.createSpan({ cls: 'papergraph3d-cluster-label', text: '덩어리 수' });
		const count = wrap.createEl('input', {
			cls: 'papergraph3d-cluster-count',
			attr: {
				type: 'number',
				min: String(Clustering.minK),
				max: String(maxCount),
				placeholder: '자동',
				title: `몇 덩어리로 나눌지 정합니다. ${range} 사이로 넣으세요. 비워두면 구독 개수만큼 자동으로 나눕니다.`,
			},
		});
		count.value = this.requestedCount > 0 ? String(this.requestedCount) : '';
		wrap.createSpan({ cls: 'papergraph3d-cluster-hint', text: range });

		this.info = wrap.createSpan({ cls: 'papergraph3d-cluster-info' });
		this.showResult();

		power.addEventListener('change', () => {
			// 잘못된 값이 칸에 남아 있어도 켜는 것 자체는 막지 않는다 — 사용자가 원한 것은
			// "클러스터를 보는 것"이고 숫자 실수는 부차적이다. 다만 그 값이 안 쓰였다는 사실은
			// 알려야 하므로, 자동으로 켠 뒤 안내를 함께 띄운다(경고를 놓치고 자기가 넣은
			// 수로 그려진 줄 아는 일을 막는다).
			const invalid = ClusterColorMiddleware.parseCount(count.value, maxCount) === null;
			this.toggle();
			if (this.on && invalid) {
				this.showWarning(`${range} 사이의 올바른 숫자를 입력해 주세요. 자동 숫자로 실행됩니다`);
				return;
			}
			this.showResult();
		});
		count.addEventListener('change', () => {
			const parsed = ClusterColorMiddleware.parseCount(count.value, maxCount);
			if (parsed === null) {
				// 범위를 벗어나면 조용히 고치지 않고 알린다. 말없이 다른 값으로 바꾸면 사용자는
				// 자기가 넣은 수가 왜 무시됐는지 알 수 없다. 입력한 값은 칸에 그대로 두어
				// 고쳐 쓰기 편하게 한다.
				this.showWarning(`${range} 사이의 수를 입력해 주세요`);
				return;
			}
			this.requestedCount = parsed;
			// 켜져 있을 때만 다시 칠한다(꺼져 있으면 켜는 순간 새 값으로 계산된다). paint는
			// previousColors를 이미 채워둔 노드는 건너뛰므로, 클러스터 색을 "원래 색"으로
			// 잘못 기억하지 않는다.
			if (this.on) {
				this.paint();
			}
			this.showResult();
		});
	}

	// 입력칸의 글자를 덩어리 수로 읽는다. 비었으면 0(구독 개수로 자동), 범위 안의 정수면
	// 그 값, 그 밖이면 null(= 쓰지 않고 안내한다).
	private static parseCount(text: string, maxCount: number): number | null {
		const trimmed = text.trim();
		if (trimmed === '') {
			return 0;
		}
		const value = Number(trimmed);
		if (!Number.isInteger(value) || value < Clustering.minK || value > maxCount) {
			return null;
		}
		return value;
	}

	// 지금 몇 덩어리로 나뉘었는지, 그 수를 누가 정했는지 보여준다. 사용자가 안 넣어서
	// 구독 개수로 정해진 경우를 "자동"이라고 밝혀야 한다 — 숫자만 띄우면 자기가 넣은 값이
	// 적용된 것인지 알 수 없다(범위를 벗어난 값을 넣고 안내를 못 보면 특히 헷갈린다).
	private showResult(): void {
		this.clearWarningTimer();
		this.info?.removeClass('papergraph3d-cluster-warn');
		if (!this.on || !this.result) {
			this.info?.setText('');
			return;
		}
		const { clusterCount, requestedCount } = this.result;
		this.info?.setText(
			requestedCount > 0 ? `${clusterCount}개 덩어리` : `${clusterCount}개 덩어리 (자동)`,
		);
	}

	// 경고는 잠깐 띄우고 원래 상태 표시로 되돌린다. 계속 남겨두면 "지금 몇 덩어리인지"를
	// 가려버리고, 사용자가 값을 고친 뒤에도 옛 경고가 붙어 있는 것처럼 보인다.
	private showWarning(text: string): void {
		this.clearWarningTimer();
		this.info?.setText(text);
		this.info?.addClass('papergraph3d-cluster-warn');
		this.warningTimer = window.setTimeout(() => {
			this.warningTimer = undefined;
			this.showResult();
		}, WARNING_MS);
	}

	private clearWarningTimer(): void {
		if (this.warningTimer !== undefined) {
			window.clearTimeout(this.warningTimer);
			this.warningTimer = undefined;
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

// 시각화 미들웨어: 노드 라벨(논문 제목 등)을 HTML 엔티티로 이스케이프해 XSS를 막는다.
//
// 왜 필요한가 — 실제 싱크는 Visualization.render의 `.nodeLabel((n) => n.label)`이다.
// 3d-force-graph는 이 반환 문자열을 툴팁 DOM에 **innerHTML로 삽입**하므로, 라벨에
// 마크업이 들어 있으면 그대로 파싱된다. 라벨의 출처인 논문 제목(paper.title)은 arXiv
// 응답에서 온 신뢰할 수 없는 외부 데이터라, `<img src=x onerror=alert(document.cookie)>`
// 같은 제목이 저장돼 있으면 사용자가 그 노드에 마우스를 올리는 순간 스크립트가 실행된다.
// 여기서 라벨을 텍스트로 무해화하면, render가 innerHTML에 넣어도 브라우저가 마크업이
// 아니라 글자로 그린다.
//
// ⚠️ 등록 순서 — 반드시 **맨 마지막에** 등록해야 한다. 다른 visual 미들웨어가 노드를
// 더하거나(PersonalNoteMiddleware는 node.label에 노트 제목을 채운다) 라벨을 고칠 수
// 있는데, 그보다 먼저 돌면 나중에 추가된 라벨은 이스케이프되지 않은 채 render로 넘어간다.
// 이 미들웨어가 마지막에 돌면 그 시점에 존재하는 모든 node.label을 빠짐없이 덮는다.
//
// node.paper.title(원본 Paper)이 아니라 node.label만 바꾼다 — Paper 객체는 노트 열기 등
// 다른 경로로도 쓰이므로 표시용 사본인 라벨에서만 무해화한다.
export class LabelSanitizeMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	run(context: unknown): void {
		const graph = context as GraphData;
		for (const node of graph.nodes) {
			if (node.label !== undefined) {
				node.label = LabelSanitizeMiddleware.escapeHtml(node.label);
			}
		}
	}

	// HTML 엔티티 인코딩. `&`를 **가장 먼저** 치환해야 한다 — 나중에 치환하면 방금 만든
	// `&lt;` 등의 `&`까지 다시 `&amp;lt;`로 이중 인코딩된다. 툴팁은 엘리먼트 내용 문맥이라
	// `<`·`>`·`&`만으로 무해화에 충분하지만, 라이브러리가 값을 속성 안에 넣도록 바뀌어도
	// 안전하도록 따옴표(`"`·`'`)까지 함께 막는다.
	private static escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
}
