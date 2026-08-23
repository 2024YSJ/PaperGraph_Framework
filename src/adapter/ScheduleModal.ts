import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { DEFAULT_SCHEDULE_SETTINGS, ScheduleSettings } from '../common/ScheduleSettings';

// 자동 수집(스케줄러) 설정 전용 창. 원래 설정 탭 안에 있었는데, API/구독 관리와 같은
// 이유로 분리했다 — 리본 아이콘에서 설정 탭을 거치지 않고 바로 켜고/끄고/시각을 바꿀 수
// 있어야 한다는 요청. 설정 탭에는 이 창을 여는 진입점 버튼만 남는다(ApiManagementModal과
// 같은 패턴).
//
// Schedule.json과 실시간 동기화된다: 열 때 읽어와 복원하고, 토글/시각 변경 즉시 저장한다.
export class ScheduleModal extends Modal {
	// Schedule.json은 비동기로만 읽을 수 있는데 onOpen()은 동기다 — 로드 전까지는
	// 기본값을 보여주고, 로드가 끝나면 다시 그린다(ApiManagementModal.loadSubscriptions와
	// 같은 패턴).
	private scheduleSettings: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS };
	private scheduleSettingsLoaded = false;
	private reloadingScheduleSettings = false;

	constructor(app: App, private readonly plugin: PaperGraph3D) {
		super(app);
	}

	onOpen(): void {
		this.render();
		if (!this.scheduleSettingsLoaded) {
			void this.loadScheduleSettings();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// Schedule.json -> scheduleSettings. 창을 열 때마다 다시 읽는다 — 스케줄러가
	// 백그라운드에서 lastRunAt을 계속 갱신하므로, 창을 오래 띄워두거나 다시 열었을 때
	// 그 값을 놓치면 안 된다. reloading 플래그로 재귀만 막는다.
	private async loadScheduleSettings(): Promise<void> {
		if (this.reloadingScheduleSettings) {
			return;
		}
		this.reloadingScheduleSettings = true;
		try {
			this.scheduleSettings = await File.readScheduleSettings();
		} catch (e) {
			new Notice(`자동 수집 설정을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.scheduleSettingsLoaded = true;
		this.reloadingScheduleSettings = false;
		this.render();
	}

	// scheduleSettings의 일부 필드만 바꿔 즉시 저장한다 — 별도 「저장」 버튼 없이 다른
	// 토글/입력값과 같은 방식(바꾸면 바로 반영)으로 통일했다.
	//
	// 저장 직전에 디스크를 다시 읽어 그 위에 patch만 얹는다 — this.scheduleSettings(화면에
	// 캐시된 스냅샷)를 그대로 베이스로 쓰면, 그 사이 Scheduler.runNow()가 갱신해둔
	// lastRunAt을 옛 값으로 덮어써버린다 — File.mutateSubscriptions와 같은 이유의
	// read-modify-write다.
	private async updateScheduleSettings(patch: Partial<ScheduleSettings>): Promise<void> {
		try {
			const current = await File.readScheduleSettings();
			this.scheduleSettings = { ...current, ...patch };
			await File.writeScheduleSettings(this.scheduleSettings);
		} catch (e) {
			new Notice(`자동 수집 설정 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		// 실제 스케줄링(다음 목표 시각까지 남은 시간 계산 -> 정확히 그 시점에 1회 실행)은
		// Scheduler가 한다(main.ts.onload의 scheduler.start() 참고) — 여기는 그 설정을
		// 편집하는 화면일 뿐이고, 값을 바꾸면 즉시 저장돼 다음 재예약부터 반영된다
		// (Scheduler.scheduleNext가 매번 Schedule.json을 다시 읽으므로 재시작 불필요).
		new Setting(contentEl)
			.setName('자동 수집')
			.setDesc('매일 지정한 시각에 백그라운드에서 "최근 논문 수집"을 자동으로 실행합니다.')
			.setHeading();

		new Setting(contentEl)
			.setName('자동 수집 사용')
			.addToggle((toggle) =>
				toggle.setValue(this.scheduleSettings.enabled).onChange((value) => {
					void this.updateScheduleSettings({ enabled: value }).then(() => {
						if (value) {
							// 켜는 순간 목표 시각을 기다리지 않고 즉시 1회 실행 — 그 뒤 다음
							// 목표 시각을 이 실행 시점 기준으로 다시 예약한다(Scheduler.enableNow).
							void this.plugin.scheduler.enableNow();
						} else {
							// 꺼지면 예약된 타이머를 즉시 취소한다 — 안 그러면 꺼진 채로도
							// 마지막으로 걸려 있던 타이머가 그대로 울린다.
							this.plugin.scheduler.stop();
						}
						// 켜져 있는 동안은 목표 시각을 못 바꾸게 잠그므로(아래 필드의
						// setDisabled), on/off가 바뀔 때마다 다시 그려 잠금 상태를 맞춘다.
						this.render();
					});
				}),
			);

		// 켜져 있는 동안 목표 시각을 바꾸면 "지금 예약된 타이머가 이 값 기준인지 새
		// 값 기준인지" 애매해진다 — 껐다 값을 바꾸고 다시 켜도록 강제해 그 모호함을
		// 없앤다(다시 켜면 즉시 1회 실행되므로 확인도 바로 된다).
		const locked = this.scheduleSettings.enabled;
		new Setting(contentEl)
			.setName('실행 시각')
			.setDesc(
				locked
					? '자동 수집을 끄면 실행 시각을 바꿀 수 있습니다.'
					: '매일 이 시각에 자동 수집을 실행합니다. 그 시각에 옵시디언이 꺼져 있었다면 ' +
						'다음에 열었을 때 즉시 캐치업 실행됩니다 — 캐치업은 "지금이 이 시:분을 ' +
						'지났는가"로 판단하므로, 평소 옵시디언을 여는 시:분에 맞춰두면 열 때마다 ' +
						'정확히 한 번 실행됩니다.',
			)
			.addText((text) => {
				// type="time"의 네이티브 값 포맷은 항상 "HH:MM"(24시간제) — 별도 파서 없이
				// 분 단위까지 그대로 오간다.
				text.inputEl.type = 'time';
				text.setDisabled(locked);
				text.setValue(ScheduleModal.formatTime(this.scheduleSettings.targetHour, this.scheduleSettings.targetMinute))
					.onChange((value) => {
						// 입력 중(지우는 중) 빈 값이나 아직 "HH:MM"을 다 못 채운 값은 무시한다 —
						// time input은 완성되기 전까지 빈 문자열을 낸다.
						const match = /^(\d{2}):(\d{2})$/.exec(value);
						if (!match) {
							return;
						}
						const hour = Number(match[1]);
						const minute = Number(match[2]);
						if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
							return;
						}
						void this.updateScheduleSettings({ targetHour: hour, targetMinute: minute });
					});
			});
	}

	private static formatTime(hour: number, minute: number): string {
		return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	}
}
