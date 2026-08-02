import { Subscriptions } from './Subscriptions';
import { Embedding } from './Embedding';
import { Middleware } from '../common/Middleware';

export class CollectAndSave {
	sub!: Subscriptions;
	embedding!: Embedding;
	middlewares: Middleware[] = [];

	// 등록 계열: 안전하게 동작한다.
	setMiddleware(mw: Middleware): void {
		this.middlewares.push(mw);
	}

	// 실행 계열: 아직 미구현.
	//
	// 구현 시 지킬 흐름 (다이어그램 명시):
	//   전체 데이터 수집 -> 미들웨어(all) -> loop { 임베딩 -> 미들웨어(forEach) -> 데이터 저장 }
	// 이 흐름 제어는 run() 안에서만 하고, 세부 함수가 미들웨어를 직접 호출하지 않는다.
	// mode로 backfill과 최근 논문 수집을 구분해 run() 내부 if문으로 분기한다.
	async run(mode: 'recent' | 'backfill'): Promise<void> {
		throw new Error(`Not implemented: CollectAndSave.run(${mode})`);
	}
}
