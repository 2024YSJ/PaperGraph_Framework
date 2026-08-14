import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { Log } from '../common/Log';
import { ApiManagementModal } from './ApiManagementModal';
import { ScheduleModal } from './ScheduleModal';
import { formatSubscriptionProgress } from './CollectMiddlewares';

export class SettingTab extends PluginSettingTab {
	plugin: PaperGraph3D;

	// 큐 상태를 보여주는 자리. display()가 다시 그릴 때마다 새로 만들어지므로, 갱신은
	// 항상 이 참조를 통해서 한다(없으면 아무 일도 안 함).
	private queueStatusEl: HTMLElement | undefined;
	private queueSubscribed = false;

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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// empty()로 방금 버린 DOM을 계속 가리키고 있으면 갱신이 허공에 그려진다.
		this.queueStatusEl = undefined;

		this.ensureQueueSubscription();

		// ── 수집 ──────────────────────────────────────────────────────
		// 실행 로직(최근/과거 논문 수집 선택 메뉴, 진행률 Notice, 진단 미들웨어)은
		// CollectController가 갖고 있다 — 리본 아이콘에서도 같은 진행률을 봐야 하므로
		// 설정 탭 하나에 묶어둘 수 없다(main.ts init 참고).
		new Setting(containerEl)
			.setName('수집')
			.setDesc(
				'구독에 등록된 조건으로 수집을 실행하고 결과를 저장합니다. ' +
					'최근 논문은 마지막 수집 지점부터 이어서, 과거 논문 수집은 지정한 과거 구간을 수집합니다. ' +
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

		// citationsKnown이 이미 true인 논문은 수집 경로가 다시 조회하지 않는다(재시도 정책상
		// 필요 없어서). 이 버튼은 그 스킵 규칙을 무시하고 저장된 전체 코퍼스의 인용수·제목·
		// 초록을 강제로 다시 조회한다(지원하는 출처만, 출처 중립 — API.RefreshContent 참고).
		// 내용이 실제로 달라진 논문만 임베딩도 함께 다시 계산한다.
		new Setting(containerEl)
			.setName('새로고침')
			.setDesc(
				'저장된 모든 논문의 인용수·제목·초록을 다시 조회하고, 내용이 바뀐 논문만 임베딩을 다시 계산합니다.',
			)
			.addButton((button) =>
				button.setButtonText('새로고침').onClick(async () => {
					try {
						await this.plugin.eventListener.checking('ui:collect-refresh');
					} catch (e) {
						new Notice(`새로고침 실패: ${e instanceof Error ? e.message : String(e)}`);
					}
				}),
			);

		// 큐 상태. 수집 버튼을 잠그는 대신 "지금 무엇이 돌고 무엇이 줄 서 있는지"를 보여준다.
		new Setting(containerEl).setName('대기열').then((setting) => {
			this.queueStatusEl = setting.descEl;
			this.renderQueueStatus();
		});

		// ── 자동 수집 (6번) ──────────────────────────────────────────
		// 실제 스케줄링 설정 UI는 API/구독 관리와 같은 이유로 별도 창(ScheduleModal)으로
		// 뺐다 — 리본 아이콘에서 설정 탭을 거치지 않고 바로 켜고/끄고/시각을 바꿀 수
		// 있어야 한다는 요청. 여기는 그 창을 여는 진입점만 남긴다.
		new Setting(containerEl)
			.setName('자동 수집')
			.setDesc('매일 지정한 시각에 백그라운드에서 "최근 논문 수집"을 자동으로 실행합니다.')
			.setHeading();

		new Setting(containerEl)
			.setName('관리')
			.addButton((button) =>
				button
					.setButtonText('열기')
					.setCta()
					.onClick(() => {
						new ScheduleModal(this.app, this.plugin).open();
					}),
			);

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
						new ApiManagementModal(this.app, this.plugin).open();
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
