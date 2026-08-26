// ⚠️ 임시 테스트 헬퍼 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import type { Vault } from 'obsidian';
import { TFile, TFolder } from '../stubs/obsidian';

// 메모리 위의 Vault 대역. File 클래스를 대역으로 갈아끼우지 않고 실제 구현을 그대로
// 돌리기 위한 것이다 — 커서가 정말 JSON으로 왕복하는지, writePaper가 기존 파일을 읽어
// 출처를 병합하는지 같은 동작은 File을 흉내 내면 검증되지 않는다.
export class VaultStub {
	// 경로 -> 내용. .json/.md와 플러그인 폴더의 설정 파일이 같은 맵에 들어간다
	// (adapter 경로와 Vault 경로가 겹치지 않으므로 충돌하지 않는다).
	readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();

	// ── Vault API (콘텐츠 트리) ────────────────────────────────────
	// File.readAllPapers/readPapersByYear가 전체 목록을 훑을 때 쓴다.
	getFiles(): TFile[] {
		return [...this.files.keys()].map((path) => new TFile(path));
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		if (this.files.has(path)) {
			return new TFile(path);
		}
		return this.folders.has(path) ? new TFolder(path) : null;
	}

	read(file: TFile): Promise<string> {
		return Promise.resolve(this.files.get(file.path) ?? '');
	}

	modify(file: TFile, text: string): Promise<void> {
		this.files.set(file.path, text);
		return Promise.resolve();
	}

	create(path: string, text: string): Promise<TFile> {
		this.files.set(path, text);
		return Promise.resolve(new TFile(path));
	}

	createFolder(path: string): Promise<void> {
		this.folders.add(path);
		return Promise.resolve();
	}

	// File.renamePaperFiles(제목 변경 시 옛 파일을 새 경로로 옮기는 데 씀)가 사용한다.
	rename(file: TFile, newPath: string): Promise<void> {
		const text = this.files.get(file.path) ?? '';
		this.files.delete(file.path);
		this.files.set(newPath, text);
		return Promise.resolve();
	}

	// ── adapter API (플러그인 폴더의 Secret/Subscriptions) ──────────
	// rename/remove는 File.writeConfig의 임시 파일 → rename 원자적 쓰기가 쓴다.
	readonly adapter = {
		exists: (path: string): Promise<boolean> => Promise.resolve(this.files.has(path)),
		read: (path: string): Promise<string> => Promise.resolve(this.files.get(path) ?? ''),
		write: (path: string, text: string): Promise<void> => {
			this.files.set(path, text);
			return Promise.resolve();
		},
		remove: (path: string): Promise<void> => {
			this.files.delete(path);
			return Promise.resolve();
		},
		rename: (path: string, newPath: string): Promise<void> => {
			const text = this.files.get(path) ?? '';
			this.files.delete(path);
			this.files.set(newPath, text);
			return Promise.resolve();
		},
	};

	// File.init에 넘기기 위한 캐스팅. 대역은 실제로 쓰이는 메서드만 구현한다.
	asVault(): Vault {
		return this as unknown as Vault;
	}

	// 저장된 논문 .json들(경로 순). 수집 결과를 확인할 때 쓴다.
	storedPapers(): { path: string; paper: Record<string, unknown> }[] {
		return [...this.files.entries()]
			.filter(([path]) => path.startsWith('PaperGraph3D/') && path.endsWith('.json'))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([path, text]) => ({
				path,
				paper: (JSON.parse(text) as { paper: Record<string, unknown> }).paper,
			}));
	}
}
