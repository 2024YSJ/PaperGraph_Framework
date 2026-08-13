import ForceGraph3D from '3d-force-graph';
import { ArrowHelper, CanvasTexture, Scene, Sprite, SpriteMaterial, Vector3 } from 'three';
import { GraphData, GraphNode } from './GraphData';
import type { PCAResult } from './PCA';

// 튜닝 상수 (007.md "남은 잠정" — 실제로 그려보며 조정).
const SPREAD = 120; // x,y 펼치기 배율 (z-score에 곱함)
const MS_PER_DAY = 86_400_000; // 하루(ms)
const Z_PER_DAY = 4; // 하루당 z 거리 — 수집 기간이 길수록 z축이 길어진다(튜닝값)
const AXIS_MARGIN = 40; // z축을 논문 범위보다 양쪽으로 더 길게 뺀 여유
const NODE_COLOR = '#4f9dff'; // 고정 단색
const NODE_REL_SIZE = 4;
const AXIS_COLOR = 0x888888;

// 3D force graph로 논문 임베딩을 시각화한다 (설계: docs/devLog/007.md).
//   - x,y = PCA 투영을 z-score로 펼친 값, z = 발행 날짜(시간축). 좌표는 fx/fy/fz로 고정.
//   - PCA는 여기서 호출하지 않는다. 외부(VisualizationFlow.run)가 계산해 PCAResult를
//     init에 인자로 준다.
//   - 흐름: setContainer(뷰) → init(PCAResult)로 GraphData 생성·반환 → 미들웨어가 변형 →
//     render(GraphData)가 graph.container에 그린다.
export class Visualization {
	graph!: GraphData;

	// 뷰가 그릴 DOM을 미리 등록한다. init이 생성하는 GraphData에 담긴다.
	private container?: HTMLElement;

	// 컨테이너 크기 변화를 추적해 그래프 크기를 맞춘다(스크롤바 방지). 재렌더 시 정리.
	private resizeObserver?: ResizeObserver;

	setContainer(el: HTMLElement): void {
		this.container = el;
	}

	// PCAResult를 받아 GraphData를 생성·반환한다. 데이터만 구성하고 그리지는 않는다.
	init(pca: PCAResult): GraphData {
		const graph = new GraphData();
		graph.container = this.container;

		const points = pca.points;

		// x,y 펼치기용 통계 (표준화 × 배율).
		const xStat = Visualization.meanStd(points.map((p) => p.x));
		const yStat = Visualization.meanStd(points.map((p) => p.y));

		// z(시간축)용 날짜 → timestamp. 날짜 없음/파싱 실패는 null.
		const times = points.map((p) => Visualization.parseTime(p.paper.publicationDate));
		const validTimes = times.filter((t): t is number => t !== null);
		const tMin = validTimes.length > 0 ? Math.min(...validTimes) : 0;
		const tMax = validTimes.length > 0 ? Math.max(...validTimes) : 0;
		graph.timeRange = { min: tMin, max: tMax };

		graph.nodes = points.map((p, i) => {
			const t = times[i] ?? tMin; // 날짜 없으면 최소값(가장 오래된 쪽)에 둔다
			const node: GraphNode = {
				id: p.sourceId,
				fx: ((p.x - xStat.mean) / xStat.std) * SPREAD,
				fy: ((p.y - yStat.mean) / yStat.std) * SPREAD,
				fz: Visualization.timeToZ(t, tMin),
				paper: p.paper,
				size: Visualization.nodeSize(p.paper.citationCount),
				color: NODE_COLOR,
				label: p.paper.title,
			};
			return node;
		});
		// links는 비워 둔다(노드만) — 미들웨어가 엣지를 추가할 수 있다.

		this.graph = graph;
		return graph;
	}

	// 미들웨어까지 거친 GraphData를 graph.container에 실제로 그린다.
	render(graph: GraphData): void {
		const container = graph.container;
		if (!container) {
			throw new Error('Visualization.render: container가 없다 (setContainer 필요)');
		}
		container.replaceChildren(); // 재렌더 대비 초기화
		this.resizeObserver?.disconnect(); // 이전 렌더의 옵저버 정리

		// controlType 'orbit': 좌클릭 드래그=회전, 우클릭 드래그=이동(pan), 휠=줌.
		const forceGraph = new ForceGraph3D(container, { controlType: 'orbit' });
		forceGraph
			.graphData({ nodes: graph.nodes, links: graph.links })
			// 좌표를 fx/fy/fz로 고정하므로 force 시뮬레이션은 불필요 — 0틱으로 꺼서
			// 대량 노드에서 매 프레임 n-body 계산이 도는 것을 막는다(렌더 속도 핵심).
			.cooldownTicks(0)
			.enableNodeDrag(false) // 노드를 잡아 끌지 못하게(좌표 고정 유지)
			.nodeRelSize(NODE_REL_SIZE)
			.nodeVal((n) => (n as GraphNode).size ?? 1)
			.nodeColor((n) => (n as GraphNode).color ?? NODE_COLOR)
			.nodeLabel((n) => (n as GraphNode).label ?? '');

		// 미들웨어가 등록한 렌더 후크 실행 — 링크 화살표/스타일 등 인스턴스 설정을
		// 여기서 적용한다(새 설정을 추가해도 render는 안 고쳐도 된다).
		for (const hook of graph.renderHooks) {
			hook(forceGraph);
		}

		// 그래프 크기를 컨테이너 실제 크기에 맞추고, 리프 크기가 바뀌면 따라간다
		// (3d-force-graph는 창 리사이즈만 감지하므로, 리프/패널 리사이즈까지 잡으려면
		// 직접 지정한다). 스크롤바가 생기지 않도록 하는 핵심.
		const applySize = (): void => {
			forceGraph.width(container.clientWidth).height(container.clientHeight);
		};
		applySize();
		this.resizeObserver = new ResizeObserver(() => {
			applySize();
		});
		this.resizeObserver.observe(container);

		// 이벤트 연결 — 등록된 핸들러 전부 호출.
		forceGraph.onNodeHover((node) => {
			for (const handler of graph.events.nodeHover) {
				handler(node as GraphNode | null);
			}
		});
		forceGraph.onNodeClick((node) => {
			for (const handler of graph.events.nodeClick) {
				handler(node as GraphNode);
			}
		});

		// 카메라와 회전 중심(OrbitControls target)을 논문들의 3D 중앙으로 맞춘다.
		if (graph.nodes.length > 0) {
			const c = Visualization.centroid(graph.nodes);
			let maxDist = 0;
			for (const node of graph.nodes) {
				maxDist = Math.max(maxDist, Math.hypot(node.fx - c.x, node.fy - c.y, node.fz - c.z));
			}
			const distance = (maxDist || 100) * 2.2; // 전체가 보이도록 뒤로 물러난 거리
			forceGraph.cameraPosition({ x: c.x, y: c.y, z: c.z + distance }, c, 0);
			const controls = forceGraph.controls() as { target: Vector3; update(): void };
			controls.target.set(c.x, c.y, c.z);
			controls.update();
		}

		// z축(시간축) 그리기.
		this.drawTimeAxis(forceGraph.scene(), graph);

		// 옵션: 전체 화면 (사용자 제스처 밖이면 브라우저가 거부할 수 있어 무시).
		if (graph.options.fullscreen) {
			void container.requestFullscreen().catch(() => {
				/* 전체 화면 거부 시 무시 */
			});
		}
	}

	// z 방향으로 축을 긋고, 연도 경계마다 라벨 스프라이트를 배치한다. 축은 논문 z 범위
	// (0~Z_LENGTH)보다 양쪽으로 AXIS_MARGIN만큼 더 길고, +z 끝(시간이 커지는 방향)에
	// 화살표를 둔다. ArrowHelper가 선 + 화살촉을 함께 그린다.
	private drawTimeAxis(scene: Scene, graph: GraphData): void {
		if (!graph.timeRange) {
			return;
		}
		const { min, max } = graph.timeRange;

		// 축 길이는 실제 시간 범위에 비례한다(수집 기간이 길수록 길어진다). 양쪽에 여유.
		const zStart = -AXIS_MARGIN;
		const zEnd = Visualization.timeToZ(max, min) + AXIS_MARGIN;
		const arrow = new ArrowHelper(
			new Vector3(0, 0, 1), // +z = 시간 증가 방향
			new Vector3(0, 0, zStart),
			zEnd - zStart,
			AXIS_COLOR,
			18, // 화살촉 길이
			10, // 화살촉 폭
		);
		scene.add(arrow);

		if (max <= min) {
			return;
		}
		const startYear = new Date(min).getFullYear();
		const endYear = new Date(max).getFullYear();
		for (let year = startYear; year <= endYear; year += 1) {
			const t = new Date(year, 0, 1).getTime();
			if (t < min || t > max) {
				continue;
			}
			const sprite = Visualization.makeTextSprite(String(year));
			sprite.position.set(0, 0, Visualization.timeToZ(t, min));
			scene.add(sprite);
		}
	}

	// 발행 timestamp를 z 좌표로 변환한다. 정규화가 아니라 실제 시간에 비례하므로
	// (tMin 기준 상대 시간 × 하루당 거리), 수집 기간이 길수록 z축이 길어진다.
	private static timeToZ(t: number, tMin: number): number {
		return ((t - tMin) / MS_PER_DAY) * Z_PER_DAY;
	}

	// 노드들의 3D 중앙(좌표 평균). 회전 중심·카메라 타겟으로 쓴다.
	private static centroid(nodes: GraphNode[]): { x: number; y: number; z: number } {
		const n = nodes.length || 1;
		let sx = 0;
		let sy = 0;
		let sz = 0;
		for (const node of nodes) {
			sx += node.fx;
			sy += node.fy;
			sz += node.fz;
		}
		return { x: sx / n, y: sy / n, z: sz / n };
	}

	// 평균과 표준편차. 표준편차가 0이면(모두 같은 값) 1로 대체해 0으로 나누지 않는다.
	private static meanStd(values: number[]): { mean: number; std: number } {
		const n = values.length || 1;
		const mean = values.reduce((sum, v) => sum + v, 0) / n;
		const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
		const std = Math.sqrt(variance);
		return { mean, std: std || 1 };
	}

	// ISO 날짜 → timestamp(ms). 파싱 실패 시 null.
	private static parseTime(date: string): number | null {
		const t = Date.parse(date);
		return Number.isNaN(t) ? null : t;
	}

	// 인용수 → 노드 크기. 로그 스케일로 큰 값의 지배를 완화한다.
	private static nodeSize(citationCount: number): number {
		return 1 + Math.log2((citationCount > 0 ? citationCount : 0) + 1);
	}

	// 텍스트를 캔버스에 그려 스프라이트로 만든다(별도 폰트 의존성 없이 3D 라벨).
	private static makeTextSprite(text: string): Sprite {
		const canvas = document.createElement('canvas');
		canvas.width = 128;
		canvas.height = 64;
		const ctx = canvas.getContext('2d');
		if (ctx) {
			ctx.fillStyle = '#cccccc';
			ctx.font = '32px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(text, canvas.width / 2, canvas.height / 2);
		}
		const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), transparent: true }));
		sprite.scale.set(20, 10, 1);
		return sprite;
	}
}
