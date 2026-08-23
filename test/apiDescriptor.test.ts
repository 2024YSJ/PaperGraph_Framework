// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// ApiDescriptor 레지스트리(findDescriptor/findApiNames)가 File/UI에 흩어져 있던
// QUERY_VALIDATORS/PAPER_URL_BUILDERS/API_FACTORIES 세 표와 ApiManagementModal의
// 하드코딩된 조건 드롭다운을 대체한다 — File과 UI는 이제 findDescriptor()만 부르고
// ArxivAPI를 직접 import하지 않는다. 여기서는 그 조회 계약 자체를 고정한다(개별
// 검증 규칙의 세부 동작은 arxivApi.test.ts가 이미 덮는다).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArxivAPI, findApiNames, findDescriptor } from '../src/collect/API';

describe('findDescriptor / findApiNames', () => {
	it('arxiv 서술자를 조회할 수 있다', () => {
		const descriptor = findDescriptor('arxiv');
		assert.ok(descriptor !== undefined);
		assert.equal(descriptor.apiName, 'arxiv');
		assert.equal(descriptor.create([]) instanceof ArxivAPI, true);
	});

	it('등록되지 않은 apiName은 undefined다 — File.createApi가 이를 보고 던진다', () => {
		assert.equal(findDescriptor('unknown-provider'), undefined);
	});

	it('findApiNames는 등록된 모든 apiName을 돌려준다', () => {
		assert.deepEqual(findApiNames(), ['arxiv']);
	});

	it('conditionFields가 UI 드롭다운/저장 검증의 유일한 출처다', () => {
		const fields = findDescriptor('arxiv')?.conditionFields ?? [];
		const names = fields.map((f) => f.name);
		assert.deepEqual(names, ['keyword', 'author', 'category']);

		const category = fields.find((f) => f.name === 'category');
		assert.equal(category?.validate('cs.LG'), true);
		assert.equal(category?.validate('cs.LG AND au:x'), false, '쿼리 문법 주입이 통과하면 안 된다(69번)');

		// keyword/author는 저장 계층에서 자유 텍스트다 — "의미 있는 값인가"는 File이
		// 아니라 UI/formatTerm의 몫이다(collectAndSave.test.ts의 ConfigurationError
		// 케이스와 겹치지 않게 여기서는 형식 검증만 확인한다).
		const keyword = fields.find((f) => f.name === 'keyword');
		assert.equal(keyword?.validate('anything at all'), true);
	});

	it('paperUrl이 arXiv 논문 URL을 만든다', () => {
		const url = findDescriptor('arxiv')?.paperUrl('2501.00001');
		assert.equal(url, 'https://arxiv.org/abs/2501.00001');
	});
});
