import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { Paper } from '../collect/Paper';

// 저장 매체(Secret.json/Subscriptions.json 같은 실제 파일 vs Obsidian data.json)는
// 아직 합의되지 않았다 (2026-08-02 회의) — 그래서 File은 구현이 아닌 인터페이스로만
// 추상화한다. Obsidian 기반 구현체는 src/adapter/ObsidianFileAdapter.ts에 static
// 클래스로 두며, 이 계약을 인스턴스 없이 static 멤버로 만족시킨다.
export interface File {
	readSecret(): Promise<Secret>;
	writeSecret(secret: Secret): Promise<void>;
	readSubscriptions(): Promise<Subscriptions>;
	writeSubscriptions(subscriptions: Subscriptions): Promise<void>;
	// paper.json + paper.md 두 파일을 함께 다룬다 (다이어그램 File 클래스 주석 참고).
	readPaper(sourceId: string): Promise<Paper | null>;
	writePaper(paper: Paper): Promise<void>;
}
