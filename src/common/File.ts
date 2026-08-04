import { TFile, Vault } from 'obsidian';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';
import { API, ArxivAPI } from '../collect/API';
import { SearchQuery } from '../collect/SearchQuery';

// .json 저장 래퍼. schemaVersion은 향후 대비 상수(현재 분기/마이그레이션엔 안 씀).
// 설계 근거: docs/devLog/002.md.
export interface StoredPaperFile {
	schemaVersion: number;
	paper: Paper; // Paper 필드 그대로 (embedding 포함)
	createdAt: number;
	updatedAt: number;
}

// 파일명 정제용. Windows/macOS/Linux 공통 금지/예약 문자 + 제어문자. ($/{/} 는 유지)
// eslint-disable-next-line no-control-regex -- 파일명에서 제어문자 제거는 의도된 동작
const ILLEGAL_CHARS = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g');
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_TITLE_LENGTH = 100;

// .md 관리 본문 마커.
const NOTE_BEGIN = '<!-- pg3d:begin -->';
const NOTE_END = '<!-- pg3d:end -->';

// provider별 논문 웹 URL 생성기. 새 provider를 지원하려면 이 목록에 한 줄만 추가하면 되고
// paperUrl 함수 본문은 손대지 않는다(데이터 주도). localId는 sourceId의 ':' 뒤 부분.
const PAPER_URL_BUILDERS: Record<string, (localId: string) => string> = {
	arxiv: (localId) => `https://arxiv.org/abs/${localId}`,
	semanticScholar: (localId) => `https://www.semanticscholar.org/paper/${localId}`,
};

// 파일을 읽고 쓰는 static 클래스 (다이어그램 File 정의, 2026-08-02 회의). 인스턴스 없이
// File.메소드()로 접근하며, vault/플러그인 폴더 참조는 init()으로 한 번만 보관한다.
//   - Secret/Subscriptions: 플러그인 폴더의 JSON. vault.adapter로 접근. Secret은 난독화.
//   - Paper: 콘텐츠 트리(PaperGraph3D/YYYY/MM/DD/)의 .json + .md. 일반 Vault API로 접근.
// 파일명 규칙과 .md 형식은 기존 PaperGraph3D 프로젝트 로직을 이 클래스 private 메서드로
// 흡수한 것이다(기존 vault 파일과 100% 호환).
export class File {
	private static vault: Vault;
	private static pluginDir: string; // <vault.configDir>/plugins/papergraph3d

	private static readonly SCHEMA_VERSION = 4;
	// 난독화용 하드코딩 키(일단). ⚠️ 번들에서 추출 가능 — 실수 노출 방지 수준이지 암호화 아님.
	private static readonly OBFUSCATION_KEY = 'PaperGraph3D::pg3d-obfuscation-v1';

	private static readonly PAPER_ROOT = 'PaperGraph3D';

	static init(vault: Vault, pluginDir: string): void {
		File.vault = vault;
		File.pluginDir = pluginDir;
	}

	// ── Secret / Subscriptions (플러그인 폴더) ──────────────────────────

	static readSecret(): Promise<Secret> {
		return File.readConfig(
			'Secret.json',
			(raw) => Secret.fromJSON(raw as Record<string, string>),
			() => new Secret(),
			(text) => File.deobfuscate(text),
		);
	}

	static writeSecret(secret: Secret): Promise<void> {
		return File.writeConfig('Secret.json', secret.toJSON(), (text) => File.obfuscate(text));
	}

	// Secret.json도 함께 읽어 복원된 각 API 인스턴스에 실어 보낸다 — 저장된 Subscriptions.json
	// 자체엔 secret이 없다(writeSubscriptions가 의도적으로 제외, 아래 참고). readConfig의
	// revive 콜백은 동기 함수라 그 안에서 await할 수 없으므로, secret은 미리 읽어 클로저로
	// 넘긴다.
	static async readSubscriptions(): Promise<Subscriptions> {
		const secret = await File.readSecret();
		return File.readConfig(
			'Subscriptions.json',
			(raw) => {
				// 저장된 apis는 평범한 객체({ apiName, querys })라 메서드가 없다. createApi로
				// apiName에 맞는 구현 클래스를 인스턴스화해 메서드가 살아있는 API로 복원한다.
				const data = raw as {
					updateTime?: number;
					apis?: { apiName: string; querys?: SearchQuery[] }[];
				};
				const subscriptions = new Subscriptions();
				subscriptions.updateTime = data.updateTime ?? 0;
				subscriptions.secret = secret;
				subscriptions.apis = (data.apis ?? []).map((api) =>
					File.createApi(
						api.apiName,
						(api.querys ?? []).map((query) => File.migrateSearchType(query)),
						secret,
					),
				);
				return subscriptions;
			},
			() => {
				const subscriptions = new Subscriptions();
				subscriptions.secret = secret;
				return subscriptions;
			},
		);
	}

	// 이름이 바뀐 searchType을 현재 값으로 옮긴다. 설정탭이 'domain'을 저장하던 시절의
	// Subscriptions.json이 그대로 남아 있으면, 복원된 구독으로 수집할 때 arXiv 쪽에서
	// "Unknown searchType"으로 throw해 해당 구독 전체가 실패한다. 읽는 시점에 한 번
	// 정규화해 두면 저장 파일이 다음 writeSubscriptions에서 자연스럽게 갱신된다.
	private static readonly SEARCH_TYPE_ALIASES: Record<string, string> = {
		domain: 'category',
	};

	// typeof 검사는 프로토타입 체인 방어다. searchType이 'toString' 같은 값이면 맵에서
	// 함수가 잡히는데, truthy라서 그대로 searchType에 대입돼버린다.
	private static migrateSearchType(query: SearchQuery): SearchQuery {
		const renamed = File.SEARCH_TYPE_ALIASES[query.searchType];
		return typeof renamed === 'string' ? { ...query, searchType: renamed } : query;
	}

	static writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		// secret은 별도 Secret.json(난독화)에만 저장한다. Subscriptions.json에 함께 넣으면
		// API 키가 평문으로 중복 저장되므로 제외한다.
		return File.writeConfig('Subscriptions.json', {
			updateTime: subscriptions.updateTime,
			apis: subscriptions.apis,
		});
	}

	// apiName에 따라 API 구현 클래스를 인스턴스화한다. Subscriptions.json에서 읽은
	// 평범한 객체({ apiName, querys })를 메서드가 살아있는 API 인스턴스로 복원할 때 쓴다
	// (JSON 복원 시 메서드가 사라지는 문제 해결 — 002.md). 새 API는 case를 한 줄 추가한다.
	// secret은 선택 사항 — 없으면 각 API 구현체가 알아서 익명으로 동작한다.
	static createApi(apiName: string, querys: SearchQuery[] = [], secret?: Secret): API {
		switch (apiName) {
			case 'arxiv':
				return new ArxivAPI(querys, secret);
			default:
				throw new Error(`Unknown apiName: ${apiName}`);
		}
	}

	// ── Paper (콘텐츠 트리, .json + .md) ────────────────────────────────

	// 해당 연도 폴더(PaperGraph3D/<year>/) 아래 모든 .json을 읽어 Paper 배열로 반환.
	// 경로가 날짜로 결정되므로 연도만 있으면 sourceId 조회/인덱스 없이 일괄 로드된다.
	static async readPapersByYear(year: number): Promise<Paper[]> {
		const prefix = `${File.PAPER_ROOT}/${year}/`;
		const files = File.vault
			.getFiles()
			.filter((f) => f.path.startsWith(prefix) && f.extension === 'json');
		const papers: Paper[] = [];
		for (const file of files) {
			const wrapper = JSON.parse(await File.vault.read(file)) as StoredPaperFile;
			papers.push(Object.assign(new Paper(), wrapper.paper));
		}
		return papers;
	}

	// .json(진실 원본)과 .md(Obsidian 뷰)를 함께 쓴다. 재작성 시 기존 createdAt / 사용자
	// 자유 본문을 보존한다.
	static async writePaper(paper: Paper): Promise<void> {
		await File.writePaperAt(paper, File.resolvePaperPath(paper));
	}

	// 테스트/검증용: 정식 수집 경로(PaperGraph3D/<year>/<month>/<day>) 대신 지정한 폴더
	// 바로 아래에 저장한다. .json+.md 형식과 upsert(생성 또는 갱신) 동작은 writePaper와
	// 동일 — readPapersByYear는 PaperGraph3D/<year>/ 접두사만 보므로 이 폴더 아래 파일은
	// 정식 수집 데이터와 섞이지 않는다(임베딩 테스트용 SettingTab 버튼에서 사용).
	static async writeTestPaper(paper: Paper, folder: string): Promise<void> {
		await File.writePaperAt(paper, `${folder}/${File.baseNoteName(paper.title, paper.sourceId)}`);
	}

	private static async writePaperAt(paper: Paper, base: string): Promise<void> {
		const jsonPath = `${base}.json`;
		const mdPath = `${base}.md`;

		const existingJson = await File.readVaultText(jsonPath);
		const createdAt = existingJson
			? (JSON.parse(existingJson) as StoredPaperFile).createdAt
			: Date.now();

		const existingMd = await File.readVaultText(mdPath);
		const userBody = existingMd ? File.parseUserBody(existingMd) : '';

		const wrapper: StoredPaperFile = {
			schemaVersion: File.SCHEMA_VERSION,
			paper,
			createdAt,
			updatedAt: Date.now(),
		};
		await File.writeVaultText(jsonPath, JSON.stringify(wrapper, null, 2));
		await File.writeVaultText(mdPath, File.renderNote(paper, userBody));
	}

	// ── config 공통: encode/decode는 옵션(기본=평문 통과). Secret만 난독화 변환을 넘긴다.

	private static async readConfig<T>(
		name: string,
		revive: (raw: unknown) => T,
		fallback: () => T,
		decode: (text: string) => Promise<string> | string = (t) => t,
	): Promise<T> {
		const path = `${File.pluginDir}/${name}`;
		if (!(await File.vault.adapter.exists(path))) {
			return fallback();
		}
		const text = await decode(await File.vault.adapter.read(path));
		return revive(JSON.parse(text));
	}

	private static async writeConfig(
		name: string,
		data: unknown,
		encode: (text: string) => Promise<string> | string = (t) => t,
	): Promise<void> {
		const text = await encode(JSON.stringify(data, null, 2));
		await File.vault.adapter.write(`${File.pluginDir}/${name}`, text);
	}

	// ── 콘텐츠 트리 텍스트 I/O (.json/.md 공용) ─────────────────────────

	private static async readVaultText(path: string): Promise<string | null> {
		const f = File.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? File.vault.read(f) : null;
	}

	private static async writeVaultText(path: string, text: string): Promise<void> {
		const existing = File.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await File.vault.modify(existing, text);
			return;
		}
		const folder = path.slice(0, path.lastIndexOf('/'));
		if (folder && !File.vault.getAbstractFileByPath(folder)) {
			await File.vault.createFolder(folder).catch(() => {
				/* 이미 있으면 무시 (동시 생성 경쟁 대비) */
			});
		}
		await File.vault.create(path, text);
	}

	// ── 난독화 (하드코딩 키 XOR + base64). 진짜 암호화 아님(002.md). ──────

	private static obfuscate(plain: string): string {
		const key = File.OBFUSCATION_KEY;
		const bytes = new TextEncoder().encode(plain);
		let binary = '';
		for (let i = 0; i < bytes.length; i += 1) {
			binary += String.fromCharCode((bytes[i] as number) ^ key.charCodeAt(i % key.length));
		}
		return btoa(binary);
	}

	private static deobfuscate(cipher: string): string {
		const key = File.OBFUSCATION_KEY;
		const binary = atob(cipher);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i) ^ key.charCodeAt(i % key.length);
		}
		return new TextDecoder().decode(bytes);
	}

	// ── 파일명 규칙 (기존 프로젝트 filename.ts 로직 흡수) ────────────────

	// `.json`/`.md` 쌍이 공유하는 확장자 없는 전체 경로:
	// `PaperGraph3D/<YYYY>/<MM>/<DD>/<정제한 title> (<localId>)`.
	private static resolvePaperPath(paper: Paper): string {
		return `${File.PAPER_ROOT}/${File.publicationDir(paper)}/${File.baseNoteName(paper.title, paper.sourceId)}`;
	}

	// 논문의 연/월/일 폴더. 기존은 publicationYear를 썼으나 새 Paper는 이를 제거해
	// publicationDate(ISO)에서 연도까지 파생한다. 유효한 날짜가 없으면 'unknown'.
	private static publicationDir(paper: Paper): string {
		if (/^\d{4}-\d{2}-\d{2}$/.test(paper.publicationDate)) {
			return `${paper.publicationDate.slice(0, 4)}/${paper.publicationDate.slice(5, 7)}/${paper.publicationDate.slice(8, 10)}`;
		}
		return 'unknown';
	}

	// 제목(NFC 정규화, 금지/제어문자 제거, 공백 정리, 길이 제한) + 괄호 안 provider-local id,
	// 예: 'Attention Is All You Need (2401.12345)'. 제목이 없으면 sourceId 정제로 폴백.
	private static baseNoteName(title: string, sourceId: string): string {
		const cleanTitle = title
			.normalize('NFC')
			.replace(ILLEGAL_CHARS, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, MAX_TITLE_LENGTH)
			.replace(/[ .]+$/g, '');
		if (cleanTitle.length === 0) {
			return File.sanitizeStem(sourceId);
		}
		const localId = sourceId.slice(sourceId.indexOf(':') + 1);
		return File.sanitizeStem(`${cleanTitle} (${localId})`);
	}

	// 금지 문자 -> '_', 뒤쪽 점/공백 정리. 되돌릴 수 없음 — 진짜 키는 콘텐츠의 sourceId.
	private static sanitizeStem(raw: string): string {
		let stem = raw.replace(ILLEGAL_CHARS, '_').replace(/[ .]+$/g, '');
		if (stem.length === 0) {
			stem = '_';
		}
		if (WINDOWS_RESERVED.test(stem)) {
			stem = `_${stem}`;
		}
		return stem;
	}

	// ── .md 렌더링/파싱 (기존 프로젝트 note.ts 로직 흡수) ────────────────

	// 관리 영역(frontmatter + pg3d 마커 본문) 뒤에 사용자 자유 본문을 그대로 이어붙인다.
	private static renderNote(paper: Paper, previousUserBody: string): string {
		return `---\n${File.renderFrontmatter(paper)}\n---\n${NOTE_BEGIN}\n${paper.abstract}\n${NOTE_END}\n${previousUserBody}`;
	}

	// schemaVersion/타임스탬프/임베딩 벡터는 .json에만. references는 읽기 좋게 미러링.
	// 문자열 값은 JSON.stringify로 따옴표 처리한다(= 유효한 YAML 이중따옴표 스칼라라
	// 제목의 ':' 등 특수문자가 있어도 안전).
	private static renderFrontmatter(paper: Paper): string {
		const lines: string[] = [`title: ${JSON.stringify(paper.title)}`];
		if (paper.authors.length === 0) {
			lines.push('authors: []');
		} else {
			lines.push('authors:');
			for (const author of paper.authors) {
				lines.push(`  - ${JSON.stringify(author)}`);
			}
		}
		// 새 Paper는 publicationYear를 제거 → publicationDate(ISO)에서 연도 파생.
		if (/^\d{4}-\d{2}-\d{2}$/.test(paper.publicationDate)) {
			lines.push(`publicationYear: ${Number(paper.publicationDate.slice(0, 4))}`);
		}
		if (paper.publicationDate) {
			lines.push(`publicationDate: ${JSON.stringify(paper.publicationDate)}`);
		}
		lines.push(`citationCount: ${paper.citationCount}`);
		// 외향 인용 3상태(citationsKnown 기준): 미확인 null / 확인+없음 [] / 확인+있음 목록.
		if (!paper.citationsKnown) {
			lines.push('references: null');
		} else if (paper.references.length === 0) {
			lines.push('references: []');
		} else {
			lines.push('references:');
			for (const reference of paper.references) {
				lines.push(`  - ${JSON.stringify(reference)}`);
			}
		}
		lines.push(`pg3d_sourceId: ${JSON.stringify(paper.sourceId)}`);
		const url = File.paperUrl(paper.sourceId);
		if (url !== undefined) {
			lines.push(`url: ${JSON.stringify(url)}`);
		}
		return lines.join('\n');
	}

	// 표준 웹 URL을 sourceId에서 파생(저장 안 함). provider별 규칙은 PAPER_URL_BUILDERS
	// 레지스트리에서 조회한다 — 알 수 없는 provider면 undefined(frontmatter에서 줄 생략).
	private static paperUrl(sourceId: string): string | undefined {
		const separator = sourceId.indexOf(':');
		if (separator <= 0) {
			return undefined;
		}
		const provider = sourceId.slice(0, separator);
		const localId = sourceId.slice(separator + 1);
		if (localId.length === 0) {
			return undefined;
		}
		const build = PAPER_URL_BUILDERS[provider];
		return build ? build(localId) : undefined;
	}

	// 기존 .md에서 사용자 자유 본문(pg3d 마커 뒤)만 추출해 보존한다. 앞쪽 frontmatter
	// 블록은 내용 파싱 없이 건너뛴다. 우리 마커가 없으면(우리 노트가 아니면) 남은 내용을
	// 그대로 보존한다.
	private static parseUserBody(text: string): string {
		let rest = text;
		if (rest.startsWith('---\n')) {
			const end = rest.indexOf('\n---', 4);
			if (end !== -1) {
				rest = rest.slice(end + 4).replace(/^\n/, '');
			}
		}
		const endMarker = rest.indexOf(NOTE_END);
		if (endMarker !== -1) {
			return rest.slice(endMarker + NOTE_END.length).replace(/^\n/, '');
		}
		return rest;
	}
}
