import { Secret } from './Secret';
import { API } from './API';

// 데이터 홀더. 수집 커서는 여기 없다 — 구독마다 독립이라 각 API 인스턴스가
// updateTime을 들고 있다(API.updateTime 주석 참고). Subscriptions는 그 인스턴스들의
// 목록과 인증 정보만 묶는다.
export class Subscriptions {
	secret!: Secret;
	apis!: API[];
}
