import { App, Notice, TFile } from 'obsidian';
import type { ForceGraph3DInstance } from '3d-force-graph';
import { Middleware, MiddlewareType } from '../common/Middleware';
import { Log } from '../common/Log';
import { Paper } from '../collect/Paper';
import { Embedding } from '../collect/Embedding';
import { GraphData, GraphNode } from './GraphData';

// 시각화 미들웨어: vault의 "개인 노트"를 임베딩해 논문 노드와 같은 3D 그래프에 얹는다.
// VisualizationFlow.run이 init 후 render 전에 이 run(GraphData)을 호출한다(type === 'visual').
//
// ⚠️ 설계 원칙: 이 파일은 다른 클래스(PCA/Visualization/GraphData/File, 다른 시각화
// 미들웨어)를 전혀 수정하지 않고 완결된다 — GraphData가 이미 공개로 노출하는 값만 읽고,
// 파일 I/O·프론트매터 제거 등은 이 파일 안에서 자체 구현한다(File.ts와 일부 겹치지만,
// 다른 클래스 무수정 원칙 때문에 의도적으로 작게 중복시킨 것 — docs/devLog 참고).
// 또한 다른 미들웨어의 등록 여부/순서를 전제하지 않는다 — 이 미들웨어가 만드는 노드의
// 색·클릭 동작은 스스로 완결적으로 정한다.

// 콘텐츠 트리 루트 — Paper json/md와 같은 위치. 캐시와 설정 파일 모두 이 아래 둔다
// (Secret.json처럼 플러그인 설정 폴더에 숨기지 않고, 사용자가 파일탐색기로도 확인 가능하게).
const PAPER_GRAPH_ROOT = 'PaperGraph3D';
// 노트 임베딩 캐시 위치 — 노트의 vault 경로를 그대로 미러링한다.
const CACHE_ROOT = `${PAPER_GRAPH_ROOT}/PersonalNotes`;
// 사용자 설정(대상 폴더 경로·노트 표시 여부) 저장 위치. CACHE_ROOT 안에 두면 실제로
// "PersonalNotes/config.md"라는 노트가 있을 때 캐시 파일명과 충돌할 수 있어 형제 경로로 둔다.
const CONFIG_PATH = `${PAPER_GRAPH_ROOT}/PersonalNotesConfig.json`;
// 2: folderPath(단일 문자열) → folderPaths(배열)로 스키마 변경. readConfig가 구버전 파일도
// 마이그레이션해서 읽는다(아래 참고).
const CONFIG_SCHEMA_VERSION = 2;
// 설정 파일이 없을 때(최초 실행)의 기본값 — 예전 하드코딩 동작과 100% 호환.
const DEFAULT_FOLDER_PATH = 'PersonalNotes';
const DEFAULT_FOLDER_PATHS = [DEFAULT_FOLDER_PATH];
// 경로 입력칸의 placeholder(예시일 뿐 실제 채워지는 값이 아님). DEFAULT_FOLDER_PATH를
// 그대로 쓰면 "빈 칸일 때 실제로 적용되는 기본값"과 "그냥 예시"가 헷갈린다 — 특히
// PersonalNotes/PaperGraph3D 관련 경로 혼동을 겪은 뒤라 더 그렇다. 실제 기본 경로와
// PAPER_GRAPH_ROOT 어느 쪽과도 겹치지 않는 별개 예시를 쓴다.
const PATH_INPUT_PLACEHOLDER = '예: Notes/Papers';
// 노트 노드의 sourceId 접두사. 런타임에 "이 GraphNode가 논문이 아니라 노트다"를 판별하는
// 유일한 수단이다(GraphNode/Paper 타입을 확장하지 않기로 했으므로).
const NOTE_SOURCE_PREFIX = 'note:';
const NOTE_NODE_COLOR = '#43a047'; // 초록 — CitationColorMiddleware의 파랑/주황과 안 겹침
const NOTE_NODE_SIZE = 3;
// 좌표 배치에 쓸 최근접 논문 이웃 수.
const K_NEIGHBORS = 8;
// 프론트매터 제거 후 본문 길이가 이 미만이면 "사실상 빈 노트"로 보고 건너뛴다.
const MIN_BODY_LENGTH = 20;
const CACHE_SCHEMA_VERSION = 1;

interface StoredNoteEmbedding {
	schemaVersion: number;
	notePath: string;
	mtime: number;
	title: string;
	embedding: number[];
	embeddingModel: string;
	embeddingSource: string;
	createdAt: number;
	updatedAt: number;
}

// 사용자가 그래프 내 컨트롤 패널로 바꾸는 값들. SettingTab 등 다른 클래스에 의존하지 않고
// 이 미들웨어가 자체적으로 읽고 쓴다(§ readConfig/writeConfig, mountControlPanel).
interface PersonalNoteConfig {
	schemaVersion: number;
	folderPaths: string[]; // vault 루트 기준 대상 폴더들 (각각 하위 폴더 포함 매칭, OR)
	notesVisible: boolean; // 그래프 내 토글의 마지막 상태 — 뷰를 다시 열어도 기억한다
}

export class PersonalNoteMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	// run()마다 새로 채운다 — 클릭 핸들러가 sourceId로 실제 파일을 찾을 때 쓴다.
	private noteFilesBySourceId = new Map<string, TFile>();

	constructor(
		private app: App,
		private embedding: Embedding,
		// 폴더 경로를 바꿔 "적용"했을 때 전체 파이프라인을 다시 돌리는 콜백. App/Embedding과
		// 같은 프레임워크 핸들 주입 패턴 — 다른 미들웨어를 참조하는 게 아니라 VisualizationFlow의
		// 진입점을 부르는 것뿐이라 "미들웨어 자체 동작" 원칙과 충돌하지 않는다.
		private rerun: () => Promise<void>,
	) {}

	async run(context: unknown): Promise<void> {
		const graph = context as GraphData;
		this.noteFilesBySourceId.clear();

		// 논문 노드가 하나도 없으면(PCA가 아직 안 돌았거나 실패) 이웃 기반 배치를 할 수
		// 없으므로 아무 것도 하지 않는다.
		if (graph.nodes.length === 0) {
			return;
		}

		const config = await this.readConfig();

		// PAPER_GRAPH_ROOT 하위·볼트 밖을 가리키는 경로·금지 문자가 섞인 경로는 설정에
		// 남아 있어도 절대 노트 소스로 취급하지 않는다. UI(normalizeFolderPaths)가 입력을
		// 막아도, 이 픽스 이전에 저장된 config.json이나 수동 편집으로 여전히 들어와 있을
		// 수 있어 여기서도 방어한다 — 안 그러면 논문 md 자체가 "노트"로 재임베딩되거나
		// 캐시 폴더를 지정해 파이프라인이 깨진다.
		const validFolderPaths = config.folderPaths.filter(
			(folderPath) =>
				!PersonalNoteMiddleware.isWithinPaperGraphRoot(folderPath) &&
				!PersonalNoteMiddleware.isOutsideVaultPath(folderPath) &&
				!PersonalNoteMiddleware.hasInvalidPathChars(folderPath),
		);

		const noteFiles =
			validFolderPaths.length > 0
				? this.app.vault
						.getMarkdownFiles()
						.filter((file) =>
							validFolderPaths.some(
								(folderPath) => file.path === folderPath || file.path.startsWith(`${folderPath}/`),
							),
						)
				: [];

		if (noteFiles.length > 0) {
			graph.events.nodeClick.push((node) => this.handleClick(node));

			// 파일마다 반복 확인하지 않고 여기서 한 번만 확인해 아래로 흘려보낸다 — 캐시가
			// 있는 노트는 모델 미설치여도 그대로 쓰므로(resolveEmbedding 참고), 이 값은
			// "새로 임베딩해야 하는 노트"에만 영향을 준다.
			const modelInstalled = await this.embedding.isModelInstalled();
			if (!modelInstalled) {
				PersonalNoteMiddleware.notify(
					'개인 노트 임베딩 모델이 설치되지 않았습니다 — 설정 → PaperGraph3D에서 설치해주세요. ' +
						'(캐시된 노트는 그대로 표시되고, 아직 임베딩 안 된 노트만 건너뜁니다.)',
				);
			}

			// CollectAndSave.run()/repairEmbeddingsBody()와 같은 패턴 — 새 배치를 시작하기
			// 전에 서킷브레이커를 리셋한다. 안 하면 이전 배치(논문 수집이든 이전 그래프
			// 열람이든)에서 트립된 상태가 남아 있을 때, 이번 노트들이 멀쩡한데도 첫 시도부터
			// 즉시 막혀버릴 수 있다.
			this.embedding.resetCircuitBreaker();

			// 진행 표시 — render()가 container를 비우기 전까지만 떠 있는 임시 UI다(아래
			// mountProgressIndicator 주석 참고). 컨트롤 패널(mountControlPanel)과 자리가
			// 겹치도록 일부러 같은 우하단 코너에 둔다 — 진행 표시가 끝나면 그 자리에
			// 컨트롤 패널이 이어받는 것처럼 보이게.
			const progress = this.mountProgressIndicator(graph, noteFiles.length);

			// ⚠️ 반드시 순차 실행 — Embedding.embed()는 세션/서킷브레이커 상태를 락 없이
			// 공유해 동시 호출이 안전하지 않다(Embedding.embed 주석 참고). 부수 효과로,
			// await 사이마다 브라우저가 그릴 기회를 얻어 진행 표시가 실시간으로 갱신된다.
			try {
				for (const [index, file] of noteFiles.entries()) {
					progress?.update(index + 1);
					try {
						const node = await this.buildNoteNode(file, graph, modelInstalled);
						if (node) {
							graph.nodes.push(node);
							this.noteFilesBySourceId.set(node.id, file);
						}
					} catch (error) {
						Log.warn('visualize', '개인 노트 노드 생성 실패 — 건너뜀', {
							path: file.path,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			} finally {
				progress?.remove();
			}
		}

		// 폴더에 노트가 없어도(최초 설정 전 등) 컨트롤 패널은 항상 띄운다 — 그래야
		// 사용자가 그래프 안에서 바로 경로를 지정할 수 있다(SettingTab 없이 자체 완결).
		graph.renderHooks.push((forceGraph) => this.mountControlPanel(graph, forceGraph, config));
	}

	private async buildNoteNode(
		file: TFile,
		graph: GraphData,
		modelInstalled: boolean,
	): Promise<GraphNode | undefined> {
		const raw = await this.app.vault.cachedRead(file);
		const body = PersonalNoteMiddleware.stripFrontmatter(raw).trim();
		if (body.length < MIN_BODY_LENGTH) {
			return undefined;
		}
		const title = file.basename;

		const resolved = await this.resolveEmbedding(file, title, body, modelInstalled);
		if (!resolved) {
			return undefined;
		}

		const paper = PersonalNoteMiddleware.buildSyntheticPaper(file, title, body, resolved);
		const { fx, fy } = PersonalNoteMiddleware.projectByNeighbors(resolved.embedding, graph.nodes);
		const fz = PersonalNoteMiddleware.projectTime(file.stat.ctime, graph.nodes);

		return {
			id: paper.sourceId,
			fx,
			fy,
			fz,
			paper,
			size: NOTE_NODE_SIZE,
			color: NOTE_NODE_COLOR,
			label: title,
		};
	}

	// ── 임베딩 + 캐시 ────────────────────────────────────────────────

	// 캐시(mtime 일치)가 있으면 재사용, 없거나 낡았으면 새로 임베딩해 캐시를 갱신한다.
	// modelInstalled는 run()이 한 번만 확인해 넘겨준다(파일마다 재확인하지 않음).
	// 모델 미설치/임베딩 실패는 조용히 건너뛴다(시각화 자체는 계속 진행) — Log.warn만 남김.
	// 사용자 알림(Notice)은 run()이 한 번만 띄운다.
	private async resolveEmbedding(
		file: TFile,
		title: string,
		body: string,
		modelInstalled: boolean,
	): Promise<StoredNoteEmbedding | undefined> {
		const cached = await this.readCache(file.path);
		if (cached && cached.mtime === file.stat.mtime) {
			return cached;
		}

		if (!modelInstalled) {
			Log.warn('visualize', '개인 노트 임베딩 건너뜀 — 모델 미설치', { path: file.path });
			return undefined;
		}

		try {
			const result = await this.embedding.embed(title, body);
			const now = Date.now();
			const data: StoredNoteEmbedding = {
				schemaVersion: CACHE_SCHEMA_VERSION,
				notePath: file.path,
				mtime: file.stat.mtime,
				title,
				embedding: result.embedding,
				embeddingModel: result.embeddingModel,
				embeddingSource: result.embeddingSource,
				createdAt: cached?.createdAt ?? now,
				updatedAt: now,
			};
			await this.writeCache(file.path, data);
			return data;
		} catch (error) {
			Log.warn('visualize', '개인 노트 임베딩 실패 — 건너뜀', {
				path: file.path,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private cachePath(notePath: string): string {
		return `${CACHE_ROOT}/${notePath.replace(/\.md$/, '')}.json`;
	}

	private async readCache(notePath: string): Promise<StoredNoteEmbedding | undefined> {
		// 캐시가 손상됐으면(JSON 파싱 실패) 없는 것과 동일하게 취급 — 아래에서 재임베딩된다.
		return this.readVaultJson<StoredNoteEmbedding>(this.cachePath(notePath));
	}

	private async writeCache(notePath: string, data: StoredNoteEmbedding): Promise<void> {
		await this.writeVaultJson(this.cachePath(notePath), data);
	}

	// 설정 파일이 없으면(최초 실행) 기존 하드코딩 동작과 같은 기본값으로 폴백한다.
	// schemaVersion 1(folderPath 단일 문자열)로 저장된 구버전 파일도 여기서 배열로
	// 마이그레이션해 읽는다 — 다음에 writeConfig가 호출되면 자연히 새 스키마로 저장된다.
	private async readConfig(): Promise<PersonalNoteConfig> {
		const stored = await this.readVaultJson<Record<string, unknown>>(CONFIG_PATH);
		if (!stored) {
			return {
				schemaVersion: CONFIG_SCHEMA_VERSION,
				folderPaths: [...DEFAULT_FOLDER_PATHS],
				notesVisible: true,
			};
		}
		const notesVisible = typeof stored.notesVisible === 'boolean' ? stored.notesVisible : true;
		if (Array.isArray(stored.folderPaths)) {
			return {
				schemaVersion: CONFIG_SCHEMA_VERSION,
				folderPaths: stored.folderPaths.filter((p): p is string => typeof p === 'string'),
				notesVisible,
			};
		}
		if (typeof stored.folderPath === 'string') {
			return {
				schemaVersion: CONFIG_SCHEMA_VERSION,
				folderPaths: [stored.folderPath],
				notesVisible,
			};
		}
		return {
			schemaVersion: CONFIG_SCHEMA_VERSION,
			folderPaths: [...DEFAULT_FOLDER_PATHS],
			notesVisible,
		};
	}

	private async writeConfig(config: PersonalNoteConfig): Promise<void> {
		await this.writeVaultJson(CONFIG_PATH, config);
	}

	// vault JSON 파일 읽기 — 없거나 손상됐으면 undefined. 캐시와 설정 파일이 공유하는 I/O.
	private async readVaultJson<T>(path: string): Promise<T | undefined> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return undefined;
		}
		try {
			return JSON.parse(await this.app.vault.read(file)) as T;
		} catch {
			return undefined;
		}
	}

	// "있으면 modify, 없으면 폴더 만들고 create" 패턴 — File.ts를 거치지 않고 이 파일
	// 안에서 자체 완결한다(다른 클래스 무수정 원칙, devlog 참고).
	private async writeVaultJson(path: string, data: unknown): Promise<void> {
		const text = JSON.stringify(data, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, text);
			return;
		}
		const folder = path.slice(0, path.lastIndexOf('/'));
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				/* 이미 있으면 무시 (동시 생성 경쟁 대비) */
			});
		}
		await this.app.vault.create(path, text);
	}

	// ── 텍스트 처리 ──────────────────────────────────────────────────

	// File.parseUserBody()의 프론트매터 스킵과 동일한 로직(로컬 재구현 — 다른 클래스
	// 무수정 원칙).
	private static stripFrontmatter(text: string): string {
		if (!text.startsWith('---\n')) {
			return text;
		}
		const end = text.indexOf('\n---', 4);
		if (end === -1) {
			return text;
		}
		return text.slice(end + 4).replace(/^\n/, '');
	}

	private static buildSyntheticPaper(
		file: TFile,
		title: string,
		body: string,
		resolved: StoredNoteEmbedding,
	): Paper {
		const paper = new Paper();
		paper.title = title;
		paper.authors = [];
		paper.abstract = body;
		paper.sourceId = `${NOTE_SOURCE_PREFIX}${file.path}`;
		paper.references = [];
		paper.publicationDate = new Date(file.stat.ctime).toISOString().slice(0, 10);
		paper.citationCount = 0;
		paper.citationsKnown = false;
		paper.collectedApis = [];
		paper.collectedQueries = [];
		paper.embedding = resolved.embedding;
		paper.embeddingModel = resolved.embeddingModel;
		paper.embeddingSource = resolved.embeddingSource;
		paper.embeddingSucceeded = true;
		return paper;
	}

	// ── 좌표 배치 (논문 노드는 읽기만 — 절대 수정하지 않는다) ────────────

	// 코사인 유사도(내적 — 임베딩이 이미 L2 정규화돼 있음) 상위 K개 논문 노드의 fx/fy를
	// (유사도 + 1) 가중치로 정규화해 가중 평균한다. +1은 유사도가 음수여도 가중치 합이
	// 항상 양수가 되게 하는 안전장치.
	private static projectByNeighbors(
		embedding: number[],
		nodes: GraphNode[],
	): { fx: number; fy: number } {
		const scored = nodes
			.filter((node) => node.paper.embedding.length === embedding.length)
			.map((node) => ({ node, similarity: PersonalNoteMiddleware.dot(embedding, node.paper.embedding) }))
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, K_NEIGHBORS);

		if (scored.length === 0) {
			return { fx: 0, fy: 0 };
		}

		let weightSum = 0;
		let fxSum = 0;
		let fySum = 0;
		for (const { node, similarity } of scored) {
			const weight = similarity + 1;
			weightSum += weight;
			fxSum += weight * node.fx;
			fySum += weight * node.fy;
		}
		if (weightSum === 0) {
			// 이론상 도달하기 어렵다(유사도 -1은 완전 반대 방향인 벡터뿐) — 균등 평균으로 폴백.
			const n = scored.length;
			return {
				fx: scored.reduce((sum, s) => sum + s.node.fx, 0) / n,
				fy: scored.reduce((sum, s) => sum + s.node.fy, 0) / n,
			};
		}
		return { fx: fxSum / weightSum, fy: fySum / weightSum };
	}

	// 기존 논문 노드들의 (발행일, fz) 쌍에서 기울기를 역산해 같은 직선 위에 노트의 fz를
	// 얹는다. 유효한(파싱 가능한) 날짜가 2개 미만이면 전체 노드 fz 평균으로 대체한다.
	private static projectTime(ctimeMs: number, nodes: GraphNode[]): number {
		let minT: number | undefined;
		let maxT: number | undefined;
		let fzAtMin = 0;
		let fzAtMax = 0;
		for (const node of nodes) {
			const t = Date.parse(node.paper.publicationDate);
			if (Number.isNaN(t)) {
				continue;
			}
			if (minT === undefined || t < minT) {
				minT = t;
				fzAtMin = node.fz;
			}
			if (maxT === undefined || t > maxT) {
				maxT = t;
				fzAtMax = node.fz;
			}
		}
		if (minT === undefined || maxT === undefined || maxT === minT) {
			const n = nodes.length || 1;
			return nodes.reduce((sum, node) => sum + node.fz, 0) / n;
		}
		const slope = (fzAtMax - fzAtMin) / (maxT - minT);
		return fzAtMin + slope * (ctimeMs - minT);
	}

	private static dot(a: number[], b: number[]): number {
		let sum = 0;
		const len = Math.min(a.length, b.length);
		for (let i = 0; i < len; i += 1) {
			sum += (a[i] ?? 0) * (b[i] ?? 0);
		}
		return sum;
	}

	// ── 클릭 ────────────────────────────────────────────────────────

	// 이 미들웨어가 만든 노드(sourceId가 note: 접두사)만 반응한다. 다른 노드는 무시 —
	// 다른 미들웨어(OpenNoteOnClickMiddleware 등)의 존재/등록 여부를 전제하지 않는다.
	private handleClick(node: GraphNode): void {
		if (!PersonalNoteMiddleware.isNoteNode(node)) {
			return;
		}
		const file = this.noteFilesBySourceId.get(node.paper.sourceId);
		if (!file) {
			return;
		}
		void this.app.workspace.getLeaf('tab').openFile(file);
	}

	private static isNoteNode(node: GraphNode): boolean {
		return node.paper.sourceId.startsWith(NOTE_SOURCE_PREFIX);
	}

	// 이 미들웨어의 알림은 Obsidian 기본 위치(우하단) 대신 그래프 뷰 우상단에 뜨도록
	// noticeEl에 styles.css의 .papergraph3d-note-notice를 붙인다(position:fixed로 뷰포트
	// 우상단에 앵커해 공용 notice-container의 flex 배치를 벗어난다). noticeEl은 Notice
	// API에서 deprecated 표시돼 있지만(1.8.7+는 messageEl/containerEl 권장),
	// manifest.json의 minAppVersion(1.7.2)과의 호환을 위해 이걸 쓴다.
	private static notify(message: string, duration?: number): Notice {
		const notice = new Notice(message, duration);
		notice.noticeEl.addClass('papergraph3d-note-notice');
		return notice;
	}

	// run()이 노트를 순차로 embed하는 동안 진행 상황을 보여주는 임시 표시. mountControlPanel과
	// 달리 renderHooks가 아니라 run() 도중 직접 container에 붙인다 — 그래야 embed 루프가
	// 도는 실시간으로(=render()가 container를 비우기 전에) 보인다. render()가 결국
	// container.replaceChildren()을 부르면서 자연히 사라지고, 그 직후 같은 자리에
	// mountControlPanel의 패널이 뜬다. graph.container가 없으면(뷰가 아직 컨테이너를
	// 세팅 안 함) 조용히 표시를 생략한다. mountControlPanel과 같은 .papergraph3d-note-panel
	// 클래스를 그대로 써서(전용 클래스를 따로 안 만듦) 둘이 같은 자리를 이어받는 것처럼
	// 보이면서도 styles.css에 규칙을 더 늘리지 않는다.
	private mountProgressIndicator(
		graph: GraphData,
		total: number,
	): { update: (current: number) => void; remove: () => void } | undefined {
		const container = graph.container;
		if (!container || total === 0) {
			return undefined;
		}
		const el = container.createDiv({ cls: 'papergraph3d-note-panel' });
		return {
			update: (current: number) => {
				el.setText(`개인 노트 임베딩 중: ${current} / ${total}`);
			},
			remove: () => el.remove(),
		};
	}

	// ── 그래프 내 컨트롤 패널 (SettingTab 등 다른 클래스에 의존하지 않는 자체 UI) ─────

	// GraphData.renderHooks를 통해 render()가 ForceGraph3D 인스턴스를 만든 "이후"에만
	// 호출된다 — render()의 container.replaceChildren()이 그보다 먼저 실행되므로, 만약
	// run() 중에 직접 container에 DOM을 붙이면 곧바로 지워진다. 반드시 이 훅을 거쳐야 한다.
	private mountControlPanel(
		graph: GraphData,
		forceGraph: ForceGraph3DInstance,
		config: PersonalNoteConfig,
	): void {
		const container = graph.container;
		if (!container) {
			return;
		}

		let notesVisible = config.notesVisible;
		const applyVisibility = (): void => {
			forceGraph.nodeVisibility((node) =>
				PersonalNoteMiddleware.isNoteNode(node as GraphNode) ? notesVisible : true,
			);
			forceGraph.refresh();
		};
		// 마운트 직후 기억된 상태를 그대로 반영한다(꺼져 있었으면 즉시 숨김) — 노드는
		// 항상 만들어 두고 가시성만 바꾸므로 나중에 켤 때 재임베딩 없이 바로 반응한다.
		applyVisibility();

		// styles.css의 .papergraph3d-note-* 클래스로 스타일링한다(정적 스타일은 인라인
		// style.cssText 대신 CSS 클래스로 — obsidianmd/no-static-styles-assignment).
		const panel = container.createDiv({ cls: 'papergraph3d-note-panel' });

		// 토글 행과 경로 행은 둘 다 "가운데 정렬된 가로 flex"라 같은 .papergraph3d-note-row
		// 클래스를 공유한다(전용 클래스를 늘리지 않기 위해).
		const toggleRow = panel.createEl('label', { cls: 'papergraph3d-note-row' });
		const checkbox = toggleRow.createEl('input');
		checkbox.type = 'checkbox';
		checkbox.checked = notesVisible;
		checkbox.addEventListener('change', () => {
			notesVisible = checkbox.checked;
			applyVisibility();
			void this.writeConfig({ ...config, notesVisible }).catch((error: unknown) => {
				PersonalNoteMiddleware.notify(
					`개인 노트 표시 설정 저장 실패: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		});
		toggleRow.createSpan({ text: '개인 노트 표시' });

		// 경로 목록 — 각 행에 입력칸 + 삭제 버튼, 입력값은 이 배열에 실시간으로 반영된다
		// (렌더 트리는 렌더할 때마다 다시 그리지만 값 자체는 여기 유지된다).
		const paths: string[] = config.folderPaths.length > 0 ? [...config.folderPaths] : [''];
		const pathListEl = panel.createDiv({ cls: 'papergraph3d-note-path-list' });
		const renderPathRows = (): void => {
			pathListEl.empty();
			paths.forEach((path, index) => {
				const row = pathListEl.createDiv({ cls: 'papergraph3d-note-row' });
				const input = row.createEl('input', { cls: 'papergraph3d-note-path-input' });
				input.type = 'text';
				input.value = path;
				input.placeholder = PATH_INPUT_PLACEHOLDER;
				input.addEventListener('input', () => {
					paths[index] = input.value;
				});
				const removeButton = row.createEl('button', {
					text: '×',
					cls: 'papergraph3d-note-path-remove',
				});
				removeButton.addEventListener('click', () => {
					paths.splice(index, 1);
					renderPathRows();
				});
			});
		};
		renderPathRows();

		const addButton = panel.createEl('button', { text: '+ 경로 추가' });
		addButton.addEventListener('click', () => {
			paths.push('');
			renderPathRows();
		});

		const applyButton = panel.createEl('button', { text: '적용' });
		applyButton.addEventListener('click', () => {
			const { accepted: folderPaths, rejectedOutsideVault, rejectedInvalid, rejectedPaperGraphRoot } =
				PersonalNoteMiddleware.normalizeFolderPaths(paths);
			const hasRejected =
				rejectedOutsideVault.length > 0 || rejectedInvalid.length > 0 || rejectedPaperGraphRoot.length > 0;
			if (hasRejected) {
				// 원인마다 다른 안내를 띄운다 — 뭉뚱그리면 "왜 안 되는지" 알기 어렵다(QA #68:
				// 볼트 밖 경로가 조용히 "0개 수집중"으로만 뜨던 문제).
				if (rejectedOutsideVault.length > 0) {
					PersonalNoteMiddleware.notify(
						`볼트 바깥을 가리키는 경로는 사용할 수 없습니다 — 제외됨: ${rejectedOutsideVault.join(', ')}`,
					);
				}
				if (rejectedInvalid.length > 0) {
					PersonalNoteMiddleware.notify(
						`사용할 수 없는 문자가 포함된 경로입니다 — 제외됨: ${rejectedInvalid.join(', ')}`,
					);
				}
				if (rejectedPaperGraphRoot.length > 0) {
					PersonalNoteMiddleware.notify(
						`"${PAPER_GRAPH_ROOT}" 폴더(및 하위 경로)는 개인 노트 폴더로 지정할 수 없습니다 — 제외됨: ${rejectedPaperGraphRoot.join(', ')}`,
					);
				}
				// 거부된 경로가 있으면 저장/재실행을 아예 진행하지 않는다 — 입력 목록에서
				// 거부된 값만 지우고 사용자가 다시 "적용"을 눌러야 나머지 경로가 반영된다.
				// (거부와 저장을 한 클릭에서 같이 처리하면 반쯤 적용된 상태로 rerun이 걸려
				// 버튼이 계속 비활성으로 남는 사례가 있었다 — QA 재현.)
				paths.length = 0;
				paths.push(...(folderPaths.length > 0 ? folderPaths : ['']));
				renderPathRows();
				return;
			}
			// 경로를 하나도 안 고쳤거나(빈 칸 행만 추가하고 채우지 않은 경우 포함) 결과가
			// 저장된 값과 똑같으면 저장/재실행을 건너뛴다 — 매번 전체 파이프라인(전체 논문
			// 재로드 -> PCA -> 모든 시각화 미들웨어 -> 렌더)을 다시 도는 건 비용이 크다.
			if (PersonalNoteMiddleware.sameFolderSet(folderPaths, config.folderPaths)) {
				PersonalNoteMiddleware.notify('경로에 변경 사항이 없어 적용하지 않았습니다.');
				paths.length = 0;
				paths.push(...(folderPaths.length > 0 ? folderPaths : ['']));
				renderPathRows();
				return;
			}
			applyButton.disabled = true;
			// rerun()은 이 미들웨어만 도는 게 아니라 VisualizationFlow.run() 전체(전체 논문
			// 재로드 -> PCA -> 모든 시각화 미들웨어 -> 렌더)를 다시 돈다 — 노트가 몇 개 안 돼도
			// 논문이 많은 그래프에서는 눈에 띄게 오래 걸릴 수 있다. QA #4: 이 대기 시간 동안
			// 버튼이 그냥 "적용"인 채로 흐려지기만 해서 "눌러도 반응 없음/활성화 안 됨"으로
			// 오인됐다 — 처리 중임을 텍스트로도 드러낸다. (rerun()이 성공하면 render()가
			// container를 갈아치우면서 이 버튼 자체가 새 패널의 새 버튼으로 교체되므로, 아래
			// finally의 복원은 실패/조기 반환 등 이 버튼이 그대로 남는 경우에만 의미가 있다.)
			applyButton.setText('적용 중…');
			void this.writeConfig({ ...config, folderPaths })
				.then(() => this.rerun())
				.then(() => {
					// rerun()이 끝나면 이 미들웨어의 run()이 이미 새로 돌아 noteFilesBySourceId가
					// 방금 적용된 경로 기준으로 다시 채워져 있다 — 별도 카운팅 없이 그대로 읽는다.
					PersonalNoteMiddleware.notify(`개인 노트 노드 ${this.noteFilesBySourceId.size}개 추가됨`);
				})
				.catch((error: unknown) => {
					PersonalNoteMiddleware.notify(
						`개인 노트 폴더 적용 실패: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => {
					applyButton.disabled = false;
					applyButton.setText('적용');
				});
		});
	}

	// 앞뒤 슬래시만 정리한다 — 나머지는 run()의 file.path 비교 로직이 그대로 처리한다.
	private static normalizeFolderPath(raw: string): string {
		return raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
	}

	// 두 경로 목록이 (순서 무시하고) 같은 집합인지. "적용"이 실제로 뭔가 바꾸는지 판단하는
	// 데 쓴다 — b(저장된 config.folderPaths)는 과거에 이미 normalizeFolderPath를 거쳐
	// 저장된 값일 수도, 아닐 수도 있어(구버전 스키마 등) 여기서도 다시 정규화해 비교한다.
	private static sameFolderSet(a: string[], b: string[]): boolean {
		const normalize = (list: string[]): string[] =>
			[
				...new Set(
					list.map((p) => PersonalNoteMiddleware.normalizeFolderPath(p)).filter((p) => p.length > 0),
				),
			].sort();
		const na = normalize(a);
		const nb = normalize(b);
		return na.length === nb.length && na.every((value, index) => value === nb[index]);
	}

	// 각 행을 정리하고, 빈 입력(사용자가 지우고 안 채운 행)·중복 경로·볼트 밖을 가리키는
	// 경로·금지 문자가 섞인 경로·PAPER_GRAPH_ROOT 하위 경로(논문/캐시/설정이 있는 곳)는
	// 저장에서 뺀다. 세 거부 종류를 따로 모으는 이유는 원인마다 사용자에게 다른 안내를
	// 보여주기 위함 — 뭉뚱그리면 "왜 안 되는지" 알기 어렵다.
	private static normalizeFolderPaths(raw: string[]): {
		accepted: string[];
		rejectedOutsideVault: string[];
		rejectedInvalid: string[];
		rejectedPaperGraphRoot: string[];
	} {
		const seen = new Set<string>();
		const accepted: string[] = [];
		const rejectedOutsideVault: string[] = [];
		const rejectedInvalid: string[] = [];
		const rejectedPaperGraphRoot: string[] = [];
		for (const value of raw) {
			const trimmed = value.trim();
			if (!trimmed) {
				continue;
			}
			// 정규화(슬래시 정리) 전에 판정한다 — 드라이브 문자·UNC·".."나 금지 문자는
			// normalizeFolderPath가 손대기 전의 원형에서 봐야 정확하다.
			if (PersonalNoteMiddleware.isOutsideVaultPath(trimmed)) {
				rejectedOutsideVault.push(trimmed);
				continue;
			}
			if (PersonalNoteMiddleware.hasInvalidPathChars(trimmed)) {
				rejectedInvalid.push(trimmed);
				continue;
			}
			const normalized = PersonalNoteMiddleware.normalizeFolderPath(trimmed);
			if (!normalized || seen.has(normalized)) {
				continue;
			}
			seen.add(normalized);
			if (PersonalNoteMiddleware.isWithinPaperGraphRoot(normalized)) {
				rejectedPaperGraphRoot.push(normalized);
				continue;
			}
			accepted.push(normalized);
		}
		return { accepted, rejectedOutsideVault, rejectedInvalid, rejectedPaperGraphRoot };
	}

	// 볼트 밖을 가리키려는 경로인지: 드라이브 절대 경로(C:\...), UNC 경로(\\server\share),
	// 상위 폴더 이동(..)으로 볼트 루트 밖을 가리키려는 시도. Obsidian의 TFile.path는
	// 항상 볼트 상대 경로라 이런 값은 애초에 아무 파일과도 안 맞고(QA #68: 조용히 "0개
	// 수집중"만 뜸), 그래서 여기서 미리 걸러 이유를 알려준다.
	private static isOutsideVaultPath(path: string): boolean {
		return (
			/^[a-zA-Z]:[\\/]/.test(path) ||
			/^\\\\/.test(path) ||
			path.split(/[\\/]+/).includes('..')
		);
	}

	// OS 파일명 금지 문자(Windows 기준 < > : " | ? *)·제어 문자·백슬래시(Obsidian 경로
	// 구분자는 '/'뿐이라 '\'는 항상 오타/다른 OS 경로 표기로 본다)가 섞인 경로.
	private static hasInvalidPathChars(path: string): boolean {
		// eslint-disable-next-line no-control-regex -- 제어 문자를 의도적으로 걸러낸다.
		return /[<>:"|?*\\\x00-\x1f]/.test(path);
	}

	// path가 PAPER_GRAPH_ROOT 자신이거나 그 하위인지. 논문 md·노트 캐시·설정 파일이 전부
	// 이 아래에 있으므로, 이 영역을 노트 소스로 허용하면 논문이 "노트"로 재임베딩되거나
	// 캐시/설정 폴더를 노트 폴더로 지정해 파이프라인이 깨진다.
	private static isWithinPaperGraphRoot(path: string): boolean {
		return path === PAPER_GRAPH_ROOT || path.startsWith(`${PAPER_GRAPH_ROOT}/`);
	}
}
