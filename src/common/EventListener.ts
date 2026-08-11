import { TaskManager } from './TaskManager';

export interface PaperGraph3DEvent {
	eventName: string;
	taskName: string;
}

export class EventListener {
	events: PaperGraph3DEvent[] = [];
	// checking()이 실제로 작업을 실행하려면 TaskManager가 있어야 하는데, 이벤트 등록과
	// TaskManager 생성이 둘 다 main.ts.init()에서 동시에 새로 만들어져 생성자로는 받을 수
	// 없다 — bindTaskManager로 그 직후 한 번만 연결한다.
	private taskManager: TaskManager | undefined;

	// 등록 계열: init() 시점에 호출되므로 반드시 안전하게 동작해야 한다.
	setEventListener(eventName: string, taskName: string): void {
		this.events.push({ eventName, taskName });
	}

	bindTaskManager(taskManager: TaskManager): void {
		this.taskManager = taskManager;
	}

	// eventName에 매칭되는 taskName을 찾아 TaskManager.runTask()를 호출한다.
	async checking(eventName: string, ...args: unknown[]): Promise<unknown> {
		const event = this.events.find((e) => e.eventName === eventName);
		if (!event) {
			throw new Error(`등록되지 않은 이벤트입니다: ${eventName}`);
		}
		if (!this.taskManager) {
			throw new Error('TaskManager가 아직 연결되지 않았습니다.');
		}
		return await this.taskManager.runTask(event.taskName, ...args);
	}
}
