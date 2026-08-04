import { App, Modal, Notice, Setting } from 'obsidian';
import { Paper } from '../collect/Paper';

// arXiv 검색 테스트 결과 확인용 임시 창 결과를 화면에 직접 띄운다.
//파이프 라인 말고 그냥 단순히 arXiv API를 호출해서 결과를 확인하고 싶을 때 쓰는 용도. 
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
