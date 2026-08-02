import { Vault } from 'obsidian';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';

// 다이어그램 정의대로 static 클래스로 둔다 (2026-08-02 회의 — 저장 매체를 인터페이스로
// 분리해둘 만큼 유동적이지 않다고 판단, Obsidian Vault로 확정). 인스턴스를 만들 필요
// 없이 static으로 접근하며, vault 참조는 init()으로 한 번만 보관한다.
export class File {
	private static vault: Vault;

	static init(vault: Vault): void {
		File.vault = vault;
	}

	static async readSecret(): Promise<Secret> {
		throw new Error('Not implemented: File.readSecret');
	}

	static async writeSecret(secret: Secret): Promise<void> {
		throw new Error('Not implemented: File.writeSecret');
	}

	static async readSubscriptions(): Promise<Subscriptions> {
		throw new Error('Not implemented: File.readSubscriptions');
	}

	static async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		throw new Error('Not implemented: File.writeSubscriptions');
	}

	// paper.json + paper.md 두 파일을 함께 다룬다 (다이어그램 File 클래스 주석 참고).
	static async readPaper(sourceId: string): Promise<Paper | null> {
		throw new Error(`Not implemented: File.readPaper(${sourceId})`);
	}

	static async writePaper(paper: Paper): Promise<void> {
		throw new Error('Not implemented: File.writePaper');
	}
}
