// interface로 둔다 — Middleware(src/common/Middleware.ts)와 같은 확장 패턴. 개발자가
// 객체 리터럴이 아니라 `class MyTask implements Task { ... }`로 구현해 taskName/func
// 외에 자기만의 필드·메서드를 추가로 들고 있는 Task를 만들 수 있다.
export interface Task {
	taskName: string;
	func: (...args: unknown[]) => unknown;
}
