import { EventListener } from './EventListener';
import { File } from './File';
import { Log } from './Log';
import { FailureNotifier } from './Notify';

// 자동(백그라운드) 수집 스케줄러 — 설정된 주기·시간대에 맞춰 최근 논문 수집을 건다.
//
// 실제 수집은 여기서 직접 하지 않는다 — EventListener.checking()으로 이벤트만 흘려
// 보내고, EventListener -> TaskManager -> CollectAndSave.run()으로 이어지는 기존 경로를
// 그대로 탄다(main.ts.init 참고). 스케줄러가 CollectAndSave를 직접 알 필요가 없게 해
// "무엇을 실행할지"와 "언제 실행할지"를 분리한다.
//
// 타이머 자체(setInterval 등록/해제)는 main.ts가 Plugin.registerInterval로 갖고 있다 —
// 이 클래스는 "지금이 실행할 때인가"만 판단하는 tick() 하나만 제공한다.
export class Scheduler {
	constructor(private readonly eventListener: EventListener) {}

	// 자동 수집은 원래 실패해도 조용히 로그만 남기도록 설계돼 있었다 — "Scheduler는
	// Obsidian UI를 몰라야 한다"보다는, 5분마다 도는 tick마다 Notice가 뜨면 스팸이 되기
	// 때문이었다. 문제는 그 판단이 "전혀 안 띄운다"로 굳어져서, 모델이 삭제됐다거나
	// arXiv가 쿼리를 계속 거부하는 것처럼 며칠씩 이어지는 실패를 사용자가 알 방법이
	// 전혀 없었다. FailureNotifier로 "이유가 바뀔 때만" 알리면 스팸 없이 이 공백을
	// 메울 수 있다.
	private readonly failureNotifier = new FailureNotifier();

	async tick(): Promise<void> {
		const settings = await File.readScheduleSettings();
		if (!settings.enabled) {
			// debug 레벨 — 5분마다 찍히면 "꺼져 있다"는 뻔한 사실로 로그가 도배된다.
			// 콘솔에서 debug까지 보이게 필터를 풀면 그래도 확인할 수 있다(Log.ts 참고).
			Log.debug('scheduler', '자동 수집 꺼짐 — 건너뜀');
			return;
		}
		const now = Date.now();
		const dueAt = settings.lastRunAt + settings.intervalHours * 60 * 60 * 1000;
		if (now < dueAt) {
			Log.debug('scheduler', '아직 주기가 안 지남 — 건너뜀', {
				lastRunAt: new Date(settings.lastRunAt).toISOString(),
				nextRunAt: new Date(dueAt).toISOString(),
			});
			return;
		}
		if (!Scheduler.withinWindow(new Date(now), settings.windowStartHour, settings.windowEndHour)) {
			Log.info('scheduler', '허용 시간대 밖 — 건너뜀', {
				nowHour: new Date(now).getHours(),
				window: [settings.windowStartHour, settings.windowEndHour],
			});
			return;
		}
		// 실행하기 전에 먼저 시각을 찍어 저장한다 — 수집 자체는 몇 분씩 걸릴 수 있는데,
		// lastRunAt을 실행 후에 갱신하면 그 사이의 다음 tick이 여전히 "기한이 지났다"고
		// 판단해 같은 실행을 중복으로 또 큐에 넣는다.
		await File.writeScheduleSettings({ ...settings, lastRunAt: now });
		Log.info('scheduler', '자동 수집 시작', {
			intervalHours: settings.intervalHours,
			window: [settings.windowStartHour, settings.windowEndHour],
		});
		try {
			await this.eventListener.checking('scheduler:collect-recent');
			this.failureNotifier.notifySuccess();
		} catch (error) {
			Log.error('scheduler', '자동 수집 실패', error);
			this.notifyFailure(error);
		}
	}

	// 설정 탭에서 자동 수집을 막 켜는 순간 즉시 1회 실행한다 — tick()과 달리 주기·시간대
	// 조건을 보지 않는다("켜면 바로 확인해보고 싶다"는 요청). lastRunAt은 그래도 지금
	// 시각으로 찍어둔다 — 그래야 다음 tick부터는 이 실행 시점을 기준으로 정상적인
	// 주기(intervalHours)가 적용된다("그 후로는 주기별로").
	async runNow(): Promise<void> {
		const settings = await File.readScheduleSettings();
		await File.writeScheduleSettings({ ...settings, lastRunAt: Date.now() });
		Log.info('scheduler', '자동 수집 시작 (켜는 즉시 1회)');
		try {
			await this.eventListener.checking('scheduler:collect-recent');
			this.failureNotifier.notifySuccess();
		} catch (error) {
			Log.error('scheduler', '자동 수집 실패', error);
			this.notifyFailure(error);
		}
	}

	// FailureNotifier에 넘길 reason은 에러 메시지 그대로 쓴다 — CollectAndSave가 이미
	// 사람이 읽을 수 있는 메시지(모델 미설치, 구독 없음, 전 구독 실패 등)로 throw하므로
	// 별도 분류 없이 메시지 동일 여부로 "같은 이유"를 판단해도 충분하다.
	private notifyFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.failureNotifier.notifyFailure(
			reason,
			(r) => `PaperGraph3D: 자동 수집이 실패하고 있습니다 — ${r}`,
		);
	}

	// start===end면 "시간대 제한 없음"으로 취급한다(ScheduleSettings.ts 참고). start가
	// end보다 크면 자정을 넘는 구간(예: 22시~6시)이다.
	private static withinWindow(date: Date, startHour: number, endHour: number): boolean {
		if (startHour === endHour) {
			return true;
		}
		const hour = date.getHours();
		if (startHour < endHour) {
			return hour >= startHour && hour < endHour;
		}
		return hour >= startHour || hour < endHour;
	}
}
