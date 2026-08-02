// 미들웨어의 실행 시점 구분: 'all'은 전체 수집 결과에 한 번, 'forEach'는 논문 한 편마다,
// 'visual'은 시각화 흐름에서 실행된다. run()에 주어지는 인자는 type에 따라 달라진다
// (다이어그램 명시) — 구체적인 context 타입은 사용처(CollectAndSave/VisualizationFlow)에서 채운다.
export type MiddlewareType = 'all' | 'forEach' | 'visual';

export interface Middleware {
	type: MiddlewareType;
	run(context: unknown): void | Promise<void>;
}
