import { EventListener } from './EventListener';
import { File } from './File';
import { Log } from './Log';

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
		} catch (error) {
			Log.error('scheduler', '자동 수집 실패', error);
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
		} catch (error) {
			Log.error('scheduler', '자동 수집 실패', error);
		}
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
