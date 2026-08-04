import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { PipelineTestModal } from './PipelineTestModal';
import { FileTestModal } from './FileTestModal';
import { CollectResultModal } from './CollectResultModal';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';
import { ArxivAPI, S2_SECRET_PROVIDER } from '../collect/API';

// 임베딩 스트레스 테스트용 모의 논문 생성. 실제 arXiv cs.CL/cs.LG/cs.AI 최신 100편 초록의
// 단어 수 분포(실측: 최소 63, 최대 302, 평균 193단어)를 참고해 문서마다 문장 수를
// 크게 흔들어서 그 범위를 폭넓게 커버한다. 고정 문장을 반복하는 대신 어휘/문형을 섞어
// 실제 논문처럼 매번 다른 텍스트가 나오게 한다 — 반복 문자열은 토큰 분포가 지나치게
// 단조로워 LENGTH_BUCKETS([128,256,512])는 밟아도 어휘 다양성은 검증하지 못했다.
// 100편은 INFERENCES_PER_SESSION(64)도 넘겨 세션 재생성 경로까지 exercise한다
// (docs/devLog/003-embedding-model.md의 메모리 방어 5단계 검증 목적).
const EMBEDDING_TEST_FOLDER = 'embedding_test';

const MOCK_TOPIC_WORDS = [
	'neural', 'network', 'transformer', 'attention', 'embedding', 'representation',
	'optimization', 'gradient', 'encoder', 'decoder', 'convolutional', 'recurrent',
	'graph', 'citation', 'retrieval', 'benchmark', 'dataset', 'evaluation', 'inference',
	'generalization', 'regularization', 'pretraining', 'tokenization', 'multimodal',
	'reasoning', 'alignment', 'robustness', 'scalability', 'efficiency', 'clustering',
	'classification', 'segmentation', 'detection', 'generation', 'sampling',
	'distillation', 'quantization', 'sparsity', 'latent', 'variational', 'adversarial',
	'contrastive', 'zero-shot', 'few-shot', 'transfer', 'domain', 'language', 'vision',
	'speech', 'reinforcement', 'policy', 'reward', 'agent', 'planning', 'memory',
	'context', 'sequence', 'prediction', 'uncertainty', 'scaling', 'architecture',
	'annotation', 'supervision', 'curriculum', 'augmentation', 'interpretability',
] as const;

const MOCK_SENTENCE_TEMPLATES = [
	'We propose a novel {a} approach for {b} that improves {c} across multiple {d} tasks.',
	'This work investigates the relationship between {a} and {b} in large-scale {c} systems.',
	'Recent advances in {a} have enabled significant progress on {b}, yet {c} remains challenging.',
	'Our method combines {a} with {b} to achieve state-of-the-art {c} on standard {d} benchmarks.',
	'We introduce a {a} framework that jointly optimizes {b} and {c} without additional {d}.',
	'Experiments on {a} and {b} datasets demonstrate consistent improvements in {c} and {d}.',
	'We analyze how {a} affects {b} under varying levels of {c}, revealing new insights into {d}.',
	'Unlike prior {a} methods, our approach leverages {b} to better capture {c} in {d} settings.',
] as const;

const MOCK_TITLE_TEMPLATES = [
	'{a} {b}: A {c} Approach to {d}',
	'Towards {a} {b} via {c} {d}',
	'Rethinking {a} for {b} with {c} {d}',
	'{a}-{b}: Scalable {c} for {d}',
] as const;

function pickMockWord(seed: number): string {
	const index = Math.abs(seed) % MOCK_TOPIC_WORDS.length;
	const word = MOCK_TOPIC_WORDS[index];
	if (word === undefined) {
		throw new Error('unreachable: MOCK_TOPIC_WORDS index out of range');
	}
	return word;
}

function fillTemplate(template: string, seed: number): string {
	let slot = 0;
	return template.replace(/\{[a-d]\}/g, () => {
		slot += 1;
		return pickMockWord(seed * 7 + slot * 131);
	});
}

function buildMockAbstract(index: number): string {
	// 4~18문장(템플릿당 대략 15~20단어) -> 대략 60~330단어, 실측 분포(63~302, 평균 193)를
	// 넉넉히 덮는다. index마다 다른 시드를 써서 같은 문서라도 문장마다 다른 어휘가 나온다.
	const sentenceCount = 4 + (index % 15);
	const sentences: string[] = [];
	for (let s = 0; s < sentenceCount; s += 1) {
		const template = MOCK_SENTENCE_TEMPLATES[(index * 13 + s) % MOCK_SENTENCE_TEMPLATES.length];
		if (template === undefined) {
			throw new Error('unreachable: MOCK_SENTENCE_TEMPLATES index out of range');
		}
		sentences.push(fillTemplate(template, index * 97 + s * 29));
	}
	return sentences.join(' ');
}

function buildMockTitle(index: number): string {
	const template = MOCK_TITLE_TEMPLATES[index % MOCK_TITLE_TEMPLATES.length];
	if (template === undefined) {
		throw new Error('unreachable: MOCK_TITLE_TEMPLATES index out of range');
	}
	const filled = fillTemplate(template, index * 11);
	return filled.replace(/(^|[\s-])([a-z])/g, (_match, sep: string, ch: string) => sep + ch.toUpperCase());
}

// Paper 필드를 전부 채운 완전한 객체로 만든다 — File.writeTestPaper가 그대로
// .json(원본)+.md(뷰)로 저장할 수 있어야 하므로 FileTestModal의 테스트 Paper 생성
// 방식과 동일하게 맞춘다.
function buildMockPaper(index: number): Paper {
	const paper = new Paper();
	paper.title = `Mock Paper ${index + 1}: ${buildMockTitle(index)}`;
	paper.authors = [];
	paper.abstract = buildMockAbstract(index);
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

// 날짜 입력(YYYY-MM-DD)을 timestamp(ms)로 변환. 비어있거나 잘못된 값이면 undefined.
function parseDateInput(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

// timestamp -> <input type="date">가 받는 "YYYY-MM-DD".
function isoDateInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// ⚠️ 임시(삭제 예정) — CollectAndSave.run()이 구현되면 그 경로로 교체한다.
// "수집" 버튼 공용 실행기. run()이 스텁이라 그 대신 ArxivAPI를 직접
// 호출한다("arXiv API 테스트" 버튼과 같던 성격 — 이제 이 버튼들이 그 역할을 흡수했다).
// (위 isoDateInput()도 이 임시 버튼의 날짜 기본값 계산 전용이라 같은 운명이다.)
//
// 결과는 CollectResultModal로 띄운다. 처음엔 console에만 남겼는데 두 가지가 문제였다:
// obsidianmd 린트가 console.log를 막아 console.debug를 썼더니 DevTools 기본 필터
// (Verbose 숨김)에 걸려 아예 안 보였고, 무엇보다 "N편 수집" 숫자만으로는 날짜 필터나
// 페이지네이션이 실제로 동작했는지 알 수 없었다. 모달이 그 판정을 대신 보여준다.
async function runCollectTest(
	app: App,
	label: string,
	keyword: string,
	fetchPapers: () => Promise<Paper[]>,
	api: ArxivAPI,
	usedS2Key: boolean,
	window?: { from: number; to: number },
): Promise<void> {
	try {
		const papers = await fetchPapers();
		new Notice(`${label} 수집 완료: ${papers.length}편`);
		new CollectResultModal(app, papers, api.lastCoverage, {
			label,
			keyword,
			window,
			usedS2Key,
		}).open();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		new Notice(`${label} 수집 실패: ${message}`);
		console.error(`[PaperGraph3D] ${label} 수집 실패`, e);
	}
}

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

		// ⚠️ 임시(삭제 예정) — CollectAndSave.run()이 구현되면 이 버튼들은 그 경로로
		// 교체하거나 지운다. runCollectTest() 정의부 참고.
		new Setting(containerEl)
			.setName('수집')
			.setDesc(
				'CollectAndSave.run() 없이 ArxivAPI.SearchRecentPaper()/Backfill()을 단독 호출합니다. ' +
					'저장하지 않습니다. 결과 창에서 날짜 필터·페이지네이션·인용수 보강이 실제로 ' +
					'동작했는지 항목별로 확인할 수 있고, 전체 JSON은 클립보드로 복사됩니다.',
			)
			.addButton((button) =>
				button.setButtonText('최근 논문').onClick(() => {
					new PipelineTestModal(
						this.app,
						'수집 테스트 — 최근 논문',
						[
							{ key: 'keyword', label: '키워드', defaultValue: 'transformer', type: 'text' },
							{
								key: 'hours',
								label: '최근 몇 시간',
								desc: 'API.SearchRecentPaper(hours)에 대응',
								type: 'number',
								defaultValue: '24',
							},
						],
						async (values) => {
							const keyword = values.keyword?.trim();
							if (!keyword) {
								new Notice('키워드를 입력하세요');
								return;
							}
							const hours = Number(values.hours);
							if (Number.isNaN(hours)) {
								new Notice('시간을 숫자로 입력하세요');
								return;
							}
							const secret = await File.readSecret();
							const api = new ArxivAPI([{ searchType: 'keyword', query: keyword }], secret);
							// SearchRecentPaper가 내부에서 잡는 구간과 같은 값을 검증용으로 만든다.
							const to = Date.now();
							await runCollectTest(
								this.app,
								'최근 논문',
								keyword,
								() => api.SearchRecentPaper(hours),
								api,
								secret.hasKey(S2_SECRET_PROVIDER),
								{ from: to - hours * 60 * 60 * 1000, to },
							);
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
							{ key: 'keyword', label: '키워드', defaultValue: 'transformer', type: 'text' },
							{
								key: 'from',
								label: '시작일',
								desc: 'API.Backfill(from, to)의 from',
								type: 'date',
								// 기본 2주 — 좁은 구간을 고르면 100건 미만이라 페이지네이션이
								// 한 번도 안 돌아 검증이 안 된다.
								defaultValue: isoDateInput(Date.now() - 14 * 24 * 60 * 60 * 1000),
							},
							{
								key: 'to',
								label: '종료일 (당일 포함)',
								desc: 'API.Backfill(from, to)의 to',
								type: 'date',
								defaultValue: isoDateInput(Date.now()),
							},
						],
						async (values) => {
							const keyword = values.keyword?.trim();
							if (!keyword) {
								new Notice('키워드를 입력하세요');
								return;
							}
							const from = parseDateInput(values.from ?? '');
							const toMidnight = parseDateInput(values.to ?? '');
							if (from === undefined || toMidnight === undefined) {
								new Notice('시작일/종료일을 올바르게 입력하세요');
								return;
							}
							// 날짜 입력은 자정(00:00)으로 파싱되므로 그대로 넘기면 종료일 당일이
							// 통째로 빠지고, 시작일=종료일이면 빈 구간이 된다. 하루를 더해
							// "종료일 당일 포함"으로 맞춘다.
							const to = toMidnight + 24 * 60 * 60 * 1000;
							const secret = await File.readSecret();
							const api = new ArxivAPI([{ searchType: 'keyword', query: keyword }], secret);
							await runCollectTest(
								this.app,
								'Backfill',
								keyword,
								() => api.Backfill(from, to),
								api,
								secret.hasKey(S2_SECRET_PROVIDER),
								{ from, to },
							);
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
