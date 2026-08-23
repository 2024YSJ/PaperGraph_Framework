import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { FailureNotifier } from '../common/Notify';
import { hasMeaningfulQueryValue, SearchQuery } from '../collect/SearchQuery';
import { findDescriptor } from '../collect/API';
import { KEY_VALIDATORS } from '../collect/SecretValidation';

// 조건 타입은 SearchQuery.searchType(string)의 구체적인 값들 — 어떤 이름이 유효한지는
// apiName마다 다르고, 그건 그 출처(예: ArxivAPI)만 아는 사정이라 여기서 미리 정해두지
// 않는다. findDescriptor(apiName).conditionFields가 유일한 진실이다(ApiDescriptor
// 참고) — 예전엔 여기 하드코딩된 유니온 타입이 API.ts의 FIELD_PREFIX 키와 수동으로
// 맞아야 했고, 어긋나면 formatTerm()이 "Unknown searchType"으로 던지면서 그제서야
// 드러났다.
type ConditionType = string;

// 구독 한 건 = API 하나. API 하나에 여러 조건(키워드/저자/분류 등, SearchQuery)을
// 동시에 걸 수 있다 (Subscriptions.apis: API[], API.querys: SearchQuery[]와 대응).
// apiName은 File.supportedApiNames() 목록에서 고른 값 — 자유 텍스트였을 때는 'arXiv'
// 같은 오타가 저장을 통과하고 다음 수집(createApi)에서야 터졌다.
interface ApiDraft {
	apiName: string;
	conditions: { searchType: ConditionType; query: string }[];
	newConditionType: ConditionType;
	newConditionQuery: string;
	// 지금 화면의 이 카드가 디스크(Subscriptions.json)와 실제로 일치하는가. loadSubscriptions가
	// 만든 카드는 true로 시작하고, 「구독 추가」로 만든 새 카드나 조건을 고친 카드는 false로
	// 바뀐다 — 「저장」을 눌러 실제로 반영되기 전까지는 "진짜 구독"과 "등록하려는 중인
	// 구독"이 화면에서 구분되지 않아 헷갈린다는 피드백으로 추가했다.
	saved: boolean;
}

// 한 구독(API 하나)에 걸 수 있는 조건 수 상한 — 004의 "조건 최대 3개, 전부 AND" 규칙.
const MAX_CONDITIONS_PER_API = 3;

// API 키 등록과 구독(수집 조건) 관리를 한데 묶은 별도 창. 둘 다 설정 탭에 흩어져 있으면
// 찾기 번거롭고, 특히 구독은 자주 여닫는 작업이라 리본 아이콘/커맨드로 바로 접근할 수
// 있어야 한다는 요청으로 분리했다 — 설정 탭에는 이 모달을 여는 진입점 버튼만 남는다.
//
// 구독 UI는 Subscriptions.json과 실시간 동기화된다: 열 때 읽어와 복원하고, 추가/삭제
// 때마다 즉시 저장한다.
export class ApiManagementModal extends Modal {
	// 새 카드/조건의 초기 선택지 — 그 apiName이 지원하는 첫 번째 조건 필드. 등록되지
	// 않은 apiName(구버전 파일 등)이면 빈 문자열 — 드롭다운도 비어 그려지고, 이후
	// createApi가 "Unknown apiName"으로 더 크게 드러낸다.
	private static firstConditionType(apiName: string): string {
		return findDescriptor(apiName)?.conditionFields[0]?.name ?? '';
	}

	// 조건 요약/목록에 보여줄 사람이 읽는 이름. 등록되지 않은 apiName이거나 그 출처가
	// 모르는 필드 이름(구버전 파일이 남긴 값 등)이면 이름 그대로 보여준다 — 조용히
	// 감추는 것보다, 알 수 없는 값이 있다는 걸 그대로 드러내는 편이 낫다.
	private static conditionLabel(apiName: string, searchType: string): string {
		return (
			findDescriptor(apiName)?.conditionFields.find((f) => f.name === searchType)?.label ??
			searchType
		);
	}

	// 저장 직전 마지막 관문 — persistSubscriptions가 이 draft를 실제로 쓰기 전에 부른다.
	// "필드에 추가" 버튼이 쓰는 것과 같은 기준(descriptor.conditionFields)으로 다시
	// 검사한다 — 개발자 도구로 그 버튼의 검사를 우회해 이상한 필드명을 카드에 얹어도,
	// 여기서 걸리면 저장이 통째로 취소된다. apiName 자체가 모르는 값이면(등록 안 된
	// 출처) 첫 조건을 그대로 "무효"로 돌려준다 — 검사할 기준(conditionFields)조차 없다.
	private static findInvalidCondition(draft: ApiDraft): { searchType: string } | undefined {
		const fields = findDescriptor(draft.apiName)?.conditionFields;
		if (!fields) {
			return draft.conditions[0];
		}
		return draft.conditions.find((condition) => {
			const field = fields.find((f) => f.name === condition.searchType);
			return !field || !field.validate(condition.query);
		});
	}

	// 지금 폼에 입력 중인 provider·키 값. KEY_VALIDATORS가 provider 선택지의 유일한
	// 진실이다 — 구독 API 목록(File.supportedApiNames)과는 다른 레지스트리다: 구독은
	// "수집 출처"(arxiv 등, 키가 필요 없을 수도 있음)를, 이건 "키로 인증하는 보강용
	// 외부 서비스"(S2 등)를 나열한다. 나중에 수집 출처가 늘어나도 키 선택 목록이 같이
	// 늘어나며 어긋나는 일이 없도록 소스를 분리해둔다.
	private apiKeyProviderDraft: string = KEY_VALIDATORS[0]?.provider ?? '';
	private apiKeyValueDraft = '';
	// provider -> 등록된 키. 목록 표시(조회/삭제/수정)에 쓴다.
	private registeredKeys: Record<string, string> = {};
	private apiNameDraft = '';
	private apiDrafts: ApiDraft[] = [];
	private subscriptionsLoaded = false;
	// 저장된 구독을 읽지 못한 상태인가. 읽기에 실패했는데 저장을 허용하면, 화면의 빈
	// 목록이 그대로 디스크를 덮어써 읽지 못했을 뿐 멀쩡히 있던 구독이 사라진다.
	private subscriptionsUnreadable = false;
	// 다음 render() 직후 새로 추가된 카드로 스크롤해야 하는가. contentEl.scrollTop을
	// 직접 계산해 맞추는 방식은 실제 스크롤 컨테이너가 contentEl이 아닐 수 있어(Obsidian
	// 모달 레이아웃에 따라 감싸는 요소가 따로 있을 수 있다) 안 먹혔다 — scrollIntoView는
	// 어떤 조상이 실제로 스크롤되는지 브라우저가 알아서 찾아주므로 이 가정 자체가 필요 없다.
	private scrollToNewCard = false;

	// 구독 카드를 apiName(출처)별로 묶어 보여줄 때, 어느 그룹이 접혀 있는지. render()가
	// contentEl.empty()로 매번 다시 그려도 이 Set은 인스턴스 필드라 유지된다. 기본은
	// 빈 Set(전부 펼침) — 예전처럼 전부 보이는 상태를 그대로 유지한다.
	private collapsedGroups = new Set<string>();

	// 신규 구독 자동 수집(runRecentOneAuto)은 silent라 Notice가 없고, 실패도 원래
	// 로그만 남기고 조용히 넘어갔다 — 그러면 "저장 성공" Notice만 뜨고 뒤이은 실패는
	// 사용자가 알 방법이 없었다. FailureNotifier로 이유가 바뀔 때만 알려 스팸 없이
	// 이 공백을 메운다. 모달을 열 때마다 새 인스턴스라 게이팅도 그때그때 초기화되는데,
	// 이 동작은 한 모달 세션 안에서 반복 저장할 때만 스팸을 막으면 충분해 문제 없다.
	private readonly recentOneFailureNotifier = new FailureNotifier();

	// plugin 참조는 저장 성공 직후 방금 등록한 구독 하나만 자동 수집하기 위해
	// EventListener('ui:collect-recent-one')를 호출할 때 필요하다.
	constructor(app: App, private readonly plugin: PaperGraph3D) {
		super(app);
	}

	onOpen(): void {
		this.render();
		// 저장된 구독/키는 비동기로만 읽을 수 있는데 onOpen은 동기다. 열자마자 로드를
		// 걸어두고 끝나면 다시 그린다.
		if (!this.subscriptionsLoaded) {
			void this.loadSubscriptions();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'API / 구독 관리' });

		// ── API 키 ────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('API 키')
			.setDesc(
				'Semantic Scholar 등 외부 API 호출에 실어 보낼 개인 키를 등록합니다. API 연동 ' +
					'자체는 코드로 이미 구현되어 있고, 이 키는 그 위에서 내 계정의 요청 한도를 쓰기 ' +
					'위한 선택 사항입니다 — 키가 없어도 익명으로 호출되지만, 다른 모든 익명 ' +
					'사용자와 한도를 나눠 써서 요청이 자주 막힙니다. provider를 먼저 고르고 키를 ' +
					'저장하면, 저장 즉시 그 provider에 실제로 요청을 보내 유효한지 바로 확인합니다.',
			)
			.setHeading();

		if (KEY_VALIDATORS.length === 0) {
			new Setting(contentEl).setDesc('키가 필요한 provider가 등록돼 있지 않습니다.');
		} else {
			new Setting(contentEl).setName('Provider').then((setting) => {
				// Obsidian Setting API에 라디오 컴포넌트가 없어 네이티브 input[type=radio]를
				// 직접 그린다. 선택지는 KEY_VALIDATORS(키가 필요한 외부 서비스 레지스트리)에서만
				// 가져온다 — 구독 API 목록(File.supportedApiNames)을 재사용하지 않는다: 그
				// 목록은 "수집 출처"를 나열하는 별개 레지스트리라, 나중에 키가 필요 없는
				// 수집 출처가 추가되면 두 목록이 어긋난다.
				for (const validator of KEY_VALIDATORS) {
					const label = setting.controlEl.createEl('label', {
						attr: { style: 'display:flex; align-items:center; gap:4px; margin-right:12px;' },
					});
					const radio = label.createEl('input', { type: 'radio' });
					radio.name = 'pg3d-api-key-provider';
					radio.checked = this.apiKeyProviderDraft === validator.provider;
					radio.addEventListener('change', () => {
						this.apiKeyProviderDraft = validator.provider;
						// provider를 바꾸면 그 provider에 이미 등록된 키가 있으면 그대로
						// 보여준다(수정 흐름) — 없으면 빈칸으로 새로 등록하는 흐름이 된다.
						this.apiKeyValueDraft = this.registeredKeys[validator.provider] ?? '';
						this.render();
					});
					label.createSpan({ text: validator.provider });
				}
			});
		}

		new Setting(contentEl)
			.setName('키 값')
			.setDesc('저장하면 즉시 이 provider로 요청을 보내 키가 통하는지 확인합니다.')
			.addText((text) =>
				text
					.setPlaceholder('API 키 입력')
					.setValue(this.apiKeyValueDraft)
					.onChange((value) => {
						this.apiKeyValueDraft = value;
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('저장')
					.setCta()
					.onClick(() => {
						button.setDisabled(true);
						void this.persistApiKey()
							.then(({ provider }) => {
								new Notice(`${provider} 키를 저장하고 확인했습니다 — 정상 동작합니다.`);
							})
							.catch((e: unknown) => {
								new Notice(`API 키 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
							})
							.finally(() => {
								button.setDisabled(false);
								this.render();
							});
					}),
			);

		// ── 등록된 키 목록 (조회/삭제) ──────────────────────────────────
		// "수정" 버튼은 없앴다 — provider 라디오를 고르는 순간 이미 그 provider의 등록값이
		// 폼에 자동으로 채워지므로(위 radio.addEventListener), 지금처럼 provider가 하나뿐인
		// 구조에서는 버튼을 눌러도 이미 채워진 값을 다시 채우는 것뿐이라 화면상 아무 변화가
		// 없어 고장난 것처럼 보였다(실사용 확인됨). provider가 여러 개로 늘어나 "다른
		// provider의 등록값을 폼으로 불러오는 진입점"이 다시 필요해지면, 목록 항목 클릭이나
		// 이 자리에 다시 추가하면 된다.
		const providers = Object.keys(this.registeredKeys);
		if (this.subscriptionsLoaded && providers.length === 0) {
			new Setting(contentEl).setDesc('등록된 키가 없습니다.');
		}
		for (const provider of providers) {
			new Setting(contentEl)
				.setName(provider)
				.setDesc(this.registeredKeys[provider] ?? '')
				.addButton((button) =>
					button.setButtonText('삭제').onClick(() => {
						void this.deleteApiKey(provider);
					}),
				);
		}

		// API 키 묶음과 구독 묶음을 시각적으로 분리 — 헤딩만으로는 두 묶음이 이어져
		// 보여서, 별도 그룹이라는 게 한눈에 안 들어온다는 피드백으로 추가.
		contentEl.createEl('hr');

		// ── 구독 ──────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName('구독')
			.setDesc(
				'구독은 API 단위로 묶입니다. API 하나에 키워드/저자/도메인 등 여러 조건을 동시에 구독할 수 있습니다.',
			)
			.setHeading();

		if (this.subscriptionsLoaded && this.apiDrafts.length === 0) {
			new Setting(contentEl).setDesc(
				'등록된 구독이 없습니다. 아래에서 구독을 추가해 수집할 조건을 설정하세요.',
			);
		}

		// 저장 안 된(unsaved) 카드가 이미 있으면 새로 추가하지 않는다 — 구독 추가는 한
		// 번에 하나씩만: 미저장 카드가 여러 개 쌓이면 「조건 추가 + 저장」 세트가 화면에
		// 반복돼 지금 어느 카드를 마무리해야 하는지 헷갈린다는 피드백으로 막았다. 먼저
		// 그 카드를 저장하거나 지워야 다음 카드를 추가할 수 있다.
		const hasUnsavedDraft = this.apiDrafts.some((draft) => !draft.saved);
		// 지원 출처는 지금 arXiv 하나뿐이다 — 고를 게 하나뿐인 선택 UI(드롭다운)는 매 번
		// 같은 값을 다시 고르게 할 뿐이라 없앴다. 지원 목록은 여전히 File의 API 레지스트리가
		// 진실이므로, 그 첫 번째(유일한) 값을 그대로 쓴다. 나중에 수집 출처가 늘어나면 그때
		// 다시 선택 UI를 붙이면 된다.
		if (this.apiNameDraft.length === 0) {
			this.apiNameDraft = File.supportedApiNames()[0] ?? '';
		}
		new Setting(contentEl)
			.setName('구독 추가')
			.setDesc(
				hasUnsavedDraft
					? '저장하지 않은 구독이 있습니다. 먼저 그 구독을 저장하거나 삭제해야 새 구독을 추가할 수 있습니다.'
					: '수집할 조건을 담을 새 구독을 추가합니다.',
			)
			.addButton((button) =>
				button
					.setButtonText('구독 추가')
					.setCta()
					.setDisabled(hasUnsavedDraft)
					.onClick(() => {
						if (this.apiNameDraft.length === 0 || hasUnsavedDraft) {
							return;
						}
						// 같은 API를 여러 번 추가하는 것은 허용한다 — 구독 하나 = API 인스턴스
						// 하나이고, 같은 arXiv에 서로 다른 조건 묶음을 거는 건 정당한 사용이다.
						// (단, 한 번에 하나씩만 — 위 hasUnsavedDraft 가드가 미저장 카드가 있는
						// 동안은 이 버튼 자체를 막는다.)
						this.apiDrafts.push({
							apiName: this.apiNameDraft,
							conditions: [],
							newConditionType: ApiManagementModal.firstConditionType(this.apiNameDraft),
							newConditionQuery: '',
							saved: false, // 아직 디스크에 없다 — 「저장」을 눌러야 진짜 구독이 된다.
						});
						// 이 apiName 그룹이 접혀 있었으면 펼친다 — 안 그러면 방금 추가한 카드가
						// 접힌 그룹 안에 숨어 scrollToNewCard가 무의미해진다.
						this.collapsedGroups.delete(this.apiNameDraft);
						// 여기서는 저장하지 않는다 — 조건 0개인 채로 저장하면 다음 수집이
						// "querys is empty"로 반드시 실패한다(persistSubscriptions의 필터와
						// 짝이다). 아래 카드에서 조건을 채우고 「저장」을 눌러야 실제로 기록된다.
						//
						// 새 카드는 항상 목록 맨 끝에 붙는다(apiDrafts.push) — 구독이 몇 개
						// 쌓이면 방금 추가한 카드가 스크롤 밖에 있어 매번 손으로 내려야 했다.
						// render()가 다시 그린 뒤 그 카드로 스크롤한다(render() 끝 참고).
						this.scrollToNewCard = true;
						this.render();
					}),
			);

		this.renderSubscriptionGroups(contentEl);

		// 저장 버튼은 화면 전체에 딱 1개, 맨 아래에만 둔다 — 미저장 카드는 위의
		// hasUnsavedDraft 가드 덕분에 항상 최대 1개뿐이므로, "지금 저장할 대상"도 항상
		// 하나로 정해진다. 카드마다 저장 버튼을 따로 두면(예전 방식) 카드가 늘어날수록
		// 버튼도 늘어나 지금 뭘 눌러야 하는지 헷갈린다는 피드백으로 이렇게 모았다.
		const unsavedDraft = this.apiDrafts.find((draft) => !draft.saved);
		if (unsavedDraft) {
			new Setting(contentEl)
				.setDesc('위에서 모은 조건을 실제로 저장합니다. 저장 전까지는 디스크에 반영되지 않습니다.')
				.addButton((button) =>
					button
						.setButtonText('저장')
						.setCta()
						.onClick(() => {
							button.setDisabled(true);
							void this.persistSubscriptions(unsavedDraft)
								.then((ok) => {
									if (ok) {
										new Notice(`${unsavedDraft.apiName} 구독을 저장했습니다.`);
										// 신규 구독 등록 직후 그 구독 하나만 자동으로 1회 수집한다
										// (TaskManager 경유 — collect:recent-one). 저장 자체는 이미
										// 성공했으므로 실패해도 실행을 막지는 않지만, 완전히 조용히
										// 넘어가진 않는다 — 이유가 바뀔 때만 Notice로도 알린다
										// (FailureNotifier, 스팸 방지).
										const querys = unsavedDraft.conditions.map(
											(c): SearchQuery => ({ searchType: c.searchType, query: c.query }),
										);
										void this.plugin.eventListener
											.checking('ui:collect-recent-one', {
												apiName: unsavedDraft.apiName,
												querys,
											})
											.then(() => this.recentOneFailureNotifier.notifySuccess())
											.catch((e) => {
												Log.error('ui', '신규 구독 자동 수집 실패', e);
												const reason = e instanceof Error ? e.message : String(e);
												this.recentOneFailureNotifier.notifyFailure(
													reason,
													(r) =>
														`PaperGraph3D: ${unsavedDraft.apiName} 구독의 자동 수집이 실패했습니다 — ${r}`,
												);
											});
									}
								})
								.finally(() => {
									button.setDisabled(false);
									this.render();
								});
						}),
				);
		}

		if (this.scrollToNewCard) {
			this.scrollToNewCard = false;
			// 맨 아래 저장 버튼까지 내린다 — 새 카드를 추가하면 곧바로 이어서 조건을 채우고
			// 저장까지 하나의 흐름으로 이어지므로, 카드가 아니라 그 흐름의 끝(저장 버튼)이
			// 보여야 한다. 미저장 카드가 있을 때만 scrollToNewCard가 설정되므로 이 시점에
			// 방금 그 저장 버튼이 항상 contentEl의 마지막 자식이다.
			contentEl.lastElementChild?.scrollIntoView({ block: 'end' });
		}
	}

	// Subscriptions.json -> apiDrafts. 모달을 열 때 한 번만 — 이후에는 UI가 진실이고
	// 변경할 때마다 persistSubscriptions()로 즉시 내려쓴다.
	private async loadSubscriptions(): Promise<void> {
		try {
			const subscriptions = await File.readSubscriptions();
			this.apiDrafts = subscriptions.apis.map((api) => ({
				apiName: api.apiName,
				conditions: api.querys.map((query) => ({
					searchType: query.searchType,
					query: query.query,
				})),
				newConditionType: ApiManagementModal.firstConditionType(api.apiName),
				newConditionQuery: '',
				saved: true, // 디스크에서 그대로 읽어온 카드 — 지금 화면과 저장본이 일치한다.
			}));
			this.subscriptionsUnreadable = false;
		} catch (e) {
			// 예: 이 버전이 모르는 apiName이 저장돼 있으면 createApi가 throw한다(팀원이 새
			// API를 추가한 브랜치로 저장한 파일을 옛 코드로 열었을 때). 이 상태로 저장까지
			// 허용하면 그 구독을 통째로 날리므로 저장을 막는다.
			this.subscriptionsUnreadable = true;
			new Notice(`구독 정보를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.apiNameDraft = File.supportedApiNames()[0] ?? '';

		// 등록된 키 전부를 불러와 목록(조회/수정/삭제)과 폼 프리필에 쓴다. 평문으로 보여주는
		// 것은 이 vault 밖으로 안 나가는 로컬 값이라는 기존 판단을 그대로 따른다.
		try {
			const secret = await File.readSecret();
			this.registeredKeys = {};
			for (const provider of secret.providers()) {
				const key = secret.getKey(provider);
				if (key !== undefined) {
					this.registeredKeys[provider] = key;
				}
			}
			if (this.apiKeyProviderDraft.length > 0) {
				this.apiKeyValueDraft = this.registeredKeys[this.apiKeyProviderDraft] ?? '';
			}
		} catch (e) {
			new Notice(`API 키를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}

		this.subscriptionsLoaded = true;
		this.render();
	}

	// (apiKeyProviderDraft, apiKeyValueDraft) -> Secret.json. provider는 라디오로
	// 명시적으로 고른 값이므로(옛 identifyKeyProvider처럼 여러 validator에 순서대로
	// 물어보며 자동 판별할 필요가 없다), 그 provider의 validator 하나에만 실제 요청을
	// 보내 저장과 동시에 검증한다.
	//
	// valid:true로 실제 확인된 키만 저장한다 — invalid-key(401/403 등 명확히 틀린 키)는
	// 물론이고, network-error(오프라인 등 이 순간엔 판단이 안 되는 경우)도 막는다.
	// "일단 저장해두고 나중에 확인"을 허용하면, 확인되지 않은 키가 계속 저장돼 있는
	// 채로 다음 보강 요청마다 같은 실패가 조용히 반복될 수 있다 — 지금 확실히 통하는
	// 키만 들어오게 한다(2026-08-13 결정).
	private async persistApiKey(): Promise<{ provider: string }> {
		const provider = this.apiKeyProviderDraft;
		const key = this.apiKeyValueDraft.trim();
		if (key.length === 0) {
			throw new Error('키를 입력하세요.');
		}
		const validator = KEY_VALIDATORS.find((v) => v.provider === provider);
		if (!validator) {
			throw new Error(`등록되지 않은 provider입니다: ${provider}`);
		}
		const result = await validator.validate(key);
		if (!result.valid) {
			const reason =
				result.reason === 'invalid-key'
					? '키가 유효하지 않습니다'
					: `확인할 수 없습니다${result.detail ? ` (${result.detail})` : ''} — 네트워크 상태를 확인하고 다시 시도하세요`;
			throw new Error(`${provider} 키를 ${reason} — 저장하지 않았습니다.`);
		}
		const secret = await File.readSecret();
		secret.setKey(provider, key);
		await File.writeSecret(secret);
		this.registeredKeys[provider] = key;
		return { provider };
	}

	// 등록된 키 하나를 즉시 삭제한다 — 검증이 필요 없는(존재를 없애는) 동작이라 「저장」
	// 버튼과 달리 확인 절차 없이 바로 반영한다.
	private async deleteApiKey(provider: string): Promise<void> {
		try {
			const secret = await File.readSecret();
			secret.removeKey(provider);
			await File.writeSecret(secret);
			delete this.registeredKeys[provider];
			if (this.apiKeyProviderDraft === provider) {
				this.apiKeyValueDraft = '';
			}
			new Notice(`${provider} 키를 삭제했습니다.`);
			this.render();
		} catch (e) {
			new Notice(`키 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// apiDrafts -> Subscriptions.json. 현재 저장본을 읽어와 apis만 갈아끼운다.
	//
	// 조건 추가/삭제는 이제 로컬(apiDrafts)에서만 일어나고, 실제 저장은 카드의 「저장」
	// 버튼을 눌러야만 일어난다 — 동적 폼으로 조건을 여러 개 모았다가 한 번에 저장하기
	// 위함이다(레코드 하나하나마다 디스크에 왕복하던 예전 방식 대신).
	//
	// clickedDraft를 주면 "지금 사용자가 저장을 시도한 카드"를 가리킨다 — 그 카드가
	// 조건 0개면 이 시도 자체를 막고 Notice로 알린다. 조건 0개인 다른(아직 안 끝난) 초안은
	// 조용히 저장 대상에서 뺀다 — 그것 때문에 지금 완성한 카드의 저장까지 막히면 안 된다.
	//
	// File.mutateSubscriptions로 읽기-수정-쓰기를 큐에 태운다 — 수집이 막 끝나며
	// File.updateApiCursors가 같은 파일을 읽고 쓰는 시점과 겹칠 수 있는데, 직접
	// read-then-write하면 나중에 쓰는 쪽이 앞선 변경을 통째로 지운다.
	//
	// 커서는 draft가 들고 있던 스냅샷 값을 더 이상 쓰지 않는다 — 저장 직전에 디스크의
	// 현재 저장본과 (apiName, querys)가 정확히 일치하는 항목이 있으면 그 커서를 이어받고,
	// 없으면(조건을 조금이라도 고쳤다는 뜻) 0에서 새로 시작한다. "조건을 고치면 새
	// 구독"이라는 규칙을 저장 시점의 내용 비교만으로 구현한다(File.resolveSubscriptionCursor).
	private async persistSubscriptions(clickedDraft?: ApiDraft): Promise<boolean> {
		if (this.subscriptionsUnreadable) {
			new Notice(
				'저장된 구독을 읽지 못한 상태라 저장하지 않습니다 — 덮어쓰면 기존 구독이 사라집니다. Subscriptions.json을 확인하세요.',
			);
			return false;
		}
		if (clickedDraft && clickedDraft.conditions.length === 0) {
			new Notice('조건을 1개 이상 추가한 뒤 저장하세요.');
			return false;
		}

		// 조건이 1개 이상인 초안만 저장 대상이다 — 0개인 채로 저장하면 다음 수집이
		// "querys is empty"로 반드시 실패한다.
		const ready = this.apiDrafts.filter((draft) => draft.conditions.length > 0);

		// 개발자 도구로 드롭다운에 없는 필드명을 끼워 넣고 저장하면(9번, 실제 재현됨),
		// File.writeSubscriptions의 sanitizeQuerys가 그 조건만 조용히 걸러내고 나머지는
		// 저장했다 — 그런데 이 함수는 ready 전체를 "저장됨"으로 표시해서, 화면엔 걸러진
		// 조건까지 "저장됨" 배지가 붙은 채로 남았다(실제 디스크엔 없는데 UI만 저장된 것처럼
		// 보임). Notice로 알리고 마는 대신, 여기서 미리 검사해 하나라도 안 맞으면 저장
		// 자체를 통째로 거부한다 — 부분 저장을 허용하지 않는다.
		for (const draft of ready) {
			const invalid = ApiManagementModal.findInvalidCondition(draft);
			if (invalid) {
				new Notice(
					`${draft.apiName}의 "${invalid.searchType}" 조건이 이 출처가 지원하는 형식이 아닙니다 — ` +
						`그 조건을 지우고 다시 저장하세요. 저장이 취소되었습니다.`,
				);
				return false;
			}
		}

		// 같은 API+조건 조합이 두 개 이상이면 커서 갱신이 어느 쪽으로 갈지 모호해진다
		// (File.updateApiCursors의 .find()가 첫 매치만 고른다) — 저장 시점에 막는다.
		const readyIdentities = ready.map((draft) => ({
			apiName: draft.apiName,
			querys: draft.conditions.map((c): SearchQuery => ({ searchType: c.searchType, query: c.query })),
		}));
		if (File.hasDuplicateSubscription(readyIdentities)) {
			new Notice('이미 같은 API·조건 조합의 구독이 있습니다 — 조건을 다르게 하거나 기존 구독을 사용하세요.');
			return false;
		}

		try {
			await File.mutateSubscriptions((subscriptions) => {
				const previous = subscriptions.apis;
				subscriptions.apis = ready.map((draft) => {
					const api = File.createApi(
						draft.apiName,
						draft.conditions.map((c): SearchQuery => ({ searchType: c.searchType, query: c.query })),
					);
					api.updateTime = File.resolveSubscriptionCursor(previous, draft.apiName, api.querys);
					return api;
				});
			});
			// 실제로 디스크에 반영된 카드만 "저장됨"으로 표시한다 — ready에 안 낀(조건
			// 0개라 걸러진) 카드는 여전히 "등록하려는 중"으로 남아야 한다.
			for (const draft of ready) {
				draft.saved = true;
			}
			return true;
		} catch (e) {
			new Notice(`구독 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	// 카드 하나만 지운다 — persistSubscriptions()를 재사용하지 않는다: 그 함수는 조건
	// 1개 이상인 draft를 "전부" 저장하므로, 다른 카드가 아직 「저장」 전 편집 중이었다면
	// 이 삭제 하나 때문에 그 편집까지 같이 커밋돼버린다("저장 전까지는 디스크에 반영되지
	// 않는다"는 약속이 깨진다). 지우는 카드가 애초에 미저장(saved=false)이었다면 디스크에
	// 존재한 적이 없으므로 로컬에서만 지우면 끝이다.
	private async deleteApiDraft(api: ApiDraft): Promise<void> {
		this.apiDrafts = this.apiDrafts.filter((item) => item !== api);
		if (!api.saved) {
			this.render();
			return;
		}
		if (this.subscriptionsUnreadable) {
			new Notice(
				'저장된 구독을 읽지 못한 상태라 삭제를 반영하지 못했습니다 — Subscriptions.json을 확인하세요.',
			);
			this.render();
			return;
		}
		try {
			await File.mutateSubscriptions((subscriptions) => {
				subscriptions.apis = File.removeSubscription(subscriptions.apis, {
					apiName: api.apiName,
					querys: api.conditions.map((c): SearchQuery => ({ searchType: c.searchType, query: c.query })),
				});
			});
		} catch (e) {
			new Notice(`구독 삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
		this.render();
	}

	// apiDrafts를 apiName(수집 출처)별로 묶어 접을 수 있는 그룹으로 그린다. 같은 apiName에
	// 여러 구독(조건 묶음)을 등록할 수 있는데(위 "구독 추가" 주석 참고), 예전에는 그 카드들이
	// 화면에서 flat하게 나열돼 "이게 다 같은 출처인지" 한눈에 안 들어왔다는 피드백으로
	// 트리 구조로 바꿨다. Subscriptions.apis 자체는 여전히 flat 배열이라(File.ts 참고)
	// 데이터 모델은 안 바뀐다 — 순수하게 렌더링만 그룹 단위로 재구성한다.
	private renderSubscriptionGroups(containerEl: HTMLElement): void {
		const groups = new Map<string, ApiDraft[]>();
		for (const draft of this.apiDrafts) {
			const list = groups.get(draft.apiName) ?? [];
			list.push(draft);
			groups.set(draft.apiName, list);
		}
		if (groups.size === 0) {
			return;
		}

		// 그룹이 여럿일 때만 접기/펼치기가 의미 있다 — 하나뿐이면 항상 펼쳐진 것과 같다.
		if (groups.size > 1) {
			new Setting(containerEl)
				.addButton((button) =>
					button.setButtonText('전체 펼치기').onClick(() => {
						this.collapsedGroups.clear();
						this.render();
					}),
				)
				.addButton((button) =>
					button.setButtonText('전체 접기').onClick(() => {
						this.collapsedGroups = new Set(groups.keys());
						this.render();
					}),
				);
		}

		// File.supportedApiNames() 순서를 기준으로 정렬 — 렌더마다 Map 순회 순서가 흔들리지
		// 않게 고정한다(apiDrafts.push 순서에 기대면 삭제/재추가로 순서가 뒤섞일 수 있다).
		const orderedNames = File.supportedApiNames().filter((name) => groups.has(name));
		for (const apiName of orderedNames) {
			const drafts = groups.get(apiName);
			if (drafts) {
				this.renderSubscriptionGroup(containerEl, apiName, drafts);
			}
		}
	}

	private renderSubscriptionGroup(containerEl: HTMLElement, apiName: string, drafts: ApiDraft[]): void {
		const collapsed = this.collapsedGroups.has(apiName);
		const unsavedCount = drafts.filter((draft) => !draft.saved).length;

		const heading = new Setting(containerEl).setName(`${collapsed ? '▸' : '▾'} ${apiName}`).setHeading();
		heading.nameEl.createSpan({
			text:
				unsavedCount > 0
					? ` · 구독 ${drafts.length}개 · 저장 안 됨 ${unsavedCount}개`
					: ` · 구독 ${drafts.length}개`,
			attr: {
				style: 'font-size:0.8em; font-weight:normal; color: var(--text-muted); margin-left:6px;',
			},
		});
		// 헤더 행 전체를 클릭하면 접기/펼치기 — 이 헤더엔 다른 버튼이 없어 클릭 영역이
		// 겹칠 일이 없다(구독 삭제 등은 아래 카드 쪽에 있다).
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
		// 카드마다 자기 컨테이너를 따로 둔다 — 조건 추가/삭제처럼 이 카드 하나만 바뀌는
		// 변경은 renderApiDraft가 이 컨테이너만 다시 그리게 해서, 구독이 몇 개든 그 개수와
		// 무관하게 항상 "카드 하나 분량"의 비용만 든다(전체 모달 렉 수정 — 필드에 추가/
		// 조건 삭제를 누를 때마다 등록된 모든 구독·조건을 처음부터 다시 그리던 문제).
		//
		// ⚠️ wrapper에 반드시 클래스를 준다(스타일 없는 맨 div면 안 된다). Obsidian의
		// .setting-item은 border-top으로 항목을 구분하고 그 컨테이너의 첫 항목에서는
		// 그 선을 없애는데, 카드마다 wrapper가 생기면 각 카드의 첫 항목이 전부
		// "첫 항목"이 되어 카드 사이 구분선이 통째로 사라진다 — 실제로 그렇게 회귀했다
		// (카드 경계가 안 보이고 「조건 삭제」·「API 삭제」 버튼 열이 어긋나 보임).
		// styles.css의 .papergraph3d-subscription-card가 카드 자신의 경계를 그린다.
		for (const draft of drafts) {
			const cardEl = childContainer.createDiv({ cls: 'papergraph3d-subscription-card' });
			this.renderApiDraft(cardEl, draft);
		}
	}

	// containerEl은 이 카드 전용 div(위 renderSubscriptionGroup에서 만듦)다. 조건 추가/
	// 삭제 핸들러가 this.render()(전체 모달 재구성) 대신 이 함수를 자기 자신에게 다시
	// 불러 카드 하나만 갱신한다 — 그래서 재호출에도 안전하도록 맨 먼저 비운다.
	private renderApiDraft(containerEl: HTMLElement, api: ApiDraft): void {
		containerEl.empty();
		// 카드 제목은 이제 조건 요약이다 — apiName은 그룹 헤더가 이미 보여주므로 여기서
		// 또 반복하면 중복이다.
		const summary =
			api.conditions.length > 0
				? api.conditions
						.map(
							(c) => `${ApiManagementModal.conditionLabel(api.apiName, c.searchType)}:${c.query}`,
						)
						.join(' · ')
				: '(조건 없음)';
		const heading = new Setting(containerEl)
			.setName(summary)
			.setHeading()
			.addButton((button) =>
				button.setButtonText('API 삭제').onClick(() => {
					void this.deleteApiDraft(api);
				}),
			);
		// 진짜 구독(디스크와 일치)인지, 아직 「저장」 전인 등록 중인 카드인지 배지로
		// 구분한다 — 둘이 똑같이 생겨서 "이거 반영된 건가?"를 헷갈린다는 피드백으로 추가.
		heading.nameEl.createSpan({
			text: api.saved ? ' · 저장됨' : ' · 저장 안 됨 — 변경사항 있음',
			attr: {
				style: api.saved
					? 'font-size:0.8em; font-weight:normal; color: var(--text-muted); margin-left:6px;'
					: 'font-size:0.8em; font-weight:normal; color: var(--text-warning); margin-left:6px;',
			},
		});

		for (const condition of api.conditions) {
			new Setting(containerEl)
				.setName(
					`${ApiManagementModal.conditionLabel(api.apiName, condition.searchType)}: ${condition.query}`,
				)
				.addButton((button) =>
					// 로컬에서만 지운다 — 실제 반영은 아래 「저장」을 눌러야 한다.
					button.setButtonText('조건 삭제').onClick(() => {
						// 이미 저장돼 있던(saved===true) 카드를 지금 처음 건드리는 순간에만
						// 전체를 다시 그린다 — 「저장」/「구독 추가」 버튼의 표시 여부가
						// hasUnsavedDraft/unsavedDraft(모두 render()에서만 재계산됨)에 달려
						// 있어서, 카드만 좁혀 다시 그리면 이 전환을 못 알아챈다(실제 재현:
						// 저장된 구독의 조건을 지워도 「저장」 버튼이 안 뜸). 이미 저장 안
						// 된 카드를 계속 편집하는 동안은(가장 흔한 경우) 그 값이 이미
						// false라 좁힌 재렌더로 충분하다.
						const wasSaved = api.saved;
						api.conditions = api.conditions.filter((item) => item !== condition);
						api.saved = false;
						if (wasSaved) {
							this.render();
						} else {
							this.renderApiDraft(containerEl, api);
						}
					}),
				);
		}

		// 이미 상한(3개)을 채웠으면 더 추가할 수 없으니 버튼 자체를 안 그린다 — 눌러도
		// Notice로 막히기만 하는 죽은 버튼을 남겨두지 않는다.
		if (api.conditions.length >= MAX_CONDITIONS_PER_API) {
			return;
		}

		const descriptor = findDescriptor(api.apiName);
		const fields = descriptor?.conditionFields ?? [];

		new Setting(containerEl)
			.setName('조건 추가')
			.setDesc(`${api.apiName}에 동시에 구독할 조건을 추가합니다 (최대 ${MAX_CONDITIONS_PER_API}개, 전부 AND). 여러 개를 모은 뒤 맨 아래 「저장」으로 한 번에 반영하세요.`)
			.addDropdown((dropdown) => {
				for (const field of fields) {
					dropdown.addOption(field.name, field.label);
				}
				return dropdown.setValue(api.newConditionType).onChange((value) => {
					api.newConditionType = value;
				});
			})
			.addText((text) =>
				text.setPlaceholder('조건 값').onChange((value) => {
					api.newConditionQuery = value;
				}),
			)
			.addButton((button) =>
				button.setButtonText('필드에 추가').onClick(() => {
					if (api.newConditionQuery.trim().length === 0) {
						return;
					}
					// trim().length===0만으로는 안 걸러진다 — ""나 " "처럼 따옴표/공백만
					// 있는 값은 원본 문자열 길이가 0이 아니라서 위 검사를 통과한다. 실제로
					// 전송될 값(formatTerm이 따옴표를 제거한 뒤의 값) 기준으로 다시 검사해야
					// 이 값들이 걸린다 — SearchQuery.hasMeaningfulQueryValue와 같은 기준을
					// 여기서도 써서, 수집이 실제로 돌기 전 저장 단계에서부터 막는다.
					if (!hasMeaningfulQueryValue(api.newConditionQuery)) {
						new Notice('검색어에 실제 내용(글자/숫자)이 있어야 합니다.');
						return;
					}
					// 필드마다 값 형식이 다를 수 있다(예: arXiv의 분류는 따옴표로 못 감싸
					// 값 자체가 쿼리 문법이 된다) — 그 기준은 이 출처의 ConditionField가
					// 안다. 저장 시점 화이트리스트(File.sanitizeQuerys)가 어차피 걸러내는데,
					// 여기서 안 막으면 사용자는 "추가됐다가 저장하니 사라진" 것처럼 본다.
					// 같은 검증 함수로 즉시 거부한다.
					const field = fields.find((f) => f.name === api.newConditionType);
					if (field && !field.validate(api.newConditionQuery.trim())) {
						new Notice(`${field.label} 값의 형식이 올바르지 않습니다.`);
						return;
					}
					// 상한(3개) 도달 시 이 버튼 자체가 안 그려지므로(위 가드) 여기선 항상
					// 여유가 있다.
					//
					// 조건 삭제 핸들러와 같은 이유로 wasSaved를 본다 — saved===true였던
					// 카드를 지금 처음 건드리는 전환 순간에만 전체를 다시 그려 「저장」
					// 버튼이 뜨게 한다(실제 재현: 저장된 구독에 조건을 추가해도 안 뜸).
					const wasSaved = api.saved;
					api.conditions.push({
						searchType: api.newConditionType,
						query: api.newConditionQuery.trim(),
					});
					api.newConditionQuery = '';
					api.saved = false;
					// 로컬에서만 쌓는다 — 디스크 반영은 맨 아래 「저장」 버튼으로 한 번에
					// (render() 끝의 단일 저장 버튼 참고 — 카드마다 두지 않는다). 이미
					// 저장 안 된 카드를 계속 편집하는 동안은(가장 흔한 경우) 카드만 다시
					// 그려 등록된 다른 구독이 많아도 이 클릭 비용은 항상 일정하다.
					if (wasSaved) {
						this.render();
					} else {
						this.renderApiDraft(containerEl, api);
					}
				}),
			);
	}
}
