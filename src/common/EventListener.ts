import { TaskManager } from './TaskManager';

export interface PaperGraph3DEvent {
	eventName: string;
	taskName: string;
}

export class EventListener {
	events: PaperGraph3DEvent[] = [];
	private taskManager?: TaskManager;

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
