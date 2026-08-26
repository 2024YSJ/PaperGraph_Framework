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

import { hasCollectableConditions, parseLocalDateInput } from '../src/adapter/SubscriptionTargetModal';

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

	it('존재하지 않는 날짜(9월 31일)는 undefined다 — Date 생성자의 정규화를 막았다 (12번)', () => {
		// JS Date 생성자는 초과값을 조용히 굴린다: new Date(2012, 8, 31) === 10월 1일.
		// 예전엔 이 함수가 모양 정규식만 보고 그대로 통과시켜서, 사용자가 고르지도 않은
		// 날짜로 수집 구간이 잡혔다. 이제 isCalendarDate로 달력 유효성까지 확인해 거부한다.
		assert.equal(parseLocalDateInput('2012-09-31'), undefined);
		assert.equal(parseLocalDateInput('2026-02-31'), undefined);
		assert.equal(parseLocalDateInput('2026-13-01'), undefined);
		assert.equal(parseLocalDateInput('2026-03-50'), undefined);
	});

	it('윤년 2월 29일은 통과한다 — 검증이 과하게 막지 않는다', () => {
		assert.notEqual(parseLocalDateInput('2024-02-29'), undefined);
		assert.equal(parseLocalDateInput('2025-02-29'), undefined);
	});
});

describe('hasCollectableConditions', () => {
	// File.readSubscriptions는 조건이 전부 걸러진 구독(querys: [])을 파일에서 완전히
	// 안 지운다(File.ts 주석 참고 — apiName 미등록 구독을 조용히 지우는 사고를 막는
	// 안전장치와 같은 코드 경로를 타서). 그 결과가 이 선택 창에도 그대로 흘러들어와
	// 빈 라벨의 토글로 뜨던 문제(실사용 재현: 수동 편집으로 카테고리 조건이 걸러진
	// 구독이 "실행" 대상으로 선택 가능하게 남음)를 이 필터가 막는다.
	it('querys가 빈 구독은 걸러진다', () => {
		assert.equal(hasCollectableConditions({ apiName: 'arxiv', querys: [] }), false);
	});

	it('조건이 하나라도 있으면 통과한다', () => {
		assert.equal(
			hasCollectableConditions({
				apiName: 'arxiv',
				querys: [{ searchType: 'keyword', query: 'graph' }],
			}),
			true,
		);
	});
});
