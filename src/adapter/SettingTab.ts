import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { DEFAULT_SCHEDULE_SETTINGS, ScheduleSettings } from '../collect/ScheduleSettings';
import { ApiManagementModal } from './ApiManagementModal';
import { formatSubscriptionProgress } from './CollectMiddlewares';

export class SettingTab extends PluginSettingTab {
	plugin: PaperGraph3D;

	// 큐 상태를 보여주는 자리. display()가 다시 그릴 때마다 새로 만들어지므로, 갱신은
	// 항상 이 참조를 통해서 한다(없으면 아무 일도 안 함).
	private queueStatusEl: HTMLElement | undefined;
	private queueSubscribed = false;

	// Schedule.json은 비동기로만 읽을 수 있는데 display()는 동기다 — 로드 전까지는
	// 기본값을 보여주고, 로드가 끝나면 다시 그린다(ApiManagementModal.loadSubscriptions와
	// 같은 패턴).
	private scheduleSettings: ScheduleSettings = { ...DEFAULT_SCHEDULE_SETTINGS };
	private scheduleSettingsLoaded = false;

	constructor(app: App, plugin: PaperGraph3D) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// 큐 상태 구독은 플러그인 수명 동안 한 번만 — display()마다 붙이면 리스너가 쌓인다.
	// 리스너는 queueStatusEl이 있을 때만 그리므로, 설정 탭이 닫혀 있어도 안전하다.
	private ensureQueueSubscription(): void {
		if (this.queueSubscribed) {
			return;
		}
		this.queueSubscribed = true;
		this.plugin.collectflow.onQueueChange(() => this.renderQueueStatus());
		// 큐 멤버십(시작/대기/종료) 변화와 별개로, "지금 도는 API의 진행 상황"은 더 잦게
		// 바뀐다(청크·논문 단위) — CollectController가 그 신호를 따로 준다.
		this.plugin.collectController.onProgressChange(() => this.renderQueueStatus());
	}

	// 지금 무엇이 돌고 어떤 게 줄 서 있는지. display()가 다시 그린 직후에도 반드시 한 번
	// 불러야 한다 — 안 그러면 재렌더된 화면이 실제 상태와 어긋난 채로 남는다.
	private renderQueueStatus(): void {
		const el = this.queueStatusEl;
		if (!el) {
			return;
		}
		const { active, waiting } = this.plugin.collectflow.queueState;
		el.empty();
		if (!active) {
			el.createSpan({ text: '대기 중인 수집 작업 없음' });
			return;
		}
		// 대기 중인 작업은 label 자체가 이미 자연어다(예: "arXiv 딥러닝 논문 수집") —
		// CollectController가 고른 구독으로 라벨을 만들어 큐에 넣으므로 여기서는 그대로
		// 이어붙이기만 한다(5번: 시스템 ID 대신 사람이 읽을 문구). 어순은 동사가 끝에
		// 오도록 "○○ 실행 중"/"○○ 대기 중"으로 통일한다.
		el.createDiv({
			text:
				waiting.length === 0
					? `${active.label} 실행 중`
					: `${active.label} 실행 중 — ${waiting.map((job) => job.label).join(', ')} 대기 중`,
		});

		// 지금까지 시작된 구독마다 한 줄씩 — 보정처럼 구독 개념이 없는 작업이거나 아직
		// 첫 구독도 시작 안 한 시점에는 빈 배열이라 아무것도 안 그린다. 문구 조립은
		// CollectController의 Notice와 같은 포맷터(formatSubscriptionProgress)를 써서
		// 두 표시가 갈라지지 않게 한다.
		for (const sub of this.plugin.collectController.activeSubscriptions) {
			el.createDiv({ text: formatSubscriptionProgress(sub) });
		}
	}

	// Schedule.json -> scheduleSettings. display()가 열릴 때마다 다시 읽는다 — 스케줄러가
	// 백그라운드에서 lastRunAt을 계속 갱신하므로(Scheduler.tick 참고), 설정 탭을 오래 띄워
	// 두거나 다시 열었을 때 그 값을 놓치면 안 된다. reloading 플래그로 재귀만 막는다 —
	// loadScheduleSettings 끝의 this.display()가 다시 이 메서드를 부르는 걸 방지한다.
	private reloadingScheduleSettings = false;

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
		this.display();
	}

	// scheduleSettings의 일부 필드만 바꿔 즉시 저장한다 — 별도 「저장」 버튼 없이 다른
	// 토글/입력값과 같은 방식(바꾸면 바로 반영)으로 통일했다.
	//
	// 저장 직전에 디스크를 다시 읽어 그 위에 patch만 얹는다 — this.scheduleSettings(화면에
	// 캐시된 스냅샷)를 그대로 베이스로 쓰면, 그 사이 Scheduler.tick()이 갱신해둔 lastRunAt을
	// 옛 값으로 덮어써버린다(자동 수집을 켜자마자 이 화면을 그대로 열어두고 다른 필드를
	// 바꾸면 재현된다) — File.mutateSubscriptions와 같은 이유의 read-modify-write다.
	private async updateScheduleSettings(patch: Partial<ScheduleSettings>): Promise<void> {
		try {
			const current = await File.readScheduleSettings();
			this.scheduleSettings = { ...current, ...patch };
			await File.writeScheduleSettings(this.scheduleSettings);
		} catch (e) {
			new Notice(`자동 수집 설정 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 탭을 닫을 때 로드 플래그를 내려서, 다음에 다시 열면(display()) Schedule.json을
	// 새로 읽는다 — 탭이 닫혀 있는 동안에도 Scheduler.tick()이 계속 lastRunAt을 갱신하므로,
	// 켜져 있던 스냅샷을 그대로 재사용하면 오래될수록 어긋난다.
	hide(): void {
		this.scheduleSettingsLoaded = false;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// empty()로 방금 버린 DOM을 계속 가리키고 있으면 갱신이 허공에 그려진다.
		this.queueStatusEl = undefined;

		this.ensureQueueSubscription();

		if (!this.scheduleSettingsLoaded) {
			void this.loadScheduleSettings();
		}

		// ── 수집 ──────────────────────────────────────────────────────
		// 실행 로직(최근/Backfill 선택 메뉴, 진행률 Notice, 진단 미들웨어)은
		// CollectController가 갖고 있다 — 리본 아이콘에서도 같은 진행률을 봐야 하므로
		// 설정 탭 하나에 묶어둘 수 없다(main.ts init 참고).
		new Setting(containerEl)
			.setName('수집')
			.setDesc(
				'구독에 등록된 조건으로 수집을 실행하고 결과를 저장합니다. ' +
					'최근 논문은 마지막 수집 지점부터 이어서, Backfill은 지정한 과거 구간을 수집합니다. ' +
					'임베딩·인용수 조회에 실패한 논문은 수집 직후 자동으로 재시도되므로 별도 버튼이 없습니다.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('실행')
			.addButton((button) =>
				button
					.setButtonText('수집')
					.setCta()
					.onClick((evt) => {
						this.plugin.collectController.openCollectMenu(evt, this.app);
					}),
			);

		// 큐 상태. 수집 버튼을 잠그는 대신 "지금 무엇이 돌고 무엇이 줄 서 있는지"를 보여준다.
		new Setting(containerEl).setName('대기열').then((setting) => {
			this.queueStatusEl = setting.descEl;
			this.renderQueueStatus();
		});

		// ── 자동 수집 (6번) ──────────────────────────────────────────
		// 실제 스케줄링(주기·시간대 판단)은 Scheduler.tick()이 5분마다 Schedule.json을
		// 다시 읽어 수행한다(main.ts.onload 참고) — 여기는 그 설정을 편집하는 화면일
		// 뿐이고, 값을 바꾸면 즉시 저장돼 다음 tick부터 반영된다(재시작 불필요).
		new Setting(containerEl)
			.setName('자동 수집')
			.setDesc(
				'설정한 주기마다 백그라운드에서 "최근 논문 수집"을 자동으로 실행합니다. ' +
					'시간대를 지정하면 그 구간에만 실행됩니다(예: 잠든 새벽 시간을 피하고 싶을 때).',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('자동 수집 사용')
			.addToggle((toggle) =>
				toggle.setValue(this.scheduleSettings.enabled).onChange((value) => {
					void this.updateScheduleSettings({ enabled: value }).then(() => {
						if (value) {
							// 켜는 순간 주기·시간대를 기다리지 않고 즉시 1회 실행 — 그 이후부터
							// 이 실행 시점을 기준으로 정상 주기가 적용된다(Scheduler.runNow 참고).
							void this.plugin.scheduler.runNow();
						}
						// 켜져 있는 동안은 주기·시간대를 못 바꾸게 잠그므로(아래 필드들의
						// setDisabled), on/off가 바뀔 때마다 다시 그려 잠금 상태를 맞춘다.
						this.display();
					});
				}),
			);

		// 켜져 있는 동안 주기·시간대를 바꾸면 "지금 도는 스케줄이 이 값 기준인지 새
		// 값 기준인지" 애매해진다 — 껐다 값을 바꾸고 다시 켜도록 강제해 그 모호함을
		// 없앤다(다시 켜면 즉시 1회 실행되므로 확인도 바로 된다).
		const locked = this.scheduleSettings.enabled;
		new Setting(containerEl)
			.setName('주기 (시간)')
			.setDesc(
				locked
					? '자동 수집을 끄면 주기를 바꿀 수 있습니다.'
					: '마지막 자동 수집 이후 이만큼 시간이 지나면 다시 실행합니다.',
			)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setDisabled(locked);
				text
					.setValue(String(this.scheduleSettings.intervalHours))
					.onChange((value) => {
						const hours = Number(value);
						if (!Number.isFinite(hours) || hours <= 0) {
							return;
						}
						void this.updateScheduleSettings({ intervalHours: hours });
					});
			});

		new Setting(containerEl)
			.setName('허용 시간대 (0~23시)')
			.setDesc(
				locked
					? '자동 수집을 끄면 시간대를 바꿀 수 있습니다.'
					: '이 구간에 들어온 tick에서만 자동 수집을 실행합니다. 시작=끝이면 제한 없이 항상 ' +
						'실행됩니다. 시작이 끝보다 크면 자정을 넘는 구간(예: 22시~6시)으로 봅니다.',
			)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '23';
				text.setDisabled(locked);
				text.setValue(String(this.scheduleSettings.windowStartHour)).onChange((value) => {
					// Number('')는 0이라 빈 칸으로 지우면 그대로 통과해 "0시"로 조용히
					// 저장돼버린다 — 아직 입력 중(지우는 중)인 빈 칸은 명시적으로 무시한다.
					if (value.trim().length === 0) {
						return;
					}
					const hour = Number(value);
					if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
						return;
					}
					void this.updateScheduleSettings({ windowStartHour: hour });
				});
			})
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '23';
				text.setDisabled(locked);
				text.setValue(String(this.scheduleSettings.windowEndHour)).onChange((value) => {
					if (value.trim().length === 0) {
						return;
					}
					const hour = Number(value);
					if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
						return;
					}
					void this.updateScheduleSettings({ windowEndHour: hour });
				});
			});

		// ── API / 구독 관리 ──────────────────────────────────────────
		// API 키 등록과 구독(수집 조건) 관리는 별도 창(ApiManagementModal)으로 분리했다 —
		// 구독은 자주 여닫는 작업이라 리본 아이콘/커맨드로도 바로 열 수 있어야 한다는
		// 요청에 따른 것. 여기는 그 창을 여는 진입점만 남긴다.
		new Setting(containerEl)
			.setName('API / 구독 관리')
			.setDesc('API 키 등록과, 수집할 API·조건(구독) 관리를 별도 창에서 진행합니다.')
			.setHeading();

		new Setting(containerEl)
			.setName('관리')
			.addButton((button) =>
				button
					.setButtonText('열기')
					.setCta()
					.onClick(() => {
						new ApiManagementModal(this.app).open();
					}),
			);

		// ── 임베딩 모델 ───────────────────────────────────────────────
		new Setting(containerEl)
			.setName('임베딩 모델')
			.setDesc(
				'specter2(8bit 양자화) 모델을 GitHub Release에서 받아 온디바이스로 씁니다. ' +
					'모델이 설치되어 있지 않으면 임베딩을 실행할 수 없습니다.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('모델 관리')
			.addButton((button) =>
				// 확인과 설치를 한 버튼으로 합쳤다 — 클릭하면 먼저 설치 여부를 확인하고,
				// 이미 설치돼 있으면 알림만, 아니면 바로 설치까지 진행한다. 사용자가 "확인"을
				// 먼저 눌러보고 "설치"를 또 눌러야 하는 두 단계를 없앴다.
				button
					.setButtonText('설치 확인')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							const installed = await this.plugin.collectflow.embedding.isModelInstalled();
							if (installed) {
								new Notice('임베딩 모델이 이미 설치되어 있습니다.');
								return;
							}
							const notice = new Notice('임베딩 모델 설치 중...', 0);
							try {
								await this.plugin.collectflow.embedding.installModel((progress) => {
									notice.setMessage(
										`임베딩 모델 설치 중... (${progress.fileIndex}/${progress.fileCount}) ${progress.fileName}`,
									);
								});
								notice.hide();
								new Notice('임베딩 모델 설치 완료');
							} catch (error) {
								notice.hide();
								new Notice(`임베딩 모델 설치 실패: ${String(error)}`);
							}
						} catch (error) {
							new Notice(`임베딩 모델 확인 실패: ${String(error)}`);
						} finally {
							button.setDisabled(false);
						}
					}),
			);

		// ── 시각화 ────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName('시각화')
			.setDesc('저장된 논문을 3D 그래프로 시각화합니다.')
			.setHeading();

		new Setting(containerEl)
			.setName('그래프')
			.addButton((button) =>
				button.setButtonText('시각화 열기').onClick(() => {
					void this.plugin.activateVisualizationView();
				}),
			);

		// ── 진단 로그 (임시) ──────────────────────────────────────────
		// ⚠️ 삭제 예정 — Log.ts 상단 주석 참고. 콘솔 출력은 이 토글과 무관하게 항상 나가고,
		// 이 토글은 vault의 collect-log.md 파일 기록만 켠다/끈다. 기본은 꺼짐이라(Log.ts
		// 참고) 자동 수집처럼 눈에 안 보이는 백그라운드 동작을 진단할 땐 여기서 켜야 한다.
		new Setting(containerEl).setName('진단 로그 (임시)').setHeading();

		new Setting(containerEl)
			.setName('파일에도 기록')
			.setDesc(
				`끄면 콘솔에만 남습니다(개발자 도구 → 콘솔, "PaperGraph"로 필터, 로그 레벨은 ` +
					`All levels/Verbose). 켜면 ${Log.filePath()}에도 남깁니다.`,
			)
			.addToggle((toggle) =>
				toggle.setValue(Log.isFileEnabled()).onChange((value) => {
					Log.setFileEnabled(value);
				}),
			);
	}
}
