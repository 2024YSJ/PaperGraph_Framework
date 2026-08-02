import { Task } from './Task';

export class TaskManager {
	tasks: Task[] = [];

	// 등록 계열: init() 시점에 호출되므로 반드시 안전하게 동작해야 한다.
	setTask(task: Task): void {
		this.tasks.push(task);
	}

	// 실행 계열: 아직 미구현. Task.func 호출/에러 처리 등은 담당자가 채운다.
	async runTask(taskName: string, ...args: unknown[]): Promise<unknown> {
		throw new Error(`Not implemented: TaskManager.runTask(${taskName})`);
	}
}
