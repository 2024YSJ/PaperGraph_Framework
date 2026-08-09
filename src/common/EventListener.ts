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

	// 등록 계열: TaskManager 연결. 다이어그램엔 연결선이 없어 별도 등록 함수로 뒀다
	// (checking()이 runTask()를 부르려면 참조가 필요하다). init()에서 한 번 호출한다.
	setTaskManager(taskManager: TaskManager): void {
		this.taskManager = taskManager;
	}

	// 실행 계열: eventName에 매칭되는 모든 항목을 찾아(filter — 001의 "미들웨어/태스크를
	// 얹어 확장" 방향과 맞추기 위해 find가 아니라 팬아웃) 순서대로 TaskManager.runTask()를
	// 호출한다. 순차 실행은 프로젝트 전반의 관례(API 호출·embed() 등)와 맞춘 것 — task가
	// 공유 상태(예: collectflow)를 건드릴 수 있어 병렬 실행은 레이스를 만들 수 있다.
	// 매칭되는 이벤트가 없으면 throw(TaskManager.runTask의 미등록 taskName과 같은 규칙).
	async checking(eventName: string, ...args: unknown[]): Promise<unknown[]> {
		if (!this.taskManager) {
			throw new Error('EventListener.checking() called before setTaskManager()');
		}
		const matches = this.events.filter((e) => e.eventName === eventName);
		if (matches.length === 0) {
			throw new Error(`No task registered for event: ${eventName}`);
		}
		const results: unknown[] = [];
		for (const match of matches) {
			results.push(await this.taskManager.runTask(match.taskName, ...args));
		}
		return results;
	}
}
