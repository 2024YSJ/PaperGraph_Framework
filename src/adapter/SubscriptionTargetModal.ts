import { App, Modal, Notice, Setting } from 'obsidian';
import { File } from '../common/File';
import { isCalendarDate } from '../common/DateUtil';
import type { SearchQuery } from '../collect/SearchQuery';

export interface SubscriptionTarget {
	apiName: string;
	querys: SearchQuery[];
}

// querys가 빈 구독을 이 선택 창의 목록에서 뺀다. File.readSubscriptions는 이런 구독을
// 일부러 완전히 안 지우고 남겨두지만(apiName 자체가 미등록이면 File.createApi가
// "Unknown apiName"으로 크게 실패해야 하므로 — File.ts 주석 참고), 그건 저장 계층의
// 안전장치일 뿐 이 선택 창이 빈 라벨의 토글을 보여줄 이유는 아니다. 이런 구독을
// 선택해 "실행"해도 buildUrl이 "querys is empty"로 그 자리에서 던질 뿐이라(수동
// 편집으로 조건이 전부 걸러진 경우 실제 재현됨) 애초에 고를 게 없다 — 정리는
// API/구독 관리 창에서 하면 된다.
export function hasCollectableConditions(api: SubscriptionTarget): boolean {
	return api.querys.length > 0;
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
//
// 모양만 보면 2026-02-31 같은 값이 통과해 Date가 조용히 3월 3일로 굴려버린다 —
// isCalendarDate로 달력 유효성까지 확인한다(12번과 같은 뿌리).
export function parseLocalDateInput(value: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match || !isCalendarDate(value)) {
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
	// "실행" 클릭 시점에 onChange가 캐시해 둔 this.from/this.to 대신 이 참조로 DOM에서
	// 값을 직접 읽는다 — <input type="date">가 세그먼트 편집 중 일시적으로 빈 문자열을
	// 보고하는 시점과 onChange 전파 타이밍이 맞물리면, 사용자가 날짜를 올바르게 고친
	// 직후에도 this.from/this.to가 직전(무효했던) 값에 머물러 있을 수 있다 — 캐시된
	// 문자열을 신뢰하지 않고 클릭 순간의 실제 DOM 값을 읽으면 이 문제 전체를 우회한다.
	private fromInputEl?: HTMLInputElement;
	private toInputEl?: HTMLInputElement;
	// apiName(출처)별로 묶어 보여줄 때, 어느 그룹이 접혀 있는지 — ApiManagementModal의
	// 같은 필드와 같은 이유(render()가 매번 새로 그려도 유지돼야 함)로 인스턴스 필드다.
	private collapsedGroups = new Set<string>();

	constructor(
		app: App,
		private readonly title: string,
		private readonly needsDateRange: boolean,
		private readonly onSubmit: (
			targets: SubscriptionTarget[],
			range?: { from: number; to: number },
			// 등록된 구독 전부를 선택한 상태로 실행했는가 — 스케줄러/명령어 팔레트가
			// "대상 없음"(undefined)으로 부르는 것과 의미상 같은 요청임을 호출자가 알 수
			// 있게 한다. 호출자가 이 값을 몰라 매번 명시적 목록을 넘기면, run()의 합침
			// 판단 키가 "명시적 전체 목록"과 "undefined(전체)"로 갈라져 같은 요청인데도
			// 서로 합쳐지지 않는 문제가 생긴다(실제 재현됨 — 리본 메뉴 경로와 자동 실행
			// 경로가 동시에 큐에 쌓임).
			allSelected?: boolean,
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
			this.options = subscriptions.apis
				.filter(hasCollectableConditions)
				.map((api) => ({
					apiName: api.apiName,
					querys: api.querys,
					// apiName 접두어는 뺀다 — 그룹 헤더(render()의 renderGroups)가 이미 보여준다.
					label: api.querys.map((q) => `${q.searchType}:${q.query}`).join(' AND '),
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

		const groupNames = new Set(this.options.map((option) => option.apiName));
		if (groupNames.size > 1) {
			new Setting(contentEl)
				.addButton((button) =>
					button.setButtonText('전체 펼치기').onClick(() => {
						this.collapsedGroups.clear();
						this.render();
					}),
				)
				.addButton((button) =>
					button.setButtonText('전체 접기').onClick(() => {
						this.collapsedGroups = new Set(groupNames);
						this.render();
					}),
				);
		}

		this.renderGroups(contentEl);

		if (this.needsDateRange) {
			// 입력한 날짜는 로컬 자정으로 해석되는데(parseLocalDateInput), arXiv는 UTC
			// 기준으로 논문을 분류한다. 한국(UTC+9)에서 "1/1부터"를 고르면 실제로는 UTC
			// 12/31 15:00부터 걸려서, 결과에 12/31자 논문이 섞여 나올 수 있다 — 유실이나
			// 오동작이 아니라 시차 때문이라는 걸 미리 알려 혼란을 줄인다(실사용 확인).
			new Setting(contentEl).setDesc(
				'날짜는 이 컴퓨터의 로컬 자정 기준입니다. arXiv는 UTC 기준으로 논문을 분류하므로, ' +
					'시차 때문에 결과에 전날 논문이 몇 편 섞여 나올 수 있습니다 — 정상입니다.',
			);
			new Setting(contentEl).setName('시작일').addText((text) => {
				text.setValue(this.from).onChange((value) => {
					this.from = value;
				});
				text.inputEl.type = 'date';
				this.fromInputEl = text.inputEl;
			});
			new Setting(contentEl).setName('종료일 (당일 포함)').addText((text) => {
				text.setValue(this.to).onChange((value) => {
					this.to = value;
				});
				text.inputEl.type = 'date';
				this.toInputEl = text.inputEl;
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
					const allSelected = targets.length === this.options.length;

					if (!this.needsDateRange) {
						void this.onSubmit(targets, undefined, allSelected);
						this.close();
						return;
					}

					// this.from/this.to(onChange 캐시)가 아니라 DOM에서 지금 값을 직접
					// 읽는다 — 위 fromInputEl/toInputEl 주석 참고.
					const fromMs = parseLocalDateInput(this.fromInputEl?.value ?? this.from);
					const toMidnight = parseLocalDateInput(this.toInputEl?.value ?? this.to);
					if (fromMs === undefined || toMidnight === undefined) {
						new Notice('시작일/종료일을 올바르게 입력하세요');
						return;
					}
					// 날짜 입력은 자정(00:00)으로 파싱되므로 그대로 넘기면 종료일 당일이
					// 통째로 빠지고, 시작일=종료일이면 빈 구간이 된다. 하루를 더해
					// "종료일 당일 포함"으로 맞춘다.
					const toMs = toMidnight + 24 * 60 * 60 * 1000;
					void this.onSubmit(targets, { from: fromMs, to: toMs }, allSelected);
					this.close();
				}),
		);
	}

	// options를 apiName(출처)별로 묶어 접을 수 있는 그룹으로 그린다 —
	// ApiManagementModal.renderSubscriptionGroups와 같은 관례(그룹 헤더 + 요약 배지 +
	// 들여쓴 자식 컨테이너)를 따른다. 두 UI가 같은 구독 데이터를 다른 화면(등록/관리 vs
	// 실행 전 선택)에서 보여주는 것뿐이라, 그룹화 방식이 어긋나면 사용자가 두 화면을
	// 다른 개념 모형으로 이해하게 된다.
	private renderGroups(containerEl: HTMLElement): void {
		const groups = new Map<string, SubscriptionOption[]>();
		for (const option of this.options) {
			const list = groups.get(option.apiName) ?? [];
			list.push(option);
			groups.set(option.apiName, list);
		}
		for (const [apiName, options] of groups) {
			this.renderGroup(containerEl, apiName, options);
		}
	}

	private renderGroup(containerEl: HTMLElement, apiName: string, options: SubscriptionOption[]): void {
		const collapsed = this.collapsedGroups.has(apiName);
		const selectedCount = options.filter((option) => option.selected).length;

		const heading = new Setting(containerEl).setName(`${collapsed ? '▸' : '▾'} ${apiName}`).setHeading();
		heading.nameEl.createSpan({
			text: ` · ${options.length}개 중 ${selectedCount}개 선택`,
			attr: {
				style: 'font-size:0.8em; font-weight:normal; color: var(--text-muted); margin-left:6px;',
			},
		});
		heading.settingEl.addEventListener('click', () => {
			if (collapsed) {
				this.collapsedGroups.delete(apiName);
			} else {
				this.collapsedGroups.add(apiName);
			}
			this.render();
		});
		heading.settingEl.setCssProps({ cursor: 'pointer' });

		if (collapsed) {
			return;
		}

		const childContainer = containerEl.createDiv({
			attr: {
				style:
					'margin-left:16px; border-left:2px solid var(--background-modifier-border); padding-left:12px;',
			},
		});
		for (const option of options) {
			new Setting(childContainer).setName(option.label).addToggle((toggle) =>
				toggle.setValue(option.selected).onChange((value) => {
					option.selected = value;
					// 배지("N개 중 K개 선택")가 실시간으로 맞으려면 다시 그려야 한다 — 예전엔
					// 로컬 상태만 바꾸고 안 그렸는데, 그룹 배지가 생기면서 그 값이 화면과
					// 어긋나지 않아야 한다.
					this.render();
				}),
			);
		}
	}
}
