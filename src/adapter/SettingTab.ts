import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { ApiManagementModal } from './ApiManagementModal';

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
		el.createSpan({
			text:
				waiting.length === 0
					? `실행 중: ${active.label}`
					: `실행 중: ${active.label} — 대기 ${waiting.length}건 (${waiting.map((job) => job.label).join(', ')})`,
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// empty()로 방금 버린 DOM을 계속 가리키고 있으면 갱신이 허공에 그려진다.
		this.queueStatusEl = undefined;

		this.ensureQueueSubscription();

		// ── 수집 ──────────────────────────────────────────────────────
		// 실행 로직(최근/Backfill 선택 메뉴, 진행률 Notice, 진단 미들웨어)은
		// CollectController가 갖고 있다 — 리본 아이콘에서도 같은 진행률을 봐야 하므로
		// 설정 탭 하나에 묶어둘 수 없다(main.ts init 참고).
		new Setting(containerEl)
			.setName('수집')
			.setDesc(
				'구독에 등록된 조건으로 수집을 실행하고 결과를 저장합니다. ' +
					'최근 논문은 마지막 수집 지점부터 이어서, Backfill은 지정한 과거 구간을 수집합니다. ' +
					'보정은 임베딩·인용수 조회에 실패했던 논문을 다시 시도합니다.',
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
			)
			.addButton((button) =>
				button.setButtonText('보정').onClick(() => {
					this.plugin.collectController.runRepair();
				}),
			);

		// 큐 상태. 수집 버튼을 잠그는 대신 "지금 무엇이 돌고 무엇이 줄 서 있는지"를 보여준다.
		new Setting(containerEl).setName('대기열').then((setting) => {
			this.queueStatusEl = setting.descEl;
			this.renderQueueStatus();
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
	}
}
