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

	// eventName에 매칭되는 모든 항목을 찾아(find가 아니라 filter — 한 이벤트에 여러 task를
	// 얹는 팬아웃을 지원한다. devLog 009 참고) 순서대로(병렬 아님) TaskManager.runTask()를
	// 호출한다. Task가 collectflow처럼 공유 상태를 다룰 수 있어 병렬 실행은 레이스를 만들 수
	// 있으므로 순차 실행을 택했다.
	async checking(eventName: string, ...args: unknown[]): Promise<unknown[]> {
		const matches = this.events.filter((e) => e.eventName === eventName);
		if (matches.length === 0) {
			throw new Error(`등록되지 않은 이벤트입니다: ${eventName}`);
		}
		if (!this.taskManager) {
			throw new Error('TaskManager가 아직 연결되지 않았습니다.');
		}
		const results: unknown[] = [];
		for (const match of matches) {
			results.push(await this.taskManager.runTask(match.taskName, ...args));
		}
		return results;
	}
}
