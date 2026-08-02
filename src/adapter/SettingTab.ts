import { App, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';

// 임시 UI. Secret/Subscriptions 클래스의 실제 필드는 아직 우빈이 정하지 않았으므로,
// 여기서는 SettingTab 자체의 로컬 상태에만 바인딩한다 (우빈의 설계를 선점하지 않기 위함).
// 실제 저장은 File/Secret/Subscriptions 구현이 끝난 뒤 TODO 부분에서 연결한다.
export class SettingTab extends PluginSettingTab {
	plugin: PaperGraph3D;

	private apiKeyDraft = '';
	private subscriptionDraft = '';
	private subscriptionDrafts: string[] = [];

	constructor(app: App, plugin: PaperGraph3D) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('API 키')
			.setDesc('Semantic Scholar 등 외부 API 키 (임시 UI — 아직 저장되지 않습니다)')
			.addText((text) =>
				text
					.setPlaceholder('API 키 입력')
					.setValue(this.apiKeyDraft)
					.onChange((value) => {
						this.apiKeyDraft = value;
						// TODO: File/Secret 구현 후 this.plugin.files.writeSecret(...)로 연결
					}),
			);

		new Setting(containerEl).setName('구독').setHeading();

		new Setting(containerEl)
			.setName('구독 추가')
			.setDesc('키워드/저자/카테고리 등 구독 조건 (임시 UI — 아직 저장되지 않습니다)')
			.addText((text) =>
				text.setPlaceholder('구독 조건 입력').onChange((value) => {
					this.subscriptionDraft = value;
				}),
			)
			.addButton((button) =>
				button.setButtonText('추가').onClick(() => {
					if (this.subscriptionDraft.trim().length === 0) {
						return;
					}
					this.subscriptionDrafts.push(this.subscriptionDraft.trim());
					this.subscriptionDraft = '';
					// TODO: File/Subscriptions 구현 후 this.plugin.files.writeSubscriptions(...)로 연결
					this.display();
				}),
			);

		for (const subscription of this.subscriptionDrafts) {
			new Setting(containerEl).setName(subscription).addButton((button) =>
				button.setButtonText('삭제').onClick(() => {
					this.subscriptionDrafts = this.subscriptionDrafts.filter(
						(item) => item !== subscription,
					);
					this.display();
				}),
			);
		}
	}
}
