import { GraphData } from './GraphData';

export class Visualization {
	graph!: GraphData;

	// 실행 계열: 아직 미구현. 시각화 초반 작업 (다이어그램 명시).
	init(): void {
		throw new Error('Not implemented: Visualization.init');
	}

	// 실행 계열: 아직 미구현. 최종적으로 그래프를 그리는 함수 (다이어그램 명시).
	render(): void {
		throw new Error('Not implemented: Visualization.render');
	}
}
