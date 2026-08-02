import { Vault } from 'obsidian';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';

// File 인터페이스(src/common/File.ts)의 Obsidian 구현체. 저장 매체(실제
// Secret.json/Subscriptions.json 파일 vs Obsidian data.json)가 아직 결정되지 않아
// 본문은 전부 미구현 상태로 둔다 (2026-08-02 회의). 인스턴스를 만들 필요 없이
// static으로 접근하며, vault 참조는 init()으로 한 번만 보관한다.
export class ObsidianFileAdapter {
	private static vault: Vault;

	static init(vault: Vault): void {
		ObsidianFileAdapter.vault = vault;
	}

	static async readSecret(): Promise<Secret> {
		throw new Error('Not implemented: ObsidianFileAdapter.readSecret');
	}

	static async writeSecret(secret: Secret): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writeSecret');
	}

	static async readSubscriptions(): Promise<Subscriptions> {
		throw new Error('Not implemented: ObsidianFileAdapter.readSubscriptions');
	}

	static async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writeSubscriptions');
	}

	static async readPaper(sourceId: string): Promise<Paper | null> {
		throw new Error(`Not implemented: ObsidianFileAdapter.readPaper(${sourceId})`);
	}

	static async writePaper(paper: Paper): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writePaper');
	}
}
