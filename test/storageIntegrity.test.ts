// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// 3겹 방어(UI 차단 / 저장 시 형식 확인 / 사용 시 재확인) 감사에서 나온 구멍 5개를
// 고정한다 — 손상된 파일이 기능을 영구히 막지 않는지, 잘못된 값이 조용히 신뢰되지
// 않는지를 확인한다.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { File, type BackfillProgressRecord } from '../src/common/File';
import { Secret } from '../src/collect/Secret';
import { Paper } from '../src/collect/Paper';
import type { SkippedEntryRecord } from '../src/collect/API';
import { VaultStub } from './helpers/vaultStub';

const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

let vault: VaultStub;

beforeEach(() => {
	vault = new VaultStub();
	File.init(vault.asVault(), PLUGIN_DIR);
});

function samplePaper(overrides: Partial<Paper> = {}): Paper {
	const paper = new Paper();
	paper.title = 'T';
	paper.authors = ['Alice'];
	paper.abstract = 'A';
	paper.sourceId = 'arxiv:2501.00001';
	paper.references = [];
	paper.publicationDate = '2025-01-15';
	paper.citationCount = 0;
	paper.citationsKnown = false;
	paper.collectedApis = ['arxiv'];
	paper.collectedQueries = [{ searchType: 'keyword', query: 'q' }];
	paper.embedding = [0.1, 0.2];
	paper.embeddingModel = 'm';
	paper.embeddingSource = 's';
	paper.embeddingSucceeded = true;
	return Object.assign(paper, overrides);
}

describe('구멍 1 — 논문 .json 손상: readStoredPaper/writePaperAt', () => {
	it('readStoredPaper: 손상된 파일은 없는 것으로 취급한다 — 구독 청크 처리를 안 죽인다', async () => {
		const paper = samplePaper();
		const path = 'PaperGraph3D/2025/01/15/T (2501.00001).json';
		vault.files.set(path, '{ not valid json');

		const result = await File.readStoredPaper(paper);
		assert.equal(result, null);
	});

	it('writePaperAt: 손상된 기존 파일 위에 다시 저장해도 예외 없이 성공한다', async () => {
		const path = 'PaperGraph3D/2025/01/15/T (2501.00001).json';
		vault.files.set(path, '{ not valid json');

		await File.writePaper(samplePaper());

		const stored = (await File.readAllPapers())[0];
		assert.equal(stored?.sourceId, 'arxiv:2501.00001', '손상된 기존 파일 때문에 재저장이 실패했다');
	});
});

describe('구멍 2 — config 파일 손상 및 원자적 쓰기', () => {
	it('readConfig: 잘린 JSON은 기본값으로 폴백한다 — 기능을 영구히 막지 않는다', async () => {
		vault.files.set(`${PLUGIN_DIR}/BackfillProgress.json`, '[{"apiName":"arx');
		const records = await File.readBackfillProgress();
		assert.deepEqual(records, []);
	});

	it('readConfig: 파싱은 됐지만 의도된 도메인 에러(Unknown apiName)는 여전히 던진다', async () => {
		vault.files.set(
			`${PLUGIN_DIR}/Subscriptions.json`,
			JSON.stringify({ apis: [{ apiName: 'unknown-provider', querys: [{ searchType: 'keyword', query: 'x' }] }] }),
		);
		await assert.rejects(() => File.readSubscriptions(), /Unknown apiName/);
	});

	it('writeConfig: 임시 파일 → rename으로 쓴다 — 쓰기 도중 상태에서도 최종 파일은 온전하다', async () => {
		await File.writeScheduleSettings({
			enabled: true,
			targetHour: 5,
			targetMinute: 30,
			lastRunAt: 0,
			lastLoadRepairAt: 0,
		});
		assert.equal(vault.files.has(`${PLUGIN_DIR}/Schedule.json.tmp`), false, '임시 파일이 정리되지 않았다');
		const settings = await File.readScheduleSettings();
		assert.equal(settings.targetHour, 5);
	});
});

describe('구멍 3 — Secret.fromJSON 타입 검사', () => {
	it('문자열이 아닌 값(숫자·객체)은 걸러낸다', () => {
		const secret = Secret.fromJSON({
			arxiv: 'sk-real-key',
			bad1: 12345 as unknown as string,
			bad2: { nested: true } as unknown as string,
		});
		assert.equal(secret.getKey('arxiv'), 'sk-real-key');
		assert.equal(secret.getKey('bad1'), undefined);
		assert.equal(secret.getKey('bad2'), undefined);
	});
});

describe('구멍 5 — SkippedEntries/BackfillProgress 레코드 필드 검증', () => {
	it('SkippedEntries: 필드가 빠지거나 타입이 다른 레코드는 읽기에서 걸러진다', async () => {
		const good: SkippedEntryRecord = {
			rawId: 'r1',
			title: 't',
			reason: 'missing-fields',
			apiName: 'arxiv',
			collectedQuery: { searchType: 'keyword', query: 'q' },
			skippedAt: 1,
		};
		const bad = { rawId: 'r2', title: 't2' }; // reason/apiName/collectedQuery/skippedAt 없음
		vault.files.set(`${PLUGIN_DIR}/SkippedEntries.json`, JSON.stringify([good, bad]));

		const records = await File.readSkippedEntries();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.rawId, 'r1');
	});

	it('BackfillProgress: querys 항목이 깨진 레코드는 읽기에서 걸러진다', async () => {
		const good: BackfillProgressRecord = {
			apiName: 'arxiv',
			querys: [{ searchType: 'keyword', query: 'q' }],
			from: 0,
			to: 100,
			coveredThrough: 50,
			updatedAt: 1,
		};
		const bad = { apiName: 'arxiv', querys: [{ searchType: 123 }], from: 0, to: 100, coveredThrough: 50, updatedAt: 1 };
		vault.files.set(`${PLUGIN_DIR}/BackfillProgress.json`, JSON.stringify([good, bad]));

		const records = await File.readBackfillProgress();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.apiName, 'arxiv');
	});
});
