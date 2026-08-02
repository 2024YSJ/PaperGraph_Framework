import { Vault } from 'obsidian';
import { File } from '../common/File';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';

// File 인터페이스의 Obsidian 구현체. 저장 매체(실제 Secret.json/Subscriptions.json
// 파일 vs Obsidian data.json)가 아직 결정되지 않아 본문은 전부 미구현 상태로 둔다
// (2026-08-02 회의). 생성자만 안전하게 vault 참조를 보관한다.
export class ObsidianFileAdapter implements File {
	constructor(private vault: Vault) {}

	async readSecret(): Promise<Secret> {
		throw new Error('Not implemented: ObsidianFileAdapter.readSecret');
	}

	async writeSecret(secret: Secret): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writeSecret');
	}

	async readSubscriptions(): Promise<Subscriptions> {
		throw new Error('Not implemented: ObsidianFileAdapter.readSubscriptions');
	}

	async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writeSubscriptions');
	}

	async readPaper(sourceId: string): Promise<Paper | null> {
		throw new Error(`Not implemented: ObsidianFileAdapter.readPaper(${sourceId})`);
	}

	async writePaper(paper: Paper): Promise<void> {
		throw new Error('Not implemented: ObsidianFileAdapter.writePaper');
	}
}
