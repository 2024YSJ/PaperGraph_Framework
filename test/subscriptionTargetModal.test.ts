// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// SubscriptionTargetModal 자체(DOM 이벤트 타이밍)는 이 harness가 Obsidian 앱을 띄우지
// 않으므로 자동화 밖이다 — parseLocalDateInput만 순수 함수로 export되어 있어 여기서
// 경계값을 검증한다. 실제 버그(잘못된 날짜 재입력 후에도 거부됨)는 "이 함수가 무효
// 날짜를 어떻게 판정하는가"와 "실행 클릭 시 최신 DOM 값을 읽는가"가 결합된 문제라,
// 뒤쪽(DOM 직독)은 수동 QA로 남는다 — docs/devLog 또는 플랜 참고.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLocalDateInput } from '../src/adapter/SubscriptionTargetModal';

describe('parseLocalDateInput', () => {
	it('올바른 YYYY-MM-DD는 로컬 자정 timestamp로 파싱된다', () => {
		const ms = parseLocalDateInput('2025-03-10');
		assert.ok(ms !== undefined);
		const date = new Date(ms);
		assert.equal(date.getFullYear(), 2025);
		assert.equal(date.getMonth(), 2); // 0-indexed
		assert.equal(date.getDate(), 10);
	});

	it('빈 문자열은 undefined다 — <input type=date>가 무효 상태일 때 보고하는 값', () => {
		assert.equal(parseLocalDateInput(''), undefined);
	});

	it('형식이 아예 다른 문자열은 undefined다', () => {
		assert.equal(parseLocalDateInput('2025/03/10'), undefined);
		assert.equal(parseLocalDateInput('not-a-date'), undefined);
	});

	it('존재하지 않는 날짜(9월 31일)는 자동으로 다음 달로 정규화된다 — NaN이 아니다', () => {
		// JS Date 생성자의 특성: new Date(2012, 8, 31) === new Date(2012, 9, 1).
		// 즉 이 함수 자체는 "존재하지 않는 달력 날짜"를 걸러내지 못한다 — 실제 첫 거부는
		// 브라우저의 <input type=date>가 무효 세그먼트 조합에서 빈 문자열을 보고하는
		// 데서 온다(이 테스트가 그 사실을 문서화한다. 이 값이 언젠가 undefined로
		// 바뀐다면 아래 assert가 그 변화를 알려준다).
		const ms = parseLocalDateInput('2012-09-31');
		assert.notEqual(ms, undefined, 'Date 생성자가 초과값을 더 이상 정규화하지 않는 것으로 바뀌었다');
		const date = new Date(ms as number);
		assert.equal(date.getMonth(), 9, '9월 31일이 10월로 안 넘어갔다');
		assert.equal(date.getDate(), 1);
	});
});
