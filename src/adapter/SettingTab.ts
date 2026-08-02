import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';

// 조건 타입은 SearchQuery.searchType(string)의 구체적인 값들 — 다이어그램에는 문자열로만
// 정의돼 있어 UI에서 다룰 후보를 여기서 임시로 고정한다. 실제 허용값은 신빈이 API/
// SearchQuery를 구현하며 확정한다.
type ConditionType = 'keyword' | 'author' | 'domain';

const CONDITION_TYPE_LABEL: Record<ConditionType, string> = {
	keyword: '키워드',
	author: '저자',
	domain: '도메인',
};

// 구독 한 건 = API 하나. API 하나에 여러 조건(키워드/저자/도메인 등, SearchQuery)을
// 동시에 걸 수 있다 (Subscriptions.apis: API[], API.querys: SearchQuery[]와 대응).
interface ApiDraft {
	label: string;
	conditions: { searchType: ConditionType; query: string }[];
	newConditionType: ConditionType;
	newConditionQuery: string;
}

// 임시 UI. Secret/Subscriptions/API/SearchQuery 클래스의 실제 필드는 아직 우빈/신빈이
// 정하지 않았으므로, 여기서는 SettingTab 자체의 로컬 상태에만 바인딩한다 (담당자들의
// 설계를 선점하지 않기 위함). 다만 구조(API 하나 : 조건 여러 개)는 다이어그램의
// Subscriptions/API/SearchQuery 관계를 그대로 반영한다.
// 실제 저장은 File/Secret/Subscriptions/API 구현이 끝난 뒤 TODO 부분에서 연결한다.
export class SettingTab extends PluginSettingTab {
	plugin: PaperGraph3D;

	private apiKeyDraft = '';
	private apiLabelDraft = '';
	private apiDrafts: ApiDraft[] = [];

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

		new Setting(containerEl)
			.setName('임베딩 모델')
			.setDesc('설치 여부 확인 필요 (임시 UI — Embedding 구현 전까지는 항상 미구현 알림이 뜹니다)')
			.addButton((button) =>
				button.setButtonText('확인').onClick(async () => {
					try {
						await this.plugin.collectflow.embedding.isModelInstalled();
					} catch {
						new Notice('아직 구현되지 않음: 임베딩 모델 확인');
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('설치')
					.setCta()
					.onClick(async () => {
						try {
							await this.plugin.collectflow.embedding.installModel((progress) => {
								new Notice(`임베딩 모델 설치 중... ${Math.round(progress * 100)}%`);
							});
						} catch {
							new Notice('아직 구현되지 않음: 임베딩 모델 설치');
						}
					}),
			);

		new Setting(containerEl)
			.setName('구독')
			.setDesc(
				'구독은 API 단위로 묶입니다. API 하나에 키워드/저자/도메인 등 여러 조건을 동시에 구독할 수 있습니다.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('API 추가')
			.setDesc('구독 조건을 묶을 API 이름 (예: arXiv, Semantic Scholar)')
			.addText((text) =>
				text.setPlaceholder('API 이름').onChange((value) => {
					this.apiLabelDraft = value;
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('추가')
					.setCta()
					.onClick(() => {
						if (this.apiLabelDraft.trim().length === 0) {
							return;
						}
						this.apiDrafts.push({
							label: this.apiLabelDraft.trim(),
							conditions: [],
							newConditionType: 'keyword',
							newConditionQuery: '',
						});
						this.apiLabelDraft = '';
						// TODO: File/Subscriptions/API 구현 후 this.plugin.files.writeSubscriptions(...)로 연결
						this.display();
					}),
			);

		for (const api of this.apiDrafts) {
			this.renderApiDraft(containerEl, api);
		}
	}

	private renderApiDraft(containerEl: HTMLElement, api: ApiDraft): void {
		new Setting(containerEl)
			.setName(api.label)
			.setHeading()
			.addButton((button) =>
				button.setButtonText('API 삭제').onClick(() => {
					this.apiDrafts = this.apiDrafts.filter((item) => item !== api);
					this.display();
				}),
			);

		for (const condition of api.conditions) {
			new Setting(containerEl)
				.setName(`${CONDITION_TYPE_LABEL[condition.searchType]}: ${condition.query}`)
				.addButton((button) =>
					button.setButtonText('조건 삭제').onClick(() => {
						api.conditions = api.conditions.filter((item) => item !== condition);
						this.display();
					}),
				);
		}

		new Setting(containerEl)
			.setName('조건 추가')
			.setDesc(`${api.label}에 동시에 구독할 조건을 추가합니다.`)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('keyword', CONDITION_TYPE_LABEL.keyword)
					.addOption('author', CONDITION_TYPE_LABEL.author)
					.addOption('domain', CONDITION_TYPE_LABEL.domain)
					.setValue(api.newConditionType)
					.onChange((value) => {
						api.newConditionType = value as ConditionType;
					}),
			)
			.addText((text) =>
				text.setPlaceholder('조건 값').onChange((value) => {
					api.newConditionQuery = value;
				}),
			)
			.addButton((button) =>
				button.setButtonText('추가').onClick(() => {
					if (api.newConditionQuery.trim().length === 0) {
						return;
					}
					api.conditions.push({
						searchType: api.newConditionType,
						query: api.newConditionQuery.trim(),
					});
					api.newConditionQuery = '';
					// TODO: File/Subscriptions/API 구현 후 this.plugin.files.writeSubscriptions(...)로 연결
					this.display();
				}),
			);
	}
}
