// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// File.lastReadDroppedInvalidConditions는 readSubscriptions()를 부를 때마다 새로
// 계산되는 공유 플래그다. CollectAndSave.runNow만 이 플래그를 검사해 수집을 막는데,
// 실사용에서는 "구독 선택" 창(SubscriptionTargetModal)이나 "API/구독 관리" 창
// (ApiManagementModal)이 그보다 먼저 readSubscriptions를 불러 자가 복구를 끝내고
// 플래그를 false로 리셋해버린다 — 그러면 뒤이은 runNow는 아무 일도 없었던 것처럼
// 넘어가 "0편 수집 완료"만 뜨고, 조건이 걸러졌다는 사실이 어디에도 안 남는다(실사용
// 재현). readSubscriptions를 부르는 각 UI 진입점이 자기 호출 직후 이 플래그를 스스로
// 확인해 알리도록 고쳤다.
//
// notifyDroppedConditions는 render()(Setting 체이닝이 필요해 테스트 스텁으로 못 돎)와
// 분리해 뺀 순수 함수라 여기서 직접 테스트한다. 두 창을 실제로 열어보는 통합 테스트는
// 이 하네스의 한계 밖이다(zzManualCollectGaps.test.ts 등 기존 파일들의 같은 주석 참고).

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { notifyDroppedConditions } from '../src/adapter/SubscriptionTargetModal';
import { File } from '../src/common/File';
import { recordedNotices } from './stubs/obsidian';
import { VaultStub } from './helpers/vaultStub';

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
	recordedNotices().length = 0;
});

describe('notifyDroppedConditions', () => {
	it('dropped가 true면 안내를 띄운다', () => {
		notifyDroppedConditions(true);
		assert.ok(recordedNotices().some((n) => n.includes('허용되지 않는 형식')));
	});

	it('dropped가 false면 아무 것도 안 띄운다', () => {
		notifyDroppedConditions(false);
		assert.equal(recordedNotices().length, 0);
	});
});

describe('구독 선택 창을 먼저 열면 그 창이 알리고, 뒤이은 runNow의 읽기는 이미 늦다', () => {
	it('첫 읽기(플래그=true)에서 알리고 나면, 두 번째 읽기 시점엔 이미 정리돼 플래그가 false다', async () => {
		// arxiv는 등록된 apiName이라 sanitizeQuerys가 이 조건을 실제로 걸러낸다 —
		// readSubscriptions가 자가 복구(파일을 정리된 상태로 되돌려 씀)를 하는 조건.
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({
				apis: [{ apiName: 'arxiv', querys: [{ searchType: 'malicious', query: 'x' }] }],
			}),
		);

		// 1차 읽기 — "구독 선택" 창이 열릴 때 하는 것과 같은 호출.
		await File.readSubscriptions();
		assert.equal(File.lastReadDroppedInvalidConditions, true, '1차 읽기는 걸러낸 게 있어야 한다');
		notifyDroppedConditions(File.lastReadDroppedInvalidConditions);
		assert.ok(
			recordedNotices().some((n) => n.includes('허용되지 않는 형식')),
			'1차 읽기 직후 알림이 안 떴다',
		);

		// 2차 읽기 — runNow가 나중에 부르는 것과 같은 호출. 파일이 이미 정리됐으니
		// 더 이상 걸러낼 게 없다 — runNow만 믿었다면 이 시점엔 아무 알림도 없이
		// 조용히 진행됐을 것이다(예전 버그: "0편 수집 완료"만 뜸).
		recordedNotices().length = 0;
		await File.readSubscriptions();
		assert.equal(
			File.lastReadDroppedInvalidConditions,
			false,
			'2차 읽기 시점엔 이미 정리돼 있어 플래그가 false여야 한다',
		);
	});

	it('정상 구독만 있으면 플래그가 처음부터 false다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({
				apis: [{ apiName: 'arxiv', querys: [{ searchType: 'keyword', query: '정상' }] }],
			}),
		);

		await File.readSubscriptions();
		assert.equal(File.lastReadDroppedInvalidConditions, false);
	});
});
