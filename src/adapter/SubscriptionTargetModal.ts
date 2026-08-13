import { App, Modal, Notice, Setting } from 'obsidian';
import { File } from '../common/File';
import type { SearchQuery } from '../collect/SearchQuery';

export interface SubscriptionTarget {
	apiName: string;
	querys: SearchQuery[];
}

interface SubscriptionOption extends SubscriptionTarget {
	label: string;
	selected: boolean;
}

// 날짜 입력(YYYY-MM-DD)을 로컬 자정 timestamp(ms)로 변환한다. 비어있거나 잘못된
// 값이면 undefined.
//
// Date.parse('YYYY-MM-DD')를 쓰지 않는다 — ISO 스펙상 날짜만 있는 문자열은 UTC
// 자정으로 해석되는데, 이 앱은 항상 사용자의 로컬 기기에서만 도는 단일 사용자 플러그인
// 이라 그 해석이 사용자가 <input type=date>에서 실제로 고른 날짜와 어긋난다(로컬이
// UTC+9면 하루 밀림). 연/월/일을 분리해 로컬 컴포넌트로 직접 구성해 이 어긋남을 없앤다.
function parseLocalDateInput(value: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) {
		return undefined;
	}
	const [, y, mo, d] = match;
	const date = new Date(Number(y), Number(mo) - 1, Number(d));
	return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

// Recent/Backfill 실행 전 "이번엔 어느 구독만 돌릴지" 고르는 창.
//
// 기본은 전체 선택이다 — 예전처럼 "항상 등록된 구독 전체를 돈다"가 기본 동작이고,
// 타겟팅은 필요할 때만 좁히는 선택 사항이라는 점을 그대로 유지한다.
//
// Backfill은 구독 선택과 별개로 수집 기간(from/to)도 받아야 하므로, needsDateRange를
// 주면 같은 창에 날짜 입력까지 그린다 — 별도 모달을 체이닝하면 "구독은 골랐는데 기간
// 입력에서 취소" 같은 중간 상태를 다뤄야 해서 한 창에 합쳤다.
export class SubscriptionTargetModal extends Modal {
	private options: SubscriptionOption[] = [];
	private loaded = false;
	private from: string;
	private to: string;

	constructor(
		app: App,
		private readonly title: string,
		private readonly needsDateRange: boolean,
		private readonly onSubmit: (
			targets: SubscriptionTarget[],
			range?: { from: number; to: number },
		) => void | Promise<void>,
		defaultFrom = '',
		defaultTo = '',
	) {
		super(app);
		this.from = defaultFrom;
		this.to = defaultTo;
	}

	onOpen(): void {
		this.render();
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// 구독 목록은 비동기로만 읽을 수 있는데 onOpen은 동기다. 열자마자 로드를 걸어두고
	// 끝나면 다시 그린다(ApiManagementModal.loadSubscriptions와 같은 패턴).
	private async load(): Promise<void> {
		try {
			const subscriptions = await File.readSubscriptions();
			this.options = subscriptions.apis.map((api) => ({
				apiName: api.apiName,
				querys: api.querys,
				label: `${api.apiName}: ${api.querys.map((q) => `${q.searchType}:${q.query}`).join(' AND ')}`,
				selected: true,
			}));
		} catch (e) {
			new Notice(`구독 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.loaded = true;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.title });

		if (!this.loaded) {
			contentEl.createDiv({ text: '구독 목록을 불러오는 중...' });
			return;
		}
		if (this.options.length === 0) {
			contentEl.createDiv({
				text: '등록된 구독이 없습니다. 「API / 구독 관리」에서 먼저 구독을 추가하세요.',
			});
			return;
		}

		new Setting(contentEl)
			.setDesc('수집할 구독을 고르세요 (기본은 전체 선택).')
			.addButton((button) =>
				button.setButtonText('전체 선택').onClick(() => {
					for (const option of this.options) {
						option.selected = true;
					}
					this.render();
				}),
			)
			.addButton((button) =>
				button.setButtonText('전체 해제').onClick(() => {
					for (const option of this.options) {
						option.selected = false;
					}
					this.render();
				}),
			);

		for (const option of this.options) {
			new Setting(contentEl).setName(option.label).addToggle((toggle) =>
				toggle.setValue(option.selected).onChange((value) => {
					option.selected = value;
				}),
			);
		}

		if (this.needsDateRange) {
			new Setting(contentEl).setName('시작일').addText((text) => {
				text.setValue(this.from).onChange((value) => {
					this.from = value;
				});
				text.inputEl.type = 'date';
			});
			new Setting(contentEl).setName('종료일 (당일 포함)').addText((text) => {
				text.setValue(this.to).onChange((value) => {
					this.to = value;
				});
				text.inputEl.type = 'date';
			});
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('실행')
				.setCta()
				.onClick(() => {
					const targets = this.options
						.filter((option) => option.selected)
						.map((option) => ({ apiName: option.apiName, querys: option.querys }));
					if (targets.length === 0) {
						new Notice('구독을 1개 이상 선택하세요.');
						return;
					}

					if (!this.needsDateRange) {
						void this.onSubmit(targets);
						this.close();
						return;
					}

					const fromMs = parseLocalDateInput(this.from);
					const toMidnight = parseLocalDateInput(this.to);
					if (fromMs === undefined || toMidnight === undefined) {
						new Notice('시작일/종료일을 올바르게 입력하세요');
						return;
					}
					// 날짜 입력은 자정(00:00)으로 파싱되므로 그대로 넘기면 종료일 당일이
					// 통째로 빠지고, 시작일=종료일이면 빈 구간이 된다. 하루를 더해
					// "종료일 당일 포함"으로 맞춘다.
					const toMs = toMidnight + 24 * 60 * 60 * 1000;
					void this.onSubmit(targets, { from: fromMs, to: toMs });
					this.close();
				}),
		);
	}
}
