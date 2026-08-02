import { Plugin } from 'obsidian';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';

// Secret/Subscriptions(API 키 등 보안 정보)를 담당하는 static 클래스. Vault 파일이
// 아니라 Obsidian 플러그인 데이터(Plugin.saveData/loadData, .obsidian/plugins/
// papergraph3d/data.json)에 암호화해서 저장할 예정 — PaperStore와 저장 매체 자체가
// 다르므로 Vault가 아닌 Plugin 인스턴스를 들고 있는다.
export class SecretStore {
	private static plugin: Plugin;

	static init(plugin: Plugin): void {
		SecretStore.plugin = plugin;
	}

	// TODO: 암호화 키 출처(사용자 패스프레이즈 vs OS 자격 증명 저장소 vs 기타)가 아직
	// 미정 — plugin 데이터 폴더에 저장하는 것만으로는 vault 파일과 보안 수준이 같다
	// (둘 다 평문이면 동기화/백업 경로로 그대로 노출됨). 우빈이 구현 전 팀과 재확인할 것.
	static async readSecret(): Promise<Secret> {
		throw new Error('Not implemented: SecretStore.readSecret');
	}

	static async writeSecret(secret: Secret): Promise<void> {
		throw new Error('Not implemented: SecretStore.writeSecret');
	}

	static async readSubscriptions(): Promise<Subscriptions> {
		throw new Error('Not implemented: SecretStore.readSubscriptions');
	}

	static async writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		throw new Error('Not implemented: SecretStore.writeSubscriptions');
	}
}
