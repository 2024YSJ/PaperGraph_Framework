import { App, Modal, Notice, Setting } from 'obsidian';
import { File } from '../common/File';
import { SearchQuery } from '../collect/SearchQuery';
import { S2_SECRET_PROVIDER } from '../collect/API';
import { identifyKeyProvider, validateAllKeys } from '../collect/SecretValidation';

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
	// 이 구독의 수집 커서(API.updateTime). persistSubscriptions가 apiDrafts로부터 API
	// 인스턴스를 다시 만들 때 그대로 실어 보내야 한다 — 안 그러면 File.createApi가 만든
	// 새 인스턴스가 기본값 0으로 시작해, UI에서 조건 하나만 고쳐도 그 구독의 진행 상황이
	// 전부 사라지고 처음부터 다시 훑게 된다.
	updateTime: number;
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
	private apiKeyDraft = '';
	private apiNameDraft = '';
	private apiDrafts: ApiDraft[] = [];
	private subscriptionsLoaded = false;
	// 저장된 구독을 읽지 못한 상태인가. 읽기에 실패했는데 저장을 허용하면, 화면의 빈
	// 목록이 그대로 디스크를 덮어써 읽지 못했을 뿐 멀쩡히 있던 구독이 사라진다.
	private subscriptionsUnreadable = false;

	constructor(app: App) {
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
					'사용자와 한도를 나눠 써서 요청이 자주 막힙니다. 어느 provider의 키인지는 저장 ' +
					'시 실제 요청으로 자동 판별하므로, 여러 provider의 키를 하나씩 붙여넣고 ' +
					'저장하면 됩니다.',
			)
			.setHeading();

		new Setting(contentEl)
			.setName('키 등록')
			.setDesc(
				this.subscriptionsLoaded && this.apiKeyDraft.length === 0
					? '등록된 키가 없습니다.'
					: '',
			)
			.addText((text) =>
				text
					.setPlaceholder('API 키 입력')
					.setValue(this.apiKeyDraft)
					.onChange((value) => {
						this.apiKeyDraft = value;
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('저장')
					.setCta()
					.onClick(() => {
						button.setDisabled(true);
						void this.persistApiKey()
							.then(() => new Notice('API 키를 저장했습니다.'))
							.catch((e: unknown) => {
								new Notice(`API 키 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
							})
							.finally(() => button.setDisabled(false));
					}),
			)
			// 등록된 키가 실제로 통하는지 가벼운 요청으로 확인한다 — 형식 검사로는 어떤
			// provider의 키인지도, 유효한지도 판별할 수 없어 실제 호출만이 신뢰할 수 있는
			// 방법이다(SecretValidation.ts 참고). 저장은 안 건드리고 조회만 한다.
			.addButton((button) =>
				button.setButtonText('키 확인').onClick(async () => {
					button.setDisabled(true);
					try {
						const secret = await File.readSecret();
						const results = await validateAllKeys(secret);
						if (results.length === 0) {
							new Notice('확인할 키가 등록돼 있지 않습니다.');
							return;
						}
						for (const result of results) {
							if (result.valid) {
								new Notice(`${result.provider} 키가 정상 동작합니다.`);
							} else if (result.reason === 'invalid-key') {
								new Notice(`${result.provider} 키가 유효하지 않습니다 — 키를 다시 확인하세요.`);
							} else {
								new Notice(`${result.provider} 키 확인 중 오류: ${result.detail ?? '알 수 없음'}`);
							}
						}
					} catch (e) {
						new Notice(`키 확인 실패: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						button.setDisabled(false);
					}
				}),
			);

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

		new Setting(contentEl)
			.setName('API 추가')
			.setDesc('구독 조건을 묶을 API를 목록에서 고릅니다. 새 API 지원은 코드에 등록하면 목록에 나타납니다.')
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
					.onClick(() => {
						if (this.apiNameDraft.length === 0) {
							return;
						}
						// 같은 API를 여러 번 추가하는 것은 허용한다 — 구독 하나 = API 인스턴스
						// 하나이고, 같은 arXiv에 서로 다른 조건 묶음을 거는 건 정당한 사용이다.
						this.apiDrafts.push({
							apiName: this.apiNameDraft,
							conditions: [],
							newConditionType: 'keyword',
							newConditionQuery: '',
							updateTime: 0, // 새 구독 — 아직 수집한 적 없음
						});
						// 여기서는 수집을 걸지 않는다 — 방금 추가한 API는 조건이 0개라
						// 수집하면 "querys is empty"로 반드시 실패한다. 조건이 하나라도
						// 붙는 시점(조건 추가)에 예약한다.
						void this.persistSubscriptions();
						this.render();
					}),
			);

		for (const api of this.apiDrafts) {
			this.renderApiDraft(contentEl, api);
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
				updateTime: api.updateTime,
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

		// 이미 등록된 S2 키가 있으면 빈칸 대신 그대로 보여준다 — 안 그러면 등록해놓고도
		// 다시 열 때마다 "비어 있나?" 헷갈린다. 평문으로 보여주는 것은 이 vault 밖으로
		// 안 나가는 로컬 값이라는 판단이다.
		try {
			const secret = await File.readSecret();
			this.apiKeyDraft = secret.getKey(S2_SECRET_PROVIDER) ?? '';
		} catch (e) {
			new Notice(`API 키를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}

		this.subscriptionsLoaded = true;
		this.render();
	}

	// apiKeyDraft -> Secret.json. 입력란이 하나뿐이라도 provider별로 나눠 저장한다 —
	// identifyKeyProvider()가 등록된 KeyValidator들에 실제로 물어봐 이 키가 어느 provider
	// 것인지 판별한다(형식만으로는 구분 불가 — SecretValidation.ts 참고). 어느 provider에도
	// 안 맞으면 잘못된 키로 보고 저장하지 않는다. 현재 저장본을 읽어 그 provider 항목만
	// 갈아끼운다 — 그대로 새 Secret()을 써서 저장하면 다른 provider의 키까지 날아간다.
	// 실패 시 호출부가 처리하도록 그대로 throw한다(성공 Notice를 잘못 띄우지 않기 위해
	// 여기서 삼키지 않는다).
	private async persistApiKey(): Promise<void> {
		const key = this.apiKeyDraft.trim();
		const provider = await identifyKeyProvider(key);
		if (provider === undefined) {
			throw new Error('등록된 provider(Semantic Scholar 등) 중 어디에도 맞지 않는 키입니다.');
		}
		const secret = await File.readSecret();
		secret.setKey(provider, key);
		await File.writeSecret(secret);
	}

	// apiDrafts -> Subscriptions.json. 현재 저장본을 읽어와 apis만 갈아끼운다.
	//
	// File.mutateSubscriptions로 읽기-수정-쓰기를 큐에 태운다 — 수집이 막 끝나며
	// File.updateApiCursors가 같은 파일을 읽고 쓰는 시점과 겹칠 수 있는데, 직접
	// read-then-write하면 나중에 쓰는 쪽이 앞선 변경을 통째로 지운다.
	//
	// draft.updateTime을 새로 만든 API 인스턴스에 그대로 실어야 한다 — File.createApi가
	// 만드는 인스턴스는 기본값 0으로 시작하므로, 이걸 빼먹으면 조건 하나만 고쳐도 그
	// 구독의 커서(수집 진행 상황)가 사라지고 처음부터 다시 훑게 된다. loadSubscriptions가
	// draft를 만들 때 이미 저장된 updateTime을 담아 두고, 여기서는 그 값을 그대로 돌려준다.
	private async persistSubscriptions(): Promise<void> {
		if (this.subscriptionsUnreadable) {
			new Notice(
				'저장된 구독을 읽지 못한 상태라 저장하지 않습니다 — 덮어쓰면 기존 구독이 사라집니다. Subscriptions.json을 확인하세요.',
			);
			return;
		}
		try {
			await File.mutateSubscriptions((subscriptions) => {
				subscriptions.apis = this.apiDrafts.map((draft) => {
					const api = File.createApi(
						draft.apiName,
						draft.conditions.map((c): SearchQuery => ({ searchType: c.searchType, query: c.query })),
					);
					api.updateTime = draft.updateTime;
					return api;
				});
			});
		} catch (e) {
			new Notice(`구독 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private renderApiDraft(containerEl: HTMLElement, api: ApiDraft): void {
		new Setting(containerEl)
			.setName(api.apiName)
			.setHeading()
			.addButton((button) =>
				// 삭제는 수집을 걸지 않는다 — 훑을 대상이 줄어드는 변경이라 새로 받아올 게 없다.
				button.setButtonText('API 삭제').onClick(() => {
					this.apiDrafts = this.apiDrafts.filter((item) => item !== api);
					void this.persistSubscriptions();
					this.render();
				}),
			);

		for (const condition of api.conditions) {
			new Setting(containerEl)
				.setName(`${CONDITION_TYPE_LABEL[condition.searchType] ?? condition.searchType}: ${condition.query}`)
				.addButton((button) =>
					button.setButtonText('조건 삭제').onClick(() => {
						api.conditions = api.conditions.filter((item) => item !== condition);
						void this.persistSubscriptions();
						this.render();
					}),
				);
		}

		new Setting(containerEl)
			.setName('조건 추가')
			.setDesc(`${api.apiName}에 동시에 구독할 조건을 추가합니다 (최대 ${MAX_CONDITIONS_PER_API}개, 전부 AND).`)
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
				button.setButtonText('추가').onClick(() => {
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
					void this.persistSubscriptions();
					this.render();
				}),
			);
	}
}
