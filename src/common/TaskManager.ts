import { Task } from './Task';

export class TaskManager {
	tasks: Task[] = [];

	// 등록 계열: init() 시점에 호출되므로 반드시 안전하게 동작해야 한다.
	setTask(task: Task): void {
		this.tasks.push(task);
	}

	// taskName에 등록된 func를 찾아 그대로 호출한다. func가 Promise를 반환하면 그 결과를
	// 기다렸다가 돌려준다 — 동기 함수를 반환해도(EventListener.checking을 fire-and-forget
	// 없이 await하는 호출부 입장에서) 항상 Promise 하나로 취급할 수 있다.
	async runTask(taskName: string, ...args: unknown[]): Promise<unknown> {
		const task = this.tasks.find((t) => t.taskName === taskName);
		if (!task) {
			throw new Error(`등록되지 않은 작업입니다: ${taskName}`);
		}
		return await task.func(...args);
	}
}
