// API 키를 "provider 식별자 → 키 문자열" 맵으로 보관한다.
// named field로 나열하거나 string[]로 두지 않는 이유는 docs/devLog/002.md 참고:
//   - 확장성: 새 API가 추가돼도 이 클래스를 수정하지 않는다.
//   - 식별: 순서(index)에 의존하지 않고 provider 키로 조회 → 구독 추가/삭제에 안전.
//   - 직렬화: Record가 그대로 JSON 객체로 저장/로드된다 (Secret.json, File 담당).
// provider 식별자는 Subscriptions의 API 식별 체계, Paper.collectedApi와 동일하게 쓴다.
export class Secret {
	private apiKeys: Record<string, string> = {};

	// 해당 provider의 API 키를 조회한다. 없으면 undefined.
	getKey(provider: string): string | undefined {
		return this.apiKeys[provider];
	}

	// provider의 API 키를 등록/갱신한다.
	setKey(provider: string, key: string): void {
		this.apiKeys[provider] = key;
	}

	// provider 키가 등록돼 있는지 확인한다.
	hasKey(provider: string): boolean {
		return provider in this.apiKeys;
	}

	// File이 Secret.json으로 저장할 때 쓰는 평문 맵. 복사본을 넘겨 내부 상태 보호.
	toJSON(): Record<string, string> {
		return { ...this.apiKeys };
	}

	// File이 Secret.json을 읽어 Secret을 복원할 때 쓴다.
	static fromJSON(data: Record<string, string>): Secret {
		const secret = new Secret();
		secret.apiKeys = { ...data };
		return secret;
	}
}
