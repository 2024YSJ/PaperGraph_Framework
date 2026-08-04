import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { PipelineTestModal } from './PipelineTestModal';
import { FileTestModal } from './FileTestModal';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';

// 임베딩 스트레스 테스트용 모의 논문 생성. 초록 길이를 문서마다 1~20배로 바꿔서
// LENGTH_BUCKETS([128,256,512]) 세 버킷을 전부 실제로 밟아보게 한다 — 100편은
// INFERENCES_PER_SESSION(64)을 넘겨 세션 재생성 경로까지 exercise한다
// (docs/devLog/003-embedding-model.md의 메모리 방어 5단계 검증 목적).
const MOCK_SENTENCE =
	'This mock abstract paragraph discusses neural embeddings, citation graphs, and retrieval benchmarks in scientific literature. ';
const EMBEDDING_TEST_FOLDER = 'embedding_test';

// Paper 필드를 전부 채운 완전한 객체로 만든다 — File.writeTestPaper가 그대로
// .json(원본)+.md(뷰)로 저장할 수 있어야 하므로 FileTestModal의 테스트 Paper 생성
// 방식과 동일하게 맞춘다.
function buildMockPaper(index: number): Paper {
	const repeats = 1 + (index % 20);
	const paper = new Paper();
	paper.title = `Mock Paper ${index + 1}: A Study of Embedding Stability`;
	paper.authors = [];
	paper.abstract = MOCK_SENTENCE.repeat(repeats);
	paper.sourceId = `test:embedding-mock-${index + 1}`;
	paper.references = [];
	paper.publicationDate = '';
	paper.citationCount = 0;
	paper.citationsKnown = false;
	paper.collectedApi = '';
	paper.collectedQuery = { searchType: '', query: '' };
	paper.embedding = [];
	paper.embeddingModel = '';
	paper.embeddingSource = '';
	paper.embeddingSucceeded = false;
	return paper;
}

// 날짜 입력(YYYY-MM-DD)을 timestamp(ms)로 변환. 비어있거나 잘못된 값이면 undefined —
// 어차피 아직 CollectAndSave.run()이 스텁이라 값 자체는 쓰이지 않지만, 구현되는 즉시
// 그대로 넘길 수 있도록 형식만 맞춰둔다.
function parseDateInput(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

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
// 실제 저장은 PaperStore/SecretStore/Secret/Subscriptions/API 구현이 끝난 뒤 TODO 부분에서 연결한다.
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
			.setName('파이프라인 테스트')
			.setDesc(
				'각 단계가 구현되는 대로 담당자가 바로 확인할 수 있도록 만든 임시 버튼입니다. ' +
					'아직 미구현인 단계는 클릭 시 "아직 구현되지 않음" 알림이 뜹니다. (임베딩은 아래 항목의 확인/설치 버튼으로 테스트하세요.)',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('수집')
			.setDesc('입력창에서 값을 받아 CollectAndSave.run()을 모드별로 실행합니다.')
			.addButton((button) =>
				button.setButtonText('최근 논문').onClick(() => {
					new PipelineTestModal(
						this.app,
						'수집 테스트 — 최근 논문',
						[
							{
								key: 'hours',
								label: '최근 몇 시간',
								desc: 'API.SearchRecentPaper(hours)에 대응',
								type: 'number',
								defaultValue: '24',
							},
						],
						async (values) => {
							const hours = Number(values.hours);
							try {
								await this.plugin.collectflow.run('recent', {
									hours: Number.isNaN(hours) ? undefined : hours,
								});
							} catch {
								new Notice('아직 구현되지 않음: 수집(최근 논문)');
							}
						},
					).open();
				}),
			)
			.addButton((button) =>
				button.setButtonText('Backfill').onClick(() => {
					new PipelineTestModal(
						this.app,
						'수집 테스트 — Backfill',
						[
							{ key: 'from', label: '시작일', desc: 'API.Backfill(from, to)의 from', type: 'date' },
							{ key: 'to', label: '종료일', desc: 'API.Backfill(from, to)의 to', type: 'date' },
						],
						async (values) => {
							try {
								await this.plugin.collectflow.run('backfill', {
									from: parseDateInput(values.from ?? ''),
									to: parseDateInput(values.to ?? ''),
								});
							} catch {
								new Notice('아직 구현되지 않음: 수집(Backfill)');
							}
						},
					).open();
				}),
			);

		new Setting(containerEl)
			.setName('저장 (File)')
			.setDesc('입력창에서 값을 받아 File의 쓰기 함수를 호출합니다.')
			.addButton((button) =>
				button.setButtonText('Secret').onClick(async () => {
					// Secret은 아직 필드가 없는 빈 클래스라 입력창 없이 바로 호출한다.
					try {
						await File.writeSecret(new Secret());
					} catch {
						new Notice('아직 구현되지 않음: 저장(Secret)');
					}
				}),
			)
			.addButton((button) =>
				button.setButtonText('Subscriptions').onClick(() => {
					new PipelineTestModal(
						this.app,
						'저장 테스트 — Subscriptions',
						[
							{
								key: 'updateTime',
								label: '갱신 시점 (timestamp, ms)',
								type: 'number',
								defaultValue: String(Date.now()),
							},
						],
						async (values) => {
							try {
								const subscriptions = new Subscriptions();
								const updateTime = Number(values.updateTime);
								subscriptions.updateTime = Number.isNaN(updateTime) ? Date.now() : updateTime;
								subscriptions.secret = new Secret();
								subscriptions.apis = [];
								await File.writeSubscriptions(subscriptions);
							} catch {
								new Notice('아직 구현되지 않음: 저장(Subscriptions)');
							}
						},
					).open();
				}),
			)
			.addButton((button) =>
				button.setButtonText('Paper').onClick(() => {
					new PipelineTestModal(
						this.app,
						'저장 테스트 — Paper',
						[
							{ key: 'title', label: '제목', type: 'text', defaultValue: '테스트 논문' },
							{ key: 'sourceId', label: 'Source ID', type: 'text', defaultValue: 'settings-test-paper' },
						],
						async (values) => {
							try {
								const paper = new Paper();
								paper.title = values.title ?? '테스트 논문';
								paper.authors = [];
								paper.abstract = '';
								paper.sourceId = values.sourceId ?? 'settings-test-paper';
								paper.references = [];
								paper.publicationDate = '';
								paper.citationCount = 0;
								paper.citationsKnown = false;
								paper.collectedApi = '';
								paper.collectedQuery = { searchType: '', query: '' };
								paper.embedding = [];
								paper.embeddingModel = '';
								paper.embeddingSource = '';
								paper.embeddingSucceeded = false;
								await File.writePaper(paper);
							} catch {
								new Notice('아직 구현되지 않음: 저장(Paper)');
							}
						},
					).open();
				}),
			);

		new Setting(containerEl)
			.setName('File 테스트')
			.setDesc('논문 / Secret / Subscriptions 저장을 한 창에서 각각 테스트합니다.')
			.addButton((button) =>
				button
					.setButtonText('File 테스트')
					.setCta()
					.onClick(() => {
						new FileTestModal(this.app).open();
					}),
			);

		new Setting(containerEl)
			.setName('PCA')
			.setDesc('PCA 클래스에 아직 함수가 정의되지 않아 테스트 버튼이 없습니다 (다예 담당, 3순위).');

		new Setting(containerEl)
			.setName('시각화')
			.setDesc('시각화 뷰를 열어 init/render/전체 실행을 단계별로 테스트합니다.')
			.addButton((button) =>
				button.setButtonText('시각화 뷰 열기').onClick(() => {
					void this.plugin.activateVisualizationView();
				}),
			);

		new Setting(containerEl)
			.setName('API 키')
			.setDesc('Semantic Scholar 등 외부 API 키 (임시 UI — 아직 저장되지 않습니다)')
			.addText((text) =>
				text
					.setPlaceholder('API 키 입력')
					.setValue(this.apiKeyDraft)
					.onChange((value) => {
						this.apiKeyDraft = value;
						// TODO: File/Secret 구현 후 File.writeSecret(...)로 연결
					}),
			);

		new Setting(containerEl)
			.setName('임베딩 모델')
			.setDesc(
				'specter2(8bit 양자화) 모델을 GitHub Release에서 받아 온디바이스로 씁니다. ' +
					'설치 전에는 임베딩이 임시(해시 기반) 벡터로 대체됩니다.',
			)
			.addButton((button) =>
				button.setButtonText('확인').onClick(async () => {
					try {
						const installed = await this.plugin.collectflow.embedding.isModelInstalled();
						new Notice(
							installed ? '임베딩 모델이 설치되어 있습니다.' : '임베딩 모델이 설치되어 있지 않습니다.',
						);
					} catch (error) {
						new Notice(`임베딩 모델 확인 실패: ${String(error)}`);
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('설치')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						const notice = new Notice('임베딩 모델 설치 중...', 0);
						try {
							await this.plugin.collectflow.embedding.installModel((progress) => {
								notice.setMessage(
									`임베딩 모델 설치 중... (${progress.fileIndex}/${progress.fileCount}) ${progress.fileName}`,
								);
							});
							notice.hide();
							new Notice('임베딩 모델 설치 완료');
						} catch (error) {
							notice.hide();
							new Notice(`임베딩 모델 설치 실패: ${String(error)}`);
						} finally {
							button.setDisabled(false);
						}
					}),
			)
			.addButton((button) =>
				button.setButtonText('테스트 (100개)').onClick(async () => {
					button.setDisabled(true);
					const total = 100;
					const notice = new Notice(`임베딩 테스트 중... (0/${total})`, 0);
					const startedAt = Date.now();
					let succeeded = 0;
					let failed = 0;
					try {
						for (let i = 0; i < total; i++) {
							const paper = buildMockPaper(i);
							const result = await this.plugin.collectflow.embedding.embed(
								paper.title,
								paper.abstract,
							);
							if (result.embeddingSucceeded) {
								succeeded += 1;
							} else {
								failed += 1;
							}

							// .md(문서)와 .json(임베딩 포함 원본)을 한 번에 저장한다. .md는 임베딩
							// 벡터를 담지 않으므로 임베딩 전/후로 두 번 나눠 쓸 이유가 없고, 두 번
							// 쓰면 재실행 시 "임베딩 전" 저장이 이전 실행의 정상 결과를 일시적으로
							// 지웠다가 복구하는 창이 생겨 중단 시 데이터가 빈 값으로 남을 수 있었다.
							Object.assign(paper, result);
							await File.writeTestPaper(paper, EMBEDDING_TEST_FOLDER);

							notice.setMessage(
								`임베딩 테스트 중... (${i + 1}/${total}) 성공 ${succeeded} / 실패 ${failed}`,
							);
						}
						const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
						notice.hide();
						new Notice(
							`임베딩 테스트 완료: 성공 ${succeeded}개 / 실패(임시 벡터로 대체) ${failed}개 (${elapsedSec}초)`,
							0,
						);
					} catch (error) {
						notice.hide();
						new Notice(`임베딩 테스트 중 오류: ${String(error)}`);
					} finally {
						button.setDisabled(false);
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
						// TODO: File/Subscriptions/API 구현 후 File.writeSubscriptions(...)로 연결
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
					// TODO: Subscriptions/API 구현 후 SecretStore.writeSubscriptions(...)로 연결
					this.display();
				}),
			);
	}
}
