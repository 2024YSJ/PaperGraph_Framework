// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventListener } from '../src/common/EventListener';
import { TaskManager } from '../src/common/TaskManager';
import { Task } from '../src/common/Task';

// EventListener/TaskManager 둘 다 obsidian을 모르는 순수 TS라 대역 없이 실제 구현을
// 그대로 돌린다(docs/devLog/009-event-listener-task-manager.md 참고).

function makeTask(taskName: string, func: (...args: unknown[]) => unknown): Task {
	return { taskName, func };
}

describe('TaskManager', () => {
	it('등록된 taskName을 찾아 func를 인자와 함께 호출한다', async () => {
		const calls: unknown[][] = [];
		const taskManager = new TaskManager();
		taskManager.setTask(makeTask('echo', (...args) => {
			calls.push(args);
			return args[0];
		}));

		const result = await taskManager.runTask('echo', 'hello');

		assert.equal(result, 'hello');
		assert.deepEqual(calls, [['hello']]);
	});

	it('func가 반환한 Promise를 그대로 기다렸다가 풀어서 돌려준다', async () => {
		const taskManager = new TaskManager();
		taskManager.setTask(makeTask('async-task', async () => {
			await Promise.resolve();
			return 42;
		}));

		assert.equal(await taskManager.runTask('async-task'), 42);
	});

	it('미등록 taskName은 throw한다', async () => {
		const taskManager = new TaskManager();
		await assert.rejects(
			() => taskManager.runTask('missing'),
			/No task registered with name: missing/,
		);
	});

	it('func가 던진 에러를 삼키지 않고 그대로 전파한다', async () => {
		const taskManager = new TaskManager();
		taskManager.setTask(makeTask('boom', () => {
			throw new Error('task failed');
		}));

		await assert.rejects(() => taskManager.runTask('boom'), /task failed/);
	});
});

describe('EventListener', () => {
	it('setTaskManager 이전에 checking()을 부르면 throw한다', async () => {
		const eventListener = new EventListener();
		eventListener.setEventListener('ui:x', 'task:x');

		await assert.rejects(
			() => eventListener.checking('ui:x'),
			/setTaskManager/,
		);
	});

	it('매칭되는 이벤트가 없으면 throw한다', async () => {
		const eventListener = new EventListener();
		eventListener.setTaskManager(new TaskManager());

		await assert.rejects(
			() => eventListener.checking('ui:unknown'),
			/No task registered for event: ui:unknown/,
		);
	});

	it('eventName -> taskName으로 연결된 task를 실행하고 인자를 그대로 전달한다', async () => {
		const taskManager = new TaskManager();
		const calls: unknown[][] = [];
		taskManager.setTask(makeTask('collect:recent', (...args) => {
			calls.push(args);
			return 'ok';
		}));

		const eventListener = new EventListener();
		eventListener.setTaskManager(taskManager);
		eventListener.setEventListener('ui:collect-recent', 'collect:recent');

		const results = await eventListener.checking('ui:collect-recent', 'a', 'b');

		assert.deepEqual(results, ['ok']);
		assert.deepEqual(calls, [['a', 'b']]);
	});

	it('같은 eventName에 여러 task가 걸려 있으면 순서대로 전부 실행한다(팬아웃)', async () => {
		const order: string[] = [];
		const taskManager = new TaskManager();
		taskManager.setTask(makeTask('first', async () => {
			order.push('first-start');
			await Promise.resolve();
			order.push('first-end');
			return 1;
		}));
		taskManager.setTask(makeTask('second', () => {
			order.push('second');
			return 2;
		}));

		const eventListener = new EventListener();
		eventListener.setTaskManager(taskManager);
		eventListener.setEventListener('ui:multi', 'first');
		eventListener.setEventListener('ui:multi', 'second');

		const results = await eventListener.checking('ui:multi');

		assert.deepEqual(results, [1, 2]);
		// 순차 실행 확인: first가 완전히 끝난 뒤에야 second가 시작한다.
		assert.deepEqual(order, ['first-start', 'first-end', 'second']);
	});

	it('이벤트는 매칭되지만 TaskManager에 등록되지 않은 taskName이면 그 에러가 그대로 전파된다', async () => {
		const eventListener = new EventListener();
		eventListener.setTaskManager(new TaskManager());
		eventListener.setEventListener('ui:dangling', 'task:not-registered');

		await assert.rejects(
			() => eventListener.checking('ui:dangling'),
			/No task registered with name: task:not-registered/,
		);
	});
});
