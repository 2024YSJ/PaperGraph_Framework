import { App, Modal, Setting } from 'obsidian';

export interface PipelineTestField {
	key: string;
	label: string;
	desc?: string;
	type: 'text' | 'number' | 'date';
	defaultValue?: string;
}

// 설정탭의 "파이프라인 테스트" 버튼 공용 입력창. 각 단계가 아직 대부분 미구현
// 스텁이라 값 자체는 버려질 수 있지만, 담당자가 구현하는 즉시 실제 값(수집 기간
// 등)을 넣어 바로 테스트할 수 있도록 미리 입력창을 만들어둔다.
export class PipelineTestModal extends Modal {
	private readonly values: Record<string, string> = {};

	constructor(
		app: App,
		private readonly title: string,
		private readonly fields: PipelineTestField[],
		private readonly onSubmit: (values: Record<string, string>) => void | Promise<void>,
	) {
		super(app);
		for (const field of fields) {
			this.values[field.key] = field.defaultValue ?? '';
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.title });

		for (const field of this.fields) {
			new Setting(contentEl)
				.setName(field.label)
				.setDesc(field.desc ?? '')
				.addText((text) => {
					text.setValue(this.values[field.key] ?? '').onChange((value) => {
						this.values[field.key] = value;
					});
					text.inputEl.type = field.type;
				});
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('실행')
				.setCta()
				.onClick(() => {
					void this.onSubmit(this.values);
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
