import { App, Modal, Notice, Setting } from 'obsidian';
import { File } from '../common/File';
import { Paper } from '../collect/Paper';
import { SearchQuery } from '../collect/SearchQuery';

// File 클래스 저장 함수(writePaper / writeSecret / writeSubscriptions)를 한 창에서
// 직접 눌러보는 테스트용 모달. 세 폼이 각자 "추가하기" 버튼을 가지며, 버튼을 눌러도
// 창은 닫히지 않아 연속으로 여러 건을 넣어볼 수 있다. Secret/Subscriptions는 기존
// 파일을 읽어 누적(추가)한다.
export class FileTestModal extends Modal {
	// 논문 폼
	private paperTitle = '';
	private paperDate = '';
	private paperAuthor = '';

	// Secret 폼
	private secretApiName = '';
	private secretKey = '';
	private secretResultEl!: HTMLElement; // "Secret 확인하기" 결과 표시 영역

	// Subscriptions 폼
	private subSearchType = '';
	private subQuery = '';

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'File 테스트' });

		this.renderPaperSection(contentEl);
		this.renderSecretSection(contentEl);
		this.renderSubscriptionSection(contentEl);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── 논문 저장 (File.writePaper) ─────────────────────────────────────
	private renderPaperSection(contentEl: HTMLElement): void {
		contentEl.createEl('h4', { text: '논문 저장 (writePaper)' });

		new Setting(contentEl).setName('논문 이름').addText((text) =>
			text.setPlaceholder('제목').onChange((value) => {
				this.paperTitle = value;
			}),
		);
		new Setting(contentEl).setName('Date (YYYY-MM-DD)').addText((text) => {
			text.setPlaceholder('2025-11-07').onChange((value) => {
				this.paperDate = value;
			});
			text.inputEl.type = 'date';
		});
		new Setting(contentEl).setName('Author').setDesc('쉼표로 여러 명 구분').addText((text) =>
			text.setPlaceholder('Alice, Bob').onChange((value) => {
				this.paperAuthor = value;
			}),
		);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('추가하기')
				.setCta()
				.onClick(async () => {
					try {
						const paper = new Paper();
						paper.title = this.paperTitle.trim() || '테스트 논문';
						paper.authors = this.paperAuthor
							.split(',')
							.map((name) => name.trim())
							.filter((name) => name.length > 0);
						paper.abstract = '';
						paper.sourceId = `test:${Date.now()}`;
						paper.references = [];
						paper.publicationDate = this.paperDate;
						paper.citationCount = 0;
						paper.citationsKnown = false;
						paper.collectedApis = [];
						paper.collectedQueries = [];
						paper.embedding = [];
						paper.embeddingModel = '';
						paper.embeddingSource = '';
						paper.embeddingSucceeded = false;
						await File.writePaper(paper);
						new Notice(`논문 저장됨: ${paper.title}`);
					} catch (error) {
						new Notice(`논문 저장 실패: ${String(error)}`);
					}
				}),
		);
	}

	// ── Secret 저장 (File.writeSecret, Secret.json 누적) ────────────────
	private renderSecretSection(contentEl: HTMLElement): void {
		contentEl.createEl('h4', { text: 'Secret 저장 (writeSecret)' });

		new Setting(contentEl).setName('API 이름').addText((text) =>
			text.setPlaceholder('semanticScholar').onChange((value) => {
				this.secretApiName = value;
			}),
		);
		new Setting(contentEl).setName('Key').addText((text) =>
			text.setPlaceholder('API 키').onChange((value) => {
				this.secretKey = value;
			}),
		);

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('추가하기2')
					.setCta()
					.onClick(async () => {
						const provider = this.secretApiName.trim();
						if (provider.length === 0) {
							new Notice('API 이름을 입력하세요');
							return;
						}
						try {
							const secret = await File.readSecret(); // 기존 키에 누적
							secret.setKey(provider, this.secretKey);
							await File.writeSecret(secret);
							new Notice(`Secret 저장됨: ${provider}`);
						} catch (error) {
							new Notice(`Secret 저장 실패: ${String(error)}`);
						}
					}),
			)
			.addButton((button) =>
				button.setButtonText('Secret 확인하기').onClick(() => {
					void this.showSecrets();
				}),
			);

		// Secret.json에 저장된 provider→key 전체를 표시하는 영역.
		this.secretResultEl = contentEl.createDiv({ cls: 'pg3d-file-test-result' });
	}

	// Secret.json을 읽어 저장된 모든 항목(provider: key)을 결과 영역에 표시한다.
	private async showSecrets(): Promise<void> {
		this.secretResultEl.empty();
		try {
			const secret = await File.readSecret();
			const entries = Object.entries(secret.toJSON());
			if (entries.length === 0) {
				this.secretResultEl.createEl('div', { text: '저장된 Secret 없음' });
				return;
			}
			this.secretResultEl.createEl('div', { text: `저장된 Secret ${entries.length}개:` });
			for (const [provider, key] of entries) {
				this.secretResultEl.createEl('div', { text: `• ${provider}: ${key}` });
			}
		} catch (error) {
			this.secretResultEl.createEl('div', { text: `Secret 확인 실패: ${String(error)}` });
		}
	}

	// ── Subscriptions 저장 (File.writeSubscriptions, 누적) ──────────────
	private renderSubscriptionSection(contentEl: HTMLElement): void {
		contentEl.createEl('h4', { text: 'Subscriptions 저장 (writeSubscriptions)' });

		new Setting(contentEl).setName('SearchType').addText((text) =>
			text.setPlaceholder('keyword').onChange((value) => {
				this.subSearchType = value;
			}),
		);
		new Setting(contentEl).setName('찾고 싶은 string').addText((text) =>
			text.setPlaceholder('검색어').onChange((value) => {
				this.subQuery = value;
			}),
		);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('추가하기3')
				.setCta()
				.onClick(async () => {
					try {
						const query: SearchQuery = {
							searchType: this.subSearchType.trim(),
							query: this.subQuery.trim(),
						};
						const subscriptions = await File.readSubscriptions(); // 기존 구독에 누적
						if (!Array.isArray(subscriptions.apis)) {
							subscriptions.apis = [];
						}
						const firstApi = subscriptions.apis[0];
						if (firstApi) {
							firstApi.querys.push(query);
						} else {
							// 테스트는 arxiv API로 고정. createApi로 만들어야 저장→복원 왕복이 된다.
							subscriptions.apis.push(File.createApi('arxiv', [query]));
						}
						// 커서(updateTime)는 이제 구독마다 독립이라(API.updateTime) 여기서 만질
						// 값이 없다 — 새로 만든 구독은 기본값 0(아직 수집한 적 없음)으로 시작한다.
						// secret은 File.writeSubscriptions가 저장에서 제외하므로 여기서 설정하지 않는다.
						await File.writeSubscriptions(subscriptions);
						new Notice(`Subscriptions 저장됨: ${query.searchType}/${query.query}`);
					} catch (error) {
						new Notice(`Subscriptions 저장 실패: ${String(error)}`);
					}
				}),
		);
	}

}
