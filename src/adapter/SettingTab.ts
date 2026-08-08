import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type PaperGraph3D from '../main';
import { File } from '../common/File';
import { Log } from '../common/Log';
import { PipelineTestModal } from './PipelineTestModal';
import { FileTestModal } from './FileTestModal';
import { Paper } from '../collect/Paper';
import { SearchQuery } from '../collect/SearchQuery';
import { S2_SECRET_PROVIDER } from '../collect/API';
import type { Middleware } from '../common/Middleware';

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
	paper.collectedApis = [];
	paper.collectedQueries = [];
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

// timestamp -> <input type="date">가 받는 "YYYY-MM-DD". Backfill 범위 입력의 기본값 계산용.
function isoDateInput(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// 수집/보정 버튼 공용 실행기. run()/repair()는 실패 시 사용자가 무엇을 해야 하는지 담아
// throw하므로(모델 미설치, 구독 없음 등) 그 메시지를 그대로 Notice로 보여준다.
// 실행 중 버튼을 잠그는 이유: run()도 repair()도 embed()를 순차 호출한다는 계약 위에
// 서 있는데, 버튼 연타로 두 실행이 겹치면 그 계약이 실행 단위에서 깨진다.
//
// action()이 문자열을 돌려주면 "N편 수집" 같은 요약을 Notice에 덧붙인다. run()은
// void를 반환해 몇 편을 처리했는지 자체적으로 알려주지 않으므로(다이어그램 계약),
// 호출부가 진단용 미들웨어로 건수를 따로 관측해 넘긴다 — 조건에 맞는 논문이 0편이라
// 정상 종료된 것과 실제 오류를 구분하지 못하면 "성공 Notice는 떴는데 파일이 없다"는
// 혼란이 생긴다.
// 수집 계열 실행 하나를 요청한다. 실행 자체는 CollectAndSave의 직렬 큐가 맡으므로
// 여기서는 잠그지 않는다 — 이미 다른 수집이 돌고 있으면 거절하는 대신 줄을 서고, 그
// 사실만 사용자에게 알린다. (버튼을 비활성화하는 방식은 쓸 수 없다: display()가 다시
// 그리면서 새 버튼을 만들면 잠금이 통째로 사라진다.)
async function runCollectFlow(
	label: string,
	busy: boolean,
	action: () => Promise<string | void>,
): Promise<void> {
	if (busy) {
		new Notice(`${label}을(를) 대기열에 넣었습니다. 진행 중인 작업이 끝나면 실행됩니다.`);
	}
	Log.info('ui', `${label} 요청`, { queued: busy });
	try {
		const detail = await action();
		new Notice(`${label}을(를) 마쳤습니다.${detail ? ` (${detail})` : ''}`);
		Log.info('ui', `${label} 완료`, { detail });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		new Notice(`${label} 실패: ${message}`);
		Log.error('ui', `${label} 실패`, e);
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

// 수집 요청 하나의 진행 상태. 큐 때문에 "요청했지만 아직 시작 안 한" 흐름이 동시에 여러 개
// 있을 수 있어서, 인스턴스 필드가 아니라 요청마다 하나씩 만든다(runWithProgress 주석 참고).
interface ProgressFlow {
	label: string;
	total: number; // -1이면 아직 모름
	done: number;
	started: boolean; // 큐에서 빠져나와 실제로 실행이 시작됐는가
	collected: number | undefined; // 'all' 미들웨어가 알려준 수집 편수
	notice: Notice | undefined;
}

// 구독 UI는 Subscriptions.json과 실시간 동기화된다: 열 때 읽어와 복원하고, 추가/삭제
// 때마다 즉시 저장한다. 스타일은 임시지만 삭제 대상이 아니다 — CollectAndSave.run()이
// 읽는 Subscriptions.json을 만드는 유일한 입력 경로다(확정 UI는 시각화 이후 별도 작업).
export class SettingTab extends PluginSettingTab {
	plugin: PaperGraph3D;

	private apiKeyDraft = '';
	private apiNameDraft = '';
	private apiDrafts: ApiDraft[] = [];
	private subscriptionsLoaded = false;
	// 저장된 구독을 읽지 못한 상태인가. 읽기에 실패했는데 저장을 허용하면, 화면의 빈
	// 목록이 그대로 디스크를 덮어써 읽지 못했을 뿐 멀쩡히 있던 구독이 사라진다.
	private subscriptionsUnreadable = false;
	private diagnosticsRegistered = false;
	// 지금 실제로 실행 중인 흐름. 미들웨어('all'/'forEach')는 이것만 갱신한다 — 큐가 한
	// 번에 하나만 돌리므로 갱신 대상이 모호하지 않다. 없으면(보정처럼 진행률을 안 쓰는
	// 작업, 또는 아무것도 안 도는 중) 미들웨어가 걸려도 아무 일도 하지 않는다.
	private activeFlow: ProgressFlow | undefined;
	// 큐 상태를 보여주는 자리. display()가 다시 그릴 때마다 새로 만들어지므로, 갱신은
	// 항상 이 참조를 통해서 한다(없으면 아무 일도 안 함).
	private queueStatusEl: HTMLElement | undefined;
	private queueSubscribed = false;

	constructor(app: App, plugin: PaperGraph3D) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// 큐 상태 구독은 플러그인 수명 동안 한 번만 — display()마다 붙이면 리스너가 쌓인다.
	// 리스너는 queueStatusEl이 있을 때만 그리므로, 설정 탭이 닫혀 있어도 안전하다.
	private ensureQueueSubscription(): void {
		if (this.queueSubscribed) {
			return;
		}
		this.queueSubscribed = true;
		this.plugin.collectflow.onQueueChange(() => this.renderQueueStatus());
	}

	// 지금 무엇이 돌고 어떤 게 줄 서 있는지. display()가 다시 그린 직후에도 반드시 한 번
	// 불러야 한다 — 안 그러면 재렌더된 화면이 실제 상태와 어긋난 채로 남는다.
	private renderQueueStatus(): void {
		const el = this.queueStatusEl;
		if (!el) {
			return;
		}
		const { active, waiting } = this.plugin.collectflow.queueState;
		el.empty();
		if (!active) {
			el.createSpan({ text: '대기 중인 수집 작업 없음' });
			return;
		}
		el.createSpan({
			text:
				waiting.length === 0
					? `실행 중: ${active.label}`
					: `실행 중: ${active.label} — 대기 ${waiting.length}건 (${waiting.map((job) => job.label).join(', ')})`,
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// empty()로 방금 버린 DOM을 계속 가리키고 있으면 갱신이 허공에 그려진다.
		this.queueStatusEl = undefined;

		// 저장된 구독은 비동기로만 읽을 수 있는데 display()는 동기다. 첫 렌더에서 로드를
		// 걸어두고 끝나면 다시 그린다 — 이후 렌더부터는 캐시된 드래프트를 그대로 쓴다.
		if (!this.subscriptionsLoaded) {
			void this.loadSubscriptions();
		}

		// SettingTab은 플러그인 수명 동안 재사용되지만 display()는 열 때마다 다시 불리므로,
		// 미들웨어 등록은 한 번만 — 매번 등록하면 열 때마다 'all' 미들웨어가 쌓여 같은
		// run() 호출에 대해 lastCollectedCount가 여러 번(마지막 값은 같아도) 덮어써진다.
		this.ensureCollectDiagnostics();
		this.ensureQueueSubscription();

		new Setting(containerEl)
			.setName('파이프라인 테스트')
			.setDesc(
				'각 단계를 바로 확인할 수 있는 버튼들입니다. (임베딩은 아래 항목의 확인/설치 버튼으로 테스트하세요.)',
			)
			.setHeading();

		// 정식 수집 경로. 아래 "구독" 섹션에 등록된 조건으로 CollectAndSave.run()을 실행해
		// 수집 → 임베딩 → 저장까지 수행한다 (예전의 ArxivAPI 직접 호출 버튼들을 대체).
		new Setting(containerEl)
			.setName('수집')
			.setDesc(
				'구독에 등록된 조건으로 수집을 실행하고 결과를 저장합니다. ' +
					'최근 논문은 마지막 수집 지점부터 이어서, Backfill은 지정한 과거 구간을 수집합니다. ' +
					'보정은 임베딩·인용수 조회에 실패했던 논문을 다시 시도합니다.',
			)
			.addButton((button) =>
				button
					.setButtonText('최근 논문')
					.setCta()
					.onClick(() => {
						void runCollectFlow('최근 논문 수집', this.plugin.collectflow.isBusy, () =>
							this.runWithProgress('최근 논문 수집', (onStart, onTotal) =>
								this.plugin.collectflow.run('recent', undefined, onStart, onTotal),
							),
						);
					}),
			)
			.addButton((button) =>
				button.setButtonText('Backfill').onClick(() => {
					new PipelineTestModal(
						this.app,
						'Backfill — 과거 구간 수집',
						[
							{
								key: 'from',
								label: '시작일',
								type: 'date',
								// 기본 2주 — 좁은 구간을 고르면 100건 미만이라 페이지네이션이
								// 한 번도 안 돌아 검증이 안 된다.
								defaultValue: isoDateInput(Date.now() - 14 * 24 * 60 * 60 * 1000),
							},
							{
								key: 'to',
								label: '종료일 (당일 포함)',
								type: 'date',
								defaultValue: isoDateInput(Date.now()),
							},
						],
						async (values) => {
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
							await runCollectFlow('Backfill', this.plugin.collectflow.isBusy, () =>
								this.runWithProgress('Backfill', (onStart, onTotal) =>
									this.plugin.collectflow.run('backfill', { from, to }, onStart, onTotal),
								),
							);
						},
					).open();
				}),
			)
			.addButton((button) =>
				button.setButtonText('보정').onClick(() => {
					void runCollectFlow('보정', this.plugin.collectflow.isBusy, async () => {
						await this.plugin.collectflow.repair();
						return this.formatRepairDetail();
					});
				}),
			);

		// 큐 상태. 수집 버튼을 잠그는 대신 "지금 무엇이 돌고 무엇이 줄 서 있는지"를 보여준다.
		new Setting(containerEl).setName('수집 대기열').then((setting) => {
			this.queueStatusEl = setting.descEl;
			this.renderQueueStatus();
		});

		// ⚠️ 임시 진단 UI — 삭제 예정. 수집이 조용히 끊기는 원인을 잡으려고 넣은
		// 테스트/디버깅용이며, 프로덕션 기능이 아니다. 원인이 잡히면 이 Setting 블록을
		// 통째로 지운다 (src/common/Log.ts 상단 "지우는 법" 참고).
		new Setting(containerEl)
			.setName('수집 로그 (임시 진단용)')
			.setDesc(
				'수집 과정을 기록합니다. 수집이 중간에 멈추면 여기부터 확인하세요. ' +
					'콘솔은 Ctrl+Shift+I → Console 탭에서 보고, 로그 레벨을 "All levels"(Verbose 포함)로 ' +
					'바꿔야 상세 기록까지 보입니다. ' +
					`파일 기록을 켜면 ${Log.filePath()} 에도 쌓이므로 그 파일만 보내도 진단할 수 있습니다.`,
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip('파일로도 기록')
					.setValue(Log.isFileEnabled())
					.onChange((value) => {
						Log.setFileEnabled(value);
						new Notice(value ? '수집 로그를 파일에도 기록합니다.' : '수집 로그를 콘솔에만 남깁니다.');
					}),
			)
			.addButton((button) =>
				button
					.setButtonText('로그 파일 삭제')
					.setWarning()
					.onClick(async () => {
						await Log.clear();
						new Notice('수집 로그 파일을 삭제했습니다.');
					}),
			);

		new Setting(containerEl)
			.setName('저장 (File)')
			.setDesc('입력창에서 값을 받아 File의 쓰기 함수를 호출합니다.')
			// Secret/Subscriptions 저장 버튼은 없앴다 — 둘 다 빈 객체를 하드코딩해 써서,
			// 실데이터가 저장되는 지금은 누르는 순간 등록된 API 키/구독을 전부 지우는
			// 함정이었다 (키 등록은 FileTestModal의 Secret 폼, 구독은 아래 구독 UI가 담당).
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
								paper.collectedApis = [];
								paper.collectedQueries = [];
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
			.setDesc(
				'Semantic Scholar 인용수 조회에 쓰는 키(선택 사항 — 없으면 익명으로 호출되지만 ' +
					'요청 한도가 낮습니다). 입력 후 저장을 눌러야 반영됩니다.',
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
						void this.persistApiKey()
							.then(() => new Notice('API 키를 저장했습니다.'))
							.catch((e: unknown) => {
								new Notice(`API 키 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
							});
					}),
			);

		new Setting(containerEl)
			.setName('임베딩 모델')
			.setDesc(
				'specter2(8bit 양자화) 모델을 GitHub Release에서 받아 온디바이스로 씁니다. ' +
					'모델이 설치되어 있지 않으면 임베딩을 실행할 수 없습니다.',
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
							try {
								const result = await this.plugin.collectflow.embedding.embed(
									paper.title,
									paper.abstract,
								);
								// .md(문서)와 .json(임베딩 포함 원본)을 한 번에 저장한다. .md는 임베딩
								// 벡터를 담지 않으므로 임베딩 전/후로 두 번 나눠 쓸 이유가 없고, 두 번
								// 쓰면 재실행 시 "임베딩 전" 저장이 이전 실행의 정상 결과를 일시적으로
								// 지웠다가 복구하는 창이 생겨 중단 시 데이터가 빈 값으로 남을 수 있었다.
								Object.assign(paper, result);
								await File.writeTestPaper(paper, EMBEDDING_TEST_FOLDER);
								succeeded += 1;
							} catch (error) {
								// baseline이 없으므로 가짜 벡터를 만들지 않는다 — 대신 paper는
								// buildMockPaper()가 채워둔 빈 값(embedding=[], embeddingModel='',
								// embeddingSource='', embeddingSucceeded=false) 그대로 저장해서, 이
								// 논문이 "임베딩 실패로 재임베딩이 필요한 상태"임을 디스크에 남긴다.
								// embed()가 실제로 throw하고 여기서 catch되는지 눈으로 확인할 수
								// 있도록, 스트릭의 첫 실패에만 실제 에러 메시지를 Notice로 보여준다
								// (스팸 방지).
								if (failed === 0) {
									new Notice(
										`임베딩 실패 확인됨: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
								await File.writeTestPaper(paper, EMBEDDING_TEST_FOLDER);
								failed += 1;
							}

							notice.setMessage(
								`임베딩 테스트 중... (${i + 1}/${total}) 성공 ${succeeded} / 실패(빈 임베딩으로 저장) ${failed}`,
							);
						}
						const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
						notice.hide();
						new Notice(
							`임베딩 테스트 완료: 성공 ${succeeded}개 / 실패(빈 임베딩으로 저장) ${failed}개 (${elapsedSec}초)`,
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
						this.display();
					}),
			);

		for (const api of this.apiDrafts) {
			this.renderApiDraft(containerEl, api);
		}
	}

	// 수집 요청 하나를 진행률 Notice와 함께 실행한다.
	//
	// 큐 때문에 "요청했지만 아직 시작 안 한" 상태가 생기므로, 진행 상태는 인스턴스 필드가
	// 아니라 요청마다 만드는 ProgressFlow에 담는다. 예전처럼 필드 하나를 공유하면 두 번째
	// 요청이 첫 번째의 총계를 0으로 리셋해 "29/0편" 같은 표시가 나온다(친구가 겪은 증상).
	//
	// CollectAndSave에는 이 존재가 전달되지 않는다 — 도메인은 Obsidian을 몰라야 한다
	// (001 합의). 작업이 실제로 시작됐다는 사실만 onStart 콜백으로, 총계는 onTotal
	// 콜백으로 되돌려받는다.
	private async runWithProgress(
		label: string,
		action: (onStart: () => void, onTotal: (subtotal: number) => void) => Promise<void>,
	): Promise<string | void> {
		const flow: ProgressFlow = {
			label,
			// -1 = "총계 미정". run()이 onTotal로 알려주기 전까지는 분모를 아는 척하지
			// 않는다 — 0으로 두면 아직 안 온 총계를 실제 값처럼 "N/0편"으로 찍게 된다.
			total: -1,
			done: 0,
			started: false,
			collected: undefined,
			notice: undefined,
		};
		flow.notice = new Notice(this.renderProgress(flow), 0);
		try {
			await action(
				() => {
					flow.started = true;
					// 큐가 한 번에 하나만 실행하므로, 시작한 흐름이 곧 미들웨어가 갱신할 대상이다.
					this.activeFlow = flow;
					this.updateProgress(flow);
				},
				(subtotal) => {
					// 구독마다 최대 한 번씩 불린다 — 값을 더해야 여러 구독을 합친 전체
					// 총계가 된다(청크 도착 순서에 상관없이 각자 자기 몫만 보고한다).
					flow.total = (flow.total < 0 ? 0 : flow.total) + subtotal;
					this.updateProgress(flow);
				},
			);
		} finally {
			flow.notice?.hide();
			flow.notice = undefined;
			if (this.activeFlow === flow) {
				this.activeFlow = undefined;
			}
		}
		if (flow.collected === undefined) {
			return undefined;
		}
		// 임베딩 실패는 수집을 멈추지 않으므로, 알리지 않으면 사용자는 벡터가 빈 논문이
		// 쌓인 걸 모른다. 복구 방법(보정)까지 같이 말한다.
		const failed = this.plugin.collectflow.lastStats?.embedFailed ?? 0;
		return failed > 0
			? `${flow.collected}편 수집, 그중 ${failed}편 임베딩 실패 — 「보정」으로 재시도하세요`
			: `${flow.collected}편 수집`;
	}

	// 보정은 진행률 Notice가 없어 runWithProgress를 안 거치므로, 완료 문구는 여기서 따로
	// 만든다. lastRepairStats는 repair()가 void를 반환하는 대신 인스턴스에 남겨두는 값이다
	// (run()의 lastStats와 같은 이유).
	private formatRepairDetail(): string | undefined {
		const stats = this.plugin.collectflow.lastRepairStats;
		if (!stats) {
			return undefined;
		}
		const parts: string[] = [];
		if (stats.reembedded > 0) {
			parts.push(`재임베딩 ${stats.reembedded}편`);
		}
		if (stats.citationsFixed > 0) {
			parts.push(`인용수 보강 ${stats.citationsFixed}편`);
		}
		if (parts.length === 0) {
			return '고칠 것 없음';
		}
		if (stats.reembedFailed > 0) {
			parts.push(`${stats.reembedFailed}편은 여전히 실패`);
		}
		return parts.join(', ');
	}

	// run()의 'all'/'forEach' 미들웨어로 수집 건수와 진행률을 관측한다. run() 자체는
	// 다이어그램 계약상 void만 반환하고 Notice/DOM을 전혀 모르므로(CollectAndSave는
	// Obsidian을 몰라야 한다 — 001 합의), 관측은 항상 미들웨어를 경유한다. UI(Notice
	// 생성·표시 문자열)는 이 안이 아니라 renderProgress()에만 있다.
	//
	// ⚠️ 등록 순서 전제: 중복 제거 미들웨어가 나중에 'all'로 붙으면 이 진단보다 먼저
	// 실행돼야 줄어든 개수가 총계로 잡힌다. 지금은 이 진단이 유일한 'all'이라 문제없다.
	private ensureCollectDiagnostics(): void {
		if (this.diagnosticsRegistered) {
			return;
		}
		this.diagnosticsRegistered = true;
		// 미들웨어는 플러그인 수명 내내 등록된 채로 남는다. 갱신 대상은 항상 "지금 실행 중인
		// 흐름"이고, 그게 없으면(예: 보정처럼 진행률을 안 쓰는 작업) 아무 일도 하지 않는다.
		// 'all'은 이제 수집 전체가 아니라 **청크마다** 불린다(CollectAndSave.processChunk).
		// 총계(flow.total)는 여기서 건드리지 않는다 — runWithProgress에 넘긴 onTotal
		// 콜백이 arXiv가 알려준 진짜 총계로 채운다. 예전에는 여기서 청크 크기를 계속
		// 더해 "총계"를 흉내 냈는데, 그러면 분모 자체가 청크가 도착할 때마다 100, 200,
		// 300으로 계속 늘어나는 것처럼 보였다(사용자 리포트로 발견).
		this.plugin.collectflow.setMiddleware({
			type: 'all',
			run: (context) => {
				const papers = context as Paper[];
				const flow = this.activeFlow;
				if (!flow) {
					return;
				}
				flow.collected = (flow.collected ?? 0) + papers.length;
				this.updateProgress(flow);
			},
		});
		this.plugin.collectflow.setMiddleware({
			type: 'forEach',
			run: () => {
				const flow = this.activeFlow;
				if (!flow) {
					return;
				}
				flow.done += 1;
				this.updateProgress(flow);
			},
		});
	}

	private updateProgress(flow: ProgressFlow): void {
		flow.notice?.setMessage(this.renderProgress(flow));
	}

	// 세 단계로 다르게 말한다: 큐에서 대기 중 / 받아오는 중(총계 미정) / 처리 중(N/M).
	// 총계를 모르는 동안 분모를 아는 척하지 않는 게 핵심이다.
	private renderProgress(flow: ProgressFlow): DocumentFragment {
		const known = flow.total >= 0;
		return createFragment((el) => {
			let text: string;
			if (!flow.started) {
				text = `${flow.label} — 대기 중... (진행 중인 작업이 끝나면 시작합니다)`;
			} else if (!known) {
				text = `${flow.label} — arXiv에서 수집 중... (총 편수는 아직 알 수 없습니다)`;
			} else {
				text = `${flow.label} — 수집한 논문 처리 중... (${flow.done}/${flow.total}편)`;
			}
			el.createDiv({ text });
			// max가 0/음수면 <progress>는 부정형(indeterminate)이 된다 — 총계를 모르는
			// 동안 정확히 그 표시를 원한다.
			el.createEl('progress', {
				attr: known ? { value: flow.done, max: Math.max(flow.total, 1) } : {},
			});
		});
	}

	// Subscriptions.json -> apiDrafts. 설정탭을 열 때 한 번만 — 이후에는 UI가 진실이고
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
		// 설정탭을 다시 열 때마다 "비어 있나?" 헷갈린다(FileTestModal의 "Secret 확인하기"도
		// 평문으로 보여주는 것과 같은 판단 — 이 vault 밖으로 안 나가는 로컬 값이다).
		try {
			const secret = await File.readSecret();
			this.apiKeyDraft = secret.getKey(S2_SECRET_PROVIDER) ?? '';
		} catch (e) {
			new Notice(`API 키를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
		}

		this.subscriptionsLoaded = true;
		this.display();
	}

	// apiKeyDraft -> Secret.json. Secret은 provider->key 맵 전체를 한 파일에 저장하므로,
	// 현재 저장본을 읽어 S2_SECRET_PROVIDER 항목만 갈아끼운다 — 그대로 새 Secret()을
	// 써서 저장하면 다른 provider의 키까지 날아간다. 실패 시 호출부가 처리하도록 그대로
	// throw한다(성공 Notice를 잘못 띄우지 않기 위해 여기서 삼키지 않는다).
	private async persistApiKey(): Promise<void> {
		const secret = await File.readSecret();
		secret.setKey(S2_SECRET_PROVIDER, this.apiKeyDraft.trim());
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
					this.display();
				}),
			);

		for (const condition of api.conditions) {
			new Setting(containerEl)
				.setName(`${CONDITION_TYPE_LABEL[condition.searchType] ?? condition.searchType}: ${condition.query}`)
				.addButton((button) =>
					button.setButtonText('조건 삭제').onClick(() => {
						api.conditions = api.conditions.filter((item) => item !== condition);
						void this.persistSubscriptions();
						this.display();
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
					this.display();
				}),
			);
	}
}
