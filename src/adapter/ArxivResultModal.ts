import { App, Modal, Notice, Setting } from 'obsidian';
import { Paper } from '../collect/Paper';

// arXiv 검색 테스트 결과 확인용 임시 창. Obsidian 1.13의 개발자 콘솔은 실제 앱과 다른
// 프레임(about:blank)을 보고 있어 console.log가 보이지 않는 경우가 있어, 결과를 화면에
// 직접 띄운다. 실제 파이프라인 코드가 아니라 신빈의 arXiv 연동 검증용이므로,
// SettingTab 구독 UI 배선이 끝나면 지워도 된다.
export class ArxivResultModal extends Modal {
	constructor(
		app: App,
		private readonly keyword: string,
		private readonly papers: Paper[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: `arXiv 검색 결과 — "${this.keyword}" (${this.papers.length}건)` });

		const first = this.papers[0];
		if (!first) {
			contentEl.createEl('p', { text: '결과가 없습니다.' });
			return;
		}

		// 첫 논문의 필드별 매핑 결과 — Paper의 각 필드가 제대로 채워졌는지 눈으로 확인하는 게 목적.
		const rows: [string, string][] = [
			['title', first.title],
			['authors', first.authors.join(', ')],
			['sourceId', first.sourceId],
			['publicationDate', first.publicationDate],
			['citationCount', String(first.citationCount)],
			['citationsKnown', String(first.citationsKnown)],
			['collectedApi', first.collectedApi],
			['collectedQuery', `${first.collectedQuery.searchType} / ${first.collectedQuery.query}`],
			['abstract', `${first.abstract.slice(0, 200)}...`],
		];

		contentEl.createEl('h4', { text: '첫 번째 논문의 Paper 매핑' });
		for (const [key, value] of rows) {
			new Setting(contentEl).setName(key).setDesc(value);
		}

		contentEl.createEl('h4', { text: `제목 목록 (앞 10건)` });
		const list = contentEl.createEl('ol');
		for (const paper of this.papers.slice(0, 10)) {
			list.createEl('li', { text: paper.title });
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('전체 JSON 클립보드 복사')
				.setCta()
				.onClick(async () => {
					await navigator.clipboard.writeText(JSON.stringify(this.papers, null, 2));
					new Notice(`${this.papers.length}건 JSON을 클립보드에 복사했습니다`);
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
