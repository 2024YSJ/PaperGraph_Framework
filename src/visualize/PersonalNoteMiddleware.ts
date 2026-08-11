import { App, TFile } from 'obsidian';
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

// TODO: 지금은 하드코딩. 설정 UI 브랜치와 머지된 뒤 SettingTab에서 지정 가능하게 바꾼다.
const TARGET_FOLDER = 'PersonalNotes';
// 노트 임베딩 캐시 위치 — 콘텐츠 트리(PaperGraph3D/) 아래, 노트의 vault 경로를 그대로
// 미러링한다. Secret.json처럼 플러그인 설정 폴더에 두는 방식이 아니라 Paper json/md와
// 같은 "콘텐츠 트리" 저장 방식을 따른다(사용자가 파일탐색기로도 확인 가능).
const CACHE_ROOT = 'PaperGraph3D/PersonalNotes';
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

export class PersonalNoteMiddleware implements Middleware {
	type: MiddlewareType = 'visual';

	// run()마다 새로 채운다 — 클릭 핸들러가 sourceId로 실제 파일을 찾을 때 쓴다.
	private noteFilesBySourceId = new Map<string, TFile>();

	constructor(
		private app: App,
		private embedding: Embedding,
	) {}

	async run(context: unknown): Promise<void> {
		const graph = context as GraphData;
		this.noteFilesBySourceId.clear();

		// 논문 노드가 하나도 없으면(PCA가 아직 안 돌았거나 실패) 이웃 기반 배치를 할 수
		// 없으므로 아무 것도 하지 않는다.
		if (graph.nodes.length === 0) {
			return;
		}

		const noteFiles = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path === TARGET_FOLDER || file.path.startsWith(`${TARGET_FOLDER}/`));
		if (noteFiles.length === 0) {
			return;
		}

		graph.events.nodeClick.push((node) => this.handleClick(node));

		// ⚠️ 반드시 순차 실행 — Embedding.embed()는 세션/서킷브레이커 상태를 락 없이
		// 공유해 동시 호출이 안전하지 않다(Embedding.embed 주석 참고).
		for (const file of noteFiles) {
			try {
				const node = await this.buildNoteNode(file, graph);
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
	}

	private async buildNoteNode(file: TFile, graph: GraphData): Promise<GraphNode | undefined> {
		const raw = await this.app.vault.cachedRead(file);
		const body = PersonalNoteMiddleware.stripFrontmatter(raw).trim();
		if (body.length < MIN_BODY_LENGTH) {
			return undefined;
		}
		const title = file.basename;

		const resolved = await this.resolveEmbedding(file, title, body);
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
	// 모델 미설치/임베딩 실패는 조용히 건너뛴다(시각화 자체는 계속 진행) — Log.warn만 남김.
	private async resolveEmbedding(
		file: TFile,
		title: string,
		body: string,
	): Promise<StoredNoteEmbedding | undefined> {
		const cached = await this.readCache(file.path);
		if (cached && cached.mtime === file.stat.mtime) {
			return cached;
		}

		if (!(await this.embedding.isModelInstalled())) {
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
		const file = this.app.vault.getAbstractFileByPath(this.cachePath(notePath));
		if (!(file instanceof TFile)) {
			return undefined;
		}
		try {
			return JSON.parse(await this.app.vault.read(file)) as StoredNoteEmbedding;
		} catch {
			// 캐시가 손상됐으면 없는 것과 동일하게 취급 — 아래에서 재임베딩된다.
			return undefined;
		}
	}

	// File.writeVaultText와 같은 "있으면 modify, 없으면 폴더 만들고 create" 패턴.
	private async writeCache(notePath: string, data: StoredNoteEmbedding): Promise<void> {
		const path = this.cachePath(notePath);
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
		if (!node.paper.sourceId.startsWith(NOTE_SOURCE_PREFIX)) {
			return;
		}
		const file = this.noteFilesBySourceId.get(node.paper.sourceId);
		if (!file) {
			return;
		}
		void this.app.workspace.getLeaf('tab').openFile(file);
	}
}
