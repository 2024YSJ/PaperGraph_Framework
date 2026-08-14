import { EventListener } from './EventListener';
import { File } from './File';
import { Log } from './Log';
import { FailureNotifier } from './Notify';

// 자동(백그라운드) 수집 스케줄러 — 설정된 시각에 맞춰 최근 논문 수집을 건다.
//
// 실제 수집은 여기서 직접 하지 않는다 — EventListener.checking()으로 이벤트만 흘려
// 보내고, EventListener -> TaskManager -> CollectAndSave.run()으로 이어지는 기존 경로를
// 그대로 탄다(main.ts.init 참고). 스케줄러가 CollectAndSave를 직접 알 필요가 없게 해
// "무엇을 실행할지"와 "언제 실행할지"를 분리한다.
//
// 예전에는 5분마다 깨어나 "지금이 실행할 때인가"를 다시 판단하는 폴링 방식이었다.
// 지금은 "다음 목표 시각까지 남은 시간"을 한 번 계산해 setTimeout을 정확히 한 번만
// 거는 방식이다 — 불필요하게 자주 깨어나지 않고, 목표 시각에 초 단위로 맞는다. 그
// 대가로 "그 정확한 순간에 앱이 꺼져 있었다"는 경우를 스스로는 감지할 수 없는데(타이머
// 자체가 존재하지 않았으므로), 그건 start()가 로드 시점에 "오늘 목표 시각을 이미
// 지났는데 아직 안 돌았는가"를 한 번 확인하는 것으로 보완한다 — recent 수집은 커서
// 기반 재스캔 창이 있어(CollectAndSave.resolveWindow) 밀린 기간이 자동으로 커버된다.
//
// registerTimer: 새로 건 타이머의 id를 main.ts(Plugin)에 되돌려줘 Plugin.registerInterval로
// 등록하게 한다. 이 클래스가 Obsidian을 직접 import하지 않고도(Scheduler는 Obsidian을
// 몰라야 한다는 원칙 유지), 플러그인 언로드 시 Obsidian이 알아서 타이머를 치워주는
// 안전망을 그대로 받는다 — stop()의 수동 clearTimeout만 믿으면, onunload에서 그 호출을
// 빼먹었을 때 언로드 후에도 타이머가 계속 남는 예전 registerInterval 도입 이유가 그대로
// 재현된다.
export class Scheduler {
	constructor(
		private readonly eventListener: EventListener,
		private readonly registerTimer: (id: number) => void,
	) {}

	// 다음 실행을 위해 예약해둔 타이머. stop()/재예약 시 이걸로 이전 타이머를 정리한다.
	private timeoutId: number | undefined;

	// tick()과 같은 이유로 존재한다(구조적 실패를 이유가 바뀔 때만 알림 — 스팸 방지).
	private readonly failureNotifier = new FailureNotifier();

	// main.ts.onload()에서 한 번 호출한다. 꺼져 있으면 아무 타이머도 걸지 않는다.
	async start(): Promise<void> {
		const settings = await File.readScheduleSettings();
		if (!settings.enabled) {
			return;
		}
		if (Scheduler.missedToday(settings)) {
			// 오늘 목표 시각을 이미 지났는데 아직 실행 안 됐다 — 그 시각에 앱이 꺼져
			// 있었다는 뜻이므로 지금 바로 캐치업한다.
			Log.info('scheduler', '캐치업 실행 — 오늘 목표 시각을 지났지만 아직 실행 안 됨');
			await this.runNow();
		}
		this.scheduleNext();
	}

	// 설정 탭에서 자동 수집을 막 켜는 순간 호출한다. missedToday 조건을 보지 않고
	// 무조건 즉시 1회 실행한다("켜면 바로 확인해보고 싶다"는 요청) — 그 뒤
	// scheduleNext()가 이 실행 시점을 기준으로 다음 목표 시각을 다시 계산한다.
	async enableNow(): Promise<void> {
		await this.runNow();
		this.scheduleNext();
	}

	// 설정 탭에서 자동 수집을 끄거나, 플러그인이 언로드될 때 호출한다. 예약된 타이머가
	// 없으면 아무 일도 안 한다.
	stop(): void {
		if (this.timeoutId !== undefined) {
			window.clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
	}

	// "다음 목표 시각까지 남은 시간"을 계산해 그 시점에 한 번 실행되는 타이머를 건다.
	// 타이머가 울리면 실행 후 스스로를 다시 호출해 그 다음 날 것을 재예약한다(재귀) —
	// setInterval처럼 고정 간격으로 반복하지 않고, 매번 "다음 목표 시각"을 새로 계산한다.
	// 설정을 매번 다시 읽으므로, 설정 탭에서 목표 시각을 바꾸면 다음 재예약부터 반영된다.
	private scheduleNext(): void {
		this.stop();
		void (async () => {
			const settings = await File.readScheduleSettings();
			if (!settings.enabled) {
				return;
			}
			const delay = Scheduler.msUntilNextTargetHour(settings.targetHour);
			Log.info('scheduler', '다음 자동 수집 예약', {
				targetHour: settings.targetHour,
				nextRunAt: new Date(Date.now() + delay).toISOString(),
			});
			this.timeoutId = window.setTimeout(() => {
				void this.runNow().finally(() => this.scheduleNext());
			}, delay);
			this.registerTimer(this.timeoutId);
		})();
	}

	// 실제 실행 — lastRunAt을 먼저 찍고(실행 자체가 몇 분 걸릴 수 있으므로, 실행 후에
	// 찍으면 그 사이 판단이 어긋난다) EventListener를 통해 수집을 건다.
	private async runNow(): Promise<void> {
		const settings = await File.readScheduleSettings();
		await File.writeScheduleSettings({ ...settings, lastRunAt: Date.now() });
		Log.info('scheduler', '자동 수집 시작');
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

	// "오늘 목표 시각을 이미 지났는데 아직 오늘 실행한 적이 없는가". 델타(now - lastRunAt
	// >= 24h)로 판단하지 않는다 — 그러면 실행 시각이 매일 조금씩 밀릴 수 있다. 반드시
	// 로컬 날짜(연/월/일)가 같은지로 비교해야 "매일 같은 시각"이 유지된다.
	private static missedToday(settings: { targetHour: number; lastRunAt: number }): boolean {
		const now = new Date();
		if (now.getHours() < settings.targetHour) {
			return false;
		}
		return !Scheduler.isSameLocalDay(new Date(settings.lastRunAt), now);
	}

	private static isSameLocalDay(a: Date, b: Date): boolean {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}

	// 지금부터 "다음 targetHour 정각"까지 남은 ms. 오늘 그 시각을 이미 지났으면 내일
	// 그 시각을 목표로 잡는다.
	private static msUntilNextTargetHour(targetHour: number): number {
		const now = new Date();
		const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, 0, 0, 0);
		if (next.getTime() <= now.getTime()) {
			next.setDate(next.getDate() + 1);
		}
		return next.getTime() - now.getTime();
	}
}
