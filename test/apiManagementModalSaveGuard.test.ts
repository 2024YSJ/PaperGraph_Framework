// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// QA 9번 후속 — 개발자 도구로 조건 드롭다운에 없는 필드명을 끼워 넣고 "필드에 추가"를
// 누르면(그 시점엔 검사 기준이 없어 통과한다), 예전엔 "저장" 시점에 File.sanitizeQuerys가
// 그 조건만 조용히 걸러내고 나머지 정상 조건은 그대로 저장했다 — 그런데 화면은 그 카드
// 전체를 "저장됨"으로 표시해서, 실제로는 디스크에 없는 조건이 저장된 것처럼 보였다
// (사용자가 직접 재현: Subscriptions.json엔 malicious 조건이 없는데 카드엔 "저장됨"
// 배지가 붙어 있었음).
//
// 요청에 따라 "일부만 저장하고 Notice"가 아니라 "하나라도 무효면 저장 자체를 통째로
// 거부"로 바꿨다 — 이 파일은 그 거부 동작을 고정한다.
//
// ApiManagementModal은 Obsidian Modal이라 render()/onOpen()은 Setting 체이닝 API가
// 필요해 테스트 스텁으로 못 돈다 — 여기서는 persistSubscriptions(순수 로직 + File 호출)만
// private 캐스팅으로 직접 호출한다(zzManualCollectGaps.test.ts의 appendSkippedEntries
// 화이트박스 테스트와 같은 패턴).

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { ApiManagementModal } from '../src/adapter/ApiManagementModal';
import { File } from '../src/common/File';
import { App } from './stubs/obsidian';
import { recordedNotices } from './stubs/obsidian';
import { VaultStub } from './helpers/vaultStub';
import type PaperGraph3D from '../src/main';

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

interface TestApiDraft {
	apiName: string;
	conditions: { searchType: string; query: string }[];
	newConditionType: string;
	newConditionQuery: string;
	saved: boolean;
}

type Internal = {
	apiDrafts: TestApiDraft[];
	subscriptionsUnreadable: boolean;
	persistSubscriptions(clickedDraft?: TestApiDraft): Promise<boolean>;
};

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
	recordedNotices().length = 0;
});

function newModal(): Internal {
	// 실제 obsidian.App 타입은 워크스페이스/vault 등 방대한 표면을 요구하지만, 여기서
	// 테스트하는 persistSubscriptions는 app을 전혀 안 쓴다(super(app)에만 실림) —
	// 스텁을 그대로 캐스팅해도 런타임 동작에는 영향이 없다.
	const modal = new ApiManagementModal(new App() as never, {} as PaperGraph3D);
	return modal as unknown as Internal;
}

interface StoredSubscriptions {
	apis: { apiName: string; querys: unknown[] }[];
}

function subscriptionsJson(): StoredSubscriptions | undefined {
	const raw = vault.files.get(`${PLUGIN_DIR}/Subscriptions.json`);
	return raw === undefined ? undefined : (JSON.parse(raw) as StoredSubscriptions);
}

describe('ApiManagementModal.persistSubscriptions — 무효 조건이 섞이면 저장을 통째로 거부', () => {
	it('개발자 도구로 끼워 넣은 것 같은 미등록 searchType이 있으면 저장이 취소된다', async () => {
		const modal = newModal();
		const draft: TestApiDraft = {
			apiName: 'arxiv',
			conditions: [
				{ searchType: 'keyword', query: '정상값' },
				{ searchType: 'malicious', query: '이상한값' },
			],
			newConditionType: 'keyword',
			newConditionQuery: '',
			saved: false,
		};
		modal.apiDrafts = [draft];

		const ok = await modal.persistSubscriptions(draft);

		assert.equal(ok, false, '무효 조건이 섞였는데 저장이 성공으로 반환됐다');
		assert.equal(draft.saved, false, '거부됐는데 draft.saved가 true로 바뀌었다');
		assert.equal(subscriptionsJson(), undefined, '거부됐는데 Subscriptions.json이 만들어졌다');
		assert.ok(
			recordedNotices().some((n) => n.includes('취소')),
			'저장이 취소됐다는 안내가 없다',
		);
	});

	it('정상 조건만 있으면 그대로 저장된다', async () => {
		const modal = newModal();
		const draft: TestApiDraft = {
			apiName: 'arxiv',
			conditions: [{ searchType: 'keyword', query: '정상값' }],
			newConditionType: 'keyword',
			newConditionQuery: '',
			saved: false,
		};
		modal.apiDrafts = [draft];

		const ok = await modal.persistSubscriptions(draft);

		assert.equal(ok, true);
		assert.equal(draft.saved, true);
		const stored = subscriptionsJson();
		assert.equal(stored?.apis.length, 1);
	});

	it('등록되지 않은 apiName 자체도 저장을 거부한다', async () => {
		const modal = newModal();
		const draft: TestApiDraft = {
			apiName: 'pubmed', // findDescriptor가 모르는 출처
			conditions: [{ searchType: 'keyword', query: '정상값' }],
			newConditionType: 'keyword',
			newConditionQuery: '',
			saved: false,
		};
		modal.apiDrafts = [draft];

		const ok = await modal.persistSubscriptions(draft);

		assert.equal(ok, false);
		assert.equal(subscriptionsJson(), undefined);
	});

	it('여러 카드 중 하나만 무효여도 전체 저장이 취소된다 — 부분 저장 없음', async () => {
		const modal = newModal();
		const good: TestApiDraft = {
			apiName: 'arxiv',
			conditions: [{ searchType: 'keyword', query: '정상값' }],
			newConditionType: 'keyword',
			newConditionQuery: '',
			saved: false,
		};
		const bad: TestApiDraft = {
			apiName: 'arxiv',
			conditions: [{ searchType: 'malicious', query: '이상한값' }],
			newConditionType: 'keyword',
			newConditionQuery: '',
			saved: false,
		};
		modal.apiDrafts = [good, bad];

		const ok = await modal.persistSubscriptions(bad);

		assert.equal(ok, false);
		assert.equal(good.saved, false, '무관해 보이는 다른 카드까지 저장 자체가 안 일어나야 한다');
		assert.equal(subscriptionsJson(), undefined);
	});
});
