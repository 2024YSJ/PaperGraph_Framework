// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)
//
// QA 12번(3월 50일 같은 달력에 없는 폴더) / 15번(미래 날짜 폴더) / 18번(연도 폴더 바로
// 밑 저장)은 전부 "쓰기 경로만 규격을 지키고 읽기 경로는 아무 .json이나 논문으로 읽었다"는
// 한 가지 원인에서 나왔다. 여기서는 손으로 심어 넣은 파일이 스캔에 잡히지 않는지를 고정한다.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { File } from '../src/common/File';
import { Paper } from '../src/collect/Paper';
import { isCalendarDate, isNotFuture, isUsablePaperDate } from '../src/common/DateUtil';
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

// 손으로 만든 파일을 흉내 낸다 — File.writePaper를 안 거치고 임의 경로에 직접 쓴다.
function plant(path: string, paper: Paper): void {
	vault.files.set(
		path,
		JSON.stringify({ schemaVersion: 4, paper, createdAt: 0, updatedAt: 0 }),
	);
}

describe('DateUtil — 달력 유효성 (12번)', () => {
	it('달력에 없는 날짜는 거부한다', () => {
		assert.equal(isCalendarDate('2026-03-50'), false);
		assert.equal(isCalendarDate('2026-02-31'), false);
		assert.equal(isCalendarDate('2026-13-01'), false);
		assert.equal(isCalendarDate('2026-00-10'), false);
		assert.equal(isCalendarDate('2026-01-00'), false);
		assert.equal(isCalendarDate('0000-99-99'), false);
		assert.equal(isCalendarDate('2026-1-1'), false);
		assert.equal(isCalendarDate(''), false);
	});

	it('실재하는 날짜(윤년 포함)는 통과한다', () => {
		assert.equal(isCalendarDate('2024-02-29'), true);
		assert.equal(isCalendarDate('2025-02-28'), true);
		assert.equal(isCalendarDate('2026-12-31'), true);
	});

	it('미래 날짜는 거부하되 발행처 타임존 차이(+1일)는 허용한다 (15번)', () => {
		const now = Date.UTC(2026, 7, 21); // 2026-08-21
		assert.equal(isNotFuture('2026-08-21', now), true);
		assert.equal(isNotFuture('2026-08-22', now), true, '타임존 여유 하루는 정상 데이터');
		assert.equal(isNotFuture('2026-08-23', now), false);
		assert.equal(isNotFuture('2030-01-01', now), false);
		assert.equal(isUsablePaperDate('2030-01-01', now), false);
	});
});

describe('File.readAllPapers — 콘텐츠 트리 규격 검사 (12/15/18번)', () => {
	it('정상 경로의 논문은 그대로 읽힌다', async () => {
		await File.writePaper(samplePaper());
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 1);
		assert.equal(File.lastScanSkipped.count, 0);
	});

	it('달력에 없는 날짜 폴더(3월 50일)는 무시한다 — 12번', async () => {
		plant(
			'PaperGraph3D/2026/03/50/x (2501.00009).json',
			samplePaper({ sourceId: 'arxiv:2501.00009', publicationDate: '2026-03-50' }),
		);
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 0);
		assert.equal(File.lastScanSkipped.count, 1);
	});

	it('미래 날짜 폴더는 무시한다 — 15번', async () => {
		plant(
			'PaperGraph3D/2999/01/01/x (2501.00010).json',
			samplePaper({ sourceId: 'arxiv:2501.00010', publicationDate: '2999-01-01' }),
		);
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 0);
		assert.equal(File.lastScanSkipped.count, 1);
	});

	it('연/월/일 4단계를 벗어난 자리에 둔 파일은 무시한다 — 18번', async () => {
		plant('PaperGraph3D/2025/stray (2501.00011).json', samplePaper());
		plant('PaperGraph3D/2025/01/stray (2501.00012).json', samplePaper());
		plant('PaperGraph3D/root (2501.00013).json', samplePaper());
		plant('PaperGraph3D/2025/01/15/deeper/x (2501.00014).json', samplePaper());
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 0);
		assert.equal(File.lastScanSkipped.count, 4);
	});

	it('폴더 날짜와 파일 안의 publicationDate가 다르면 무시한다 — 옮겨 심기 차단', async () => {
		plant(
			'PaperGraph3D/2025/01/15/x (2501.00015).json',
			samplePaper({ sourceId: 'arxiv:2501.00015', publicationDate: '2020-06-01' }),
		);
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 0);
		assert.equal(File.lastScanSkipped.count, 1);
	});

	it('unknown/ 은 날짜 없는 논문의 정상 자리라 그대로 읽는다', async () => {
		await File.writePaper(samplePaper({ sourceId: 'arxiv:2501.00016', publicationDate: '' }));
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 1);
		assert.equal(File.lastScanSkipped.count, 0);
	});

	it('손상된 .json 하나가 나머지 논문 로드를 막지 않는다', async () => {
		await File.writePaper(samplePaper());
		vault.files.set('PaperGraph3D/2025/01/15/broken (2501.00017).json', '{ not json');
		const papers = await File.readAllPapers();
		assert.equal(papers.length, 1, '정상 논문까지 같이 날아갔다');
		assert.equal(File.lastScanSkipped.count, 1);
	});

	it('readPapersByYear도 같은 규격을 적용한다', async () => {
		await File.writePaper(samplePaper());
		plant('PaperGraph3D/2025/stray (2501.00018).json', samplePaper());
		const papers = await File.readPapersByYear(2025);
		assert.equal(papers.length, 1);
	});
});

describe('File.writePaper — 잘못된 날짜는 unknown으로 보낸다 (12/15번)', () => {
	it('달력에 없는 publicationDate로는 그 날짜 폴더를 만들지 않는다', async () => {
		await File.writePaper(
			samplePaper({ sourceId: 'arxiv:2501.00019', publicationDate: '2026-03-50' }),
		);
		const paths = [...vault.files.keys()].filter((p) => p.endsWith('.json'));
		assert.ok(
			paths.every((p) => p.startsWith('PaperGraph3D/unknown/')),
			`unknown이 아닌 경로에 저장됐다: ${paths.join(', ')}`,
		);
	});

	it('미래 날짜도 unknown으로 간다', async () => {
		await File.writePaper(
			samplePaper({ sourceId: 'arxiv:2501.00020', publicationDate: '2999-01-01' }),
		);
		const paths = [...vault.files.keys()].filter((p) => p.endsWith('.json'));
		assert.ok(paths.every((p) => p.startsWith('PaperGraph3D/unknown/')));
	});
});
