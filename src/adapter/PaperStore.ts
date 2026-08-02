import { Vault } from 'obsidian';
import { Paper } from '../collect/Paper';

// paper.json + paper.md(vault 노트)를 담당하는 static 클래스. 저장 매체는 Vault로
// 사실상 확정(사용자가 vault에서 직접 열어볼 노트여야 하므로). 인스턴스를 만들 필요
// 없이 static으로 접근하며, vault 참조는 init()으로 한 번만 보관한다.
export class PaperStore {
	private static vault: Vault;

	static init(vault: Vault): void {
		PaperStore.vault = vault;
	}

	// paper.json + paper.md 두 파일을 함께 다룬다 (다이어그램 PaperStore 클래스 주석 참고).
	static async readPaper(sourceId: string): Promise<Paper | null> {
		throw new Error(`Not implemented: PaperStore.readPaper(${sourceId})`);
	}

	static async writePaper(paper: Paper): Promise<void> {
		throw new Error('Not implemented: PaperStore.writePaper');
	}
}
