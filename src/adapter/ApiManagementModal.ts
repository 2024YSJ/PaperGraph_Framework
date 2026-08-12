import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { FailureNotifier } from '../common/Notify';
import { SearchQuery } from '../collect/SearchQuery';
import { KEY_VALIDATORS } from '../collect/SecretValidation';

// 조건 타입은 SearchQuery.searchType(string)의 구체적인 값들.
// 여기 값은 API.ts의 ARXIV_FIELD_PREFIX 키와 반드시 일치해야 한다 — 예전에 이 타입만
// 'domain'으로 남아 있어서, UI로 그 조건을 만들면 formatTerm()이
// "Unknown searchType"으로 throw하고 [1] 정책에 따라 해당 구독 수집 전체가 실패했다.
type ConditionType = 'keyword' | 'author' | 'category';

const CONDITION_TYPE_LABEL: Record<ConditionType, string> = {
	keyword: '키워드',
	author: '저자',
	category: '분류',
};

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
	// 만든 카드는 true로 시작하고, 「API 추가」로 만든 새 카드나 조건을 고친 카드는 false로
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
							.then(({ provider, valid, detail }) => {
								if (valid) {
									new Notice(`${provider} 키를 저장하고 확인했습니다 — 정상 동작합니다.`);
								} else {
									new Notice(
										`${provider} 키를 저장했습니다. 다만 확인 중 문제가 있었습니다: ` +
											`${detail ?? '알 수 없음'} — 나중에 다시 확인하세요.`,
									);
								}
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

		// ── 등록된 키 목록 (조회/수정/삭제) ──────────────────────────────
		const providers = Object.keys(this.registeredKeys);
		if (this.subscriptionsLoaded && providers.length === 0) {
			new Setting(contentEl).setDesc('등록된 키가 없습니다.');
		}
		for (const provider of providers) {
			new Setting(contentEl)
				.setName(provider)
				.setDesc(this.registeredKeys[provider] ?? '')
				.addButton((button) =>
					// 폼에 그대로 불러온다 — 다시 저장을 누르면 즉시 재검증까지 겸한 수정이 된다.
					button.setButtonText('수정').onClick(() => {
						this.apiKeyProviderDraft = provider;
						this.apiKeyValueDraft = this.registeredKeys[provider] ?? '';
						this.render();
					}),
				)
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
				'등록된 구독이 없습니다. 아래에서 API를 추가해 수집할 조건을 설정하세요.',
			);
		}

		// 저장 안 된(unsaved) 카드가 이미 있으면 새로 추가하지 않는다 — 구독 추가는 한
		// 번에 하나씩만: 미저장 카드가 여러 개 쌓이면 「조건 추가 + 저장」 세트가 화면에
		// 반복돼 지금 어느 카드를 마무리해야 하는지 헷갈린다는 피드백으로 막았다. 먼저
		// 그 카드를 저장하거나 지워야 다음 카드를 추가할 수 있다.
		const hasUnsavedDraft = this.apiDrafts.some((draft) => !draft.saved);
		new Setting(contentEl)
			.setName('API 추가')
			.setDesc(
				hasUnsavedDraft
					? '저장하지 않은 구독이 있습니다. 먼저 그 구독을 저장하거나 삭제해야 새 구독을 추가할 수 있습니다.'
					: '구독 조건을 묶을 API를 목록에서 고릅니다. 새 API 지원은 코드에 등록하면 목록에 나타납니다.',
			)
			.addDropdown((dropdown) => {
				// 지원 목록은 File의 API 레지스트리가 진실이다 — 이름을 손으로 치게 하면
				// 'arXiv' 같은 오타가 저장을 통과하고 다음 수집(createApi)에서야 터진다.
				const names = File.supportedApiNames();
				for (const name of names) {
					dropdown.addOption(name, name);
				}
				// 첫 렌더는 loadSubscriptions()가 끝나기 전이라 draft가 비어 있을 수 있다.
				// 그대로 두면 드롭다운은 첫 옵션을 보여주는데 내부 값만 ''이라, 사용자가
				// 'arxiv'를 보면서 추가를 눌러도 아래 길이 검사에 걸려 아무 일도 안 일어난다.
				if (this.apiNameDraft.length === 0) {
					this.apiNameDraft = names[0] ?? '';
				}
				dropdown.setValue(this.apiNameDraft).onChange((value) => {
					this.apiNameDraft = value;
				});
			})
			.addButton((button) =>
				button
					.setButtonText('추가')
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
							newConditionType: 'keyword',
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
					searchType: query.searchType as ConditionType,
					query: query.query,
				})),
				newConditionType: 'keyword',
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
	// invalid-key(401/403 등 명확히 틀린 키)면 저장을 막는다 — 잘못 저장하면 다음 보강
	// 요청마다 같은 실패가 반복된다. network-error(일시적 문제일 수 있음)는 저장은 하되
	// 결과를 그대로 호출자에게 돌려줘 Notice로 알리게 한다 — 오프라인일 때도 키 등록
	// 자체는 막지 않기 위함이다.
	private async persistApiKey(): Promise<{
		provider: string;
		valid: boolean;
		detail?: string;
	}> {
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
		if (!result.valid && result.reason === 'invalid-key') {
			throw new Error(`${provider} 키가 유효하지 않습니다 — 저장하지 않았습니다.`);
		}
		const secret = await File.readSecret();
		secret.setKey(provider, key);
		await File.writeSecret(secret);
		this.registeredKeys[provider] = key;
		return { provider, valid: result.valid, detail: result.detail };
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
	// 여러 구독(조건 묶음)을 등록할 수 있는데(위 "API 추가" 주석 참고), 예전에는 그 카드들이
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
		for (const draft of drafts) {
			this.renderApiDraft(childContainer, draft);
		}
	}

	private renderApiDraft(containerEl: HTMLElement, api: ApiDraft): void {
		// 카드 제목은 이제 조건 요약이다 — apiName은 그룹 헤더가 이미 보여주므로 여기서
		// 또 반복하면 중복이다.
		const summary =
			api.conditions.length > 0
				? api.conditions
						.map((c) => `${CONDITION_TYPE_LABEL[c.searchType] ?? c.searchType}:${c.query}`)
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
				.setName(`${CONDITION_TYPE_LABEL[condition.searchType] ?? condition.searchType}: ${condition.query}`)
				.addButton((button) =>
					// 로컬에서만 지운다 — 실제 반영은 아래 「저장」을 눌러야 한다.
					button.setButtonText('조건 삭제').onClick(() => {
						api.conditions = api.conditions.filter((item) => item !== condition);
						api.saved = false;
						this.render();
					}),
				);
		}

		new Setting(containerEl)
			.setName('조건 추가')
			.setDesc(`${api.apiName}에 동시에 구독할 조건을 추가합니다 (최대 ${MAX_CONDITIONS_PER_API}개, 전부 AND). 여러 개를 모은 뒤 맨 아래 「저장」으로 한 번에 반영하세요.`)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('keyword', CONDITION_TYPE_LABEL.keyword)
					.addOption('author', CONDITION_TYPE_LABEL.author)
					.addOption('category', CONDITION_TYPE_LABEL.category)
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
				button.setButtonText('필드에 추가').onClick(() => {
					if (api.newConditionQuery.trim().length === 0) {
						return;
					}
					// 004의 결합 규칙 — 한 구독의 조건은 최대 3개, 전부 AND.
					if (api.conditions.length >= MAX_CONDITIONS_PER_API) {
						new Notice(`조건은 API당 최대 ${MAX_CONDITIONS_PER_API}개까지 등록할 수 있습니다.`);
						return;
					}
					api.conditions.push({
						searchType: api.newConditionType,
						query: api.newConditionQuery.trim(),
					});
					api.newConditionQuery = '';
					api.saved = false;
					// 로컬에서만 쌓는다 — 디스크 반영은 맨 아래 「저장」 버튼으로 한 번에
					// (render() 끝의 단일 저장 버튼 참고 — 카드마다 두지 않는다).
					this.render();
				}),
			);
	}
}
