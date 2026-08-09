import { Task } from './Task';

export class TaskManager {
	tasks: Task[] = [];

	// 등록 계열: init() 시점에 호출되므로 반드시 안전하게 동작해야 한다.
	setTask(task: Task): void {
		this.tasks.push(task);
	}

	// 실행 계열: taskName은 등록 시점에 유일한 식별자로 쓰인다(find). 같은 이벤트에
	// 여러 task를 거는 팬아웃은 EventListener.events 쪽 책임이라 여기서는 다루지 않는다.
	// 미등록 taskName은 throw(File.createApi의 미등록 apiName과 같은 규칙). 실행 에러도
	// 삼키지 않고 그대로 전파한다 — 호출자(커맨드/UI)가 실제 실패를 봐야 한다.
	async runTask(taskName: string, ...args: unknown[]): Promise<unknown> {
		const task = this.tasks.find((t) => t.taskName === taskName);
		if (!task) {
			throw new Error(`No task registered with name: ${taskName}`);
		}
		return task.func(...args);
	}
}
