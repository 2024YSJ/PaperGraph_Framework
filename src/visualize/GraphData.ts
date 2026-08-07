import { Paper } from '../collect/Paper';

// 그래프 노드 한 개 = 논문 한 편. 좌표는 fx/fy/fz로 고정한다(3d-force-graph의 force
// 시뮬레이션이 위치를 흔들지 않도록) — x,y는 PCA 투영을 펼친 값, z는 발행 날짜.
export interface GraphNode {
	id: string; // sourceId
	fx: number; // 고정 x (PCA 제1주성분을 펼친 값)
	fy: number; // 고정 y (PCA 제2주성분을 펼친 값)
	fz: number; // 고정 z (publicationDate를 정규화한 시간축)
	paper: Paper; // 크기(인용수)·색·라벨 계산용 원본
	// 렌더 표시 속성 — render/미들웨어가 채운다.
	size?: number;
	color?: string;
	label?: string;
}

// 그래프 엣지 한 개. source/target은 노드 id(sourceId). init은 링크를 만들지 않지만
// (노드만), 미들웨어가 인용 관계 등 엣지를 여기 추가할 수 있게 자리를 마련해 둔다.
export interface GraphLink {
	source: string;
	target: string;
}

// render 시 적용할 뷰 옵션. 뷰/미들웨어가 설정하고 render가 3d-force-graph/컨테이너에
// 반영한다. (미들웨어는 씬이 생기기 전에 돌므로 직접 못 만지고, 여기 의도만 남긴다.)
export interface GraphViewOptions {
	fullscreen: boolean; // 전체 화면으로 띄울지
}

// 노드 이벤트 핸들러 모음. 미들웨어가 배열에 push해서 hover/click 등에 여러 반응을 붙일
// 수 있고, render가 3d-force-graph의 실제 이벤트(onNodeHover/onNodeClick 등)에 연결한다.
// 여러 미들웨어가 각자 핸들러를 더할 수 있도록 단일 콜백이 아니라 배열로 둔다.
export interface GraphEvents {
	nodeHover: ((node: GraphNode | null) => void)[]; // 노드에 올림 / 벗어나면 null
	nodeClick: ((node: GraphNode) => void)[]; // 노드 클릭
}

// 시각화에 쓰는 그래프 관련 데이터/객체의 전달 매개체 (docs/devLog/007.md).
// 하나의 인스턴스가 흐름 전체를 관통한다: init이 채우고 → 미들웨어가 변형하고 →
// render가 읽어 graph.container에 그린다. (VisualizationFlow.run이 이 흐름을 제어)
export class GraphData {
	// 그래프를 그릴 DOM 컨테이너. VisualizationView가 만들어 세팅하고, render가 사용한다.
	container?: HTMLElement;

	// 논문 노드들. init이 채운다.
	nodes: GraphNode[] = [];

	// 엣지들. init은 비워 두고(노드만 — 007.md), 미들웨어가 인용 관계 등을 추가할 수 있다.
	links: GraphLink[] = [];

	// z축(시간축) 눈금/축 가이드를 그릴 때 쓰는 날짜 timestamp 범위(ms).
	timeRange?: { min: number; max: number };

	// 전체 화면 등 렌더 옵션. 뷰/미들웨어가 설정하고 render가 반영한다.
	options: GraphViewOptions = { fullscreen: false };

	// hover/click 등 이벤트 핸들러. 미들웨어가 push하고 render가 3d-force-graph에 연결한다.
	events: GraphEvents = { nodeHover: [], nodeClick: [] };
}
