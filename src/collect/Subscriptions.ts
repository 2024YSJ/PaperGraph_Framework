import { Secret } from './Secret';
import { API } from './API';

// 빈 껍데기(데이터 홀더) — 우빈이 채운다.
export class Subscriptions {
	updateTime!: number;
	secret!: Secret;
	apis!: API[];
}
