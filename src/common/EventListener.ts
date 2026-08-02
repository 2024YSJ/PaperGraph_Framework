export interface PaperGraph3DEvent {
	eventName: string;
	taskName: string;
}

export class EventListener {
	events: PaperGraph3DEvent[] = [];

	// 등록 계열: init() 시점에 호출되므로 반드시 안전하게 동작해야 한다.
	setEventListener(eventName: string, taskName: string): void {
		this.events.push({ eventName, taskName });
	}

	// 실행 계열: 아직 미구현. eventName에 매칭되는 taskName을 찾아
	// TaskManager.runTask()를 호출하는 것이 담당자가 채울 로직이다.
	async checking(eventName: string, ...args: unknown[]): Promise<unknown> {
		throw new Error(`Not implemented: EventListener.checking(${eventName})`);
	}
}
