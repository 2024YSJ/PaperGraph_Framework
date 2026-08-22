// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { File } from '../src/common/File';
import {
	DEFAULT_SCHEDULE_SETTINGS,
	LOAD_REPAIR_COOLDOWN_MS,
	shouldRunLoadRepair,
} from '../src/common/ScheduleSettings';
import { VaultStub } from './helpers/vaultStub';

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
});

// 로드 시 자동 보정(main.ts onload)이 재시작 사이에도 쿨다운을 지키는지 판정하는 순수
// 함수. main.ts는 'obsidian'의 Plugin을 상속해 여기서 직접 import할 수 없으므로(대역이
// Plugin을 흉내내지 않음), 판정 로직만 ScheduleSettings.ts로 뽑아 독립적으로 검증한다.
describe('shouldRunLoadRepair — 로드 시 자동 보정의 재시작 간 쿨다운', () => {
	it('한 번도 실행한 적 없으면(0) 항상 실행한다', () => {
		assert.equal(shouldRunLoadRepair(0, Date.now()), true);
	});

	it('쿨다운이 아직 안 지났으면 건너뛴다', () => {
		const now = Date.now();
		assert.equal(shouldRunLoadRepair(now - 1000, now, LOAD_REPAIR_COOLDOWN_MS), false);
	});

	it('쿨다운이 지났으면 다시 실행한다', () => {
		const now = Date.now();
		assert.equal(
			shouldRunLoadRepair(now - (LOAD_REPAIR_COOLDOWN_MS + 1000), now, LOAD_REPAIR_COOLDOWN_MS),
			true,
		);
	});

	it('경계값(정확히 쿨다운만큼 지남)은 실행 허용이다', () => {
		const now = Date.now();
		assert.equal(shouldRunLoadRepair(now - LOAD_REPAIR_COOLDOWN_MS, now, LOAD_REPAIR_COOLDOWN_MS), true);
	});
});

// Schedule.json에 lastLoadRepairAt 필드를 추가해도 기존 필드(enabled/lastRunAt 등)나
// 구버전 파일(이 필드가 없는 경우) 왕복이 깨지지 않는지 확인한다 — File.readConfig의
// 기본값 병합(DEFAULT_SCHEDULE_SETTINGS와 스프레드)에 기대는 부분이라 실제로 파일을
// 왕복시켜 검증한다.
describe('Schedule.json — lastLoadRepairAt 필드 왕복', () => {
	it('처음 읽으면 기본값(0)이 채워진다', async () => {
		const settings = await File.readScheduleSettings();
		assert.equal(settings.lastLoadRepairAt, 0);
	});

	it('저장한 값이 그대로 읽힌다', async () => {
		const now = Date.now();
		await File.writeScheduleSettings({ ...DEFAULT_SCHEDULE_SETTINGS, lastLoadRepairAt: now });

		const settings = await File.readScheduleSettings();

		assert.equal(settings.lastLoadRepairAt, now);
	});

	it('lastLoadRepairAt이 없는 구버전 파일도 기본값(0)으로 안전하게 읽힌다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Schedule.json`,
			JSON.stringify({ enabled: true, targetHour: 5, targetMinute: 30, lastRunAt: 123 }),
		);

		const settings = await File.readScheduleSettings();

		assert.equal(settings.lastLoadRepairAt, 0, '구버전 파일에 없는 필드가 기본값으로 안 채워졌다');
		assert.equal(settings.lastRunAt, 123, '기존 필드가 마이그레이션 중 깨졌다');
		assert.equal(settings.enabled, true);
	});

	it('lastLoadRepairAt을 갱신해도 다른 필드(enabled/lastRunAt 등)는 보존된다', async () => {
		await File.writeScheduleSettings({
			...DEFAULT_SCHEDULE_SETTINGS,
			enabled: true,
			targetHour: 7,
			lastRunAt: 999,
		});

		const before = await File.readScheduleSettings();
		await File.writeScheduleSettings({ ...before, lastLoadRepairAt: Date.now() });
		const after = await File.readScheduleSettings();

		assert.equal(after.enabled, true);
		assert.equal(after.targetHour, 7);
		assert.equal(after.lastRunAt, 999);
		assert.notEqual(after.lastLoadRepairAt, 0);
	});
});
