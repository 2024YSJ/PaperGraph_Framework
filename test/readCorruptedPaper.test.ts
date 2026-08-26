// ⚠️ 임시 테스트 코드 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { File } from '../src/common/File';
import { VaultStub } from './helpers/vaultStub';

// 손상된 .json 한 개가 코퍼스 전체 읽기를 막지 않는지 확인한다.
//
// 실제로 겪은 문제라 회귀 테스트로 남긴다: 임베딩 값에 NaN이 섞인 파일이 하나 생기자
// (수집 중 강제 종료·동기화 충돌 등으로 실제로 발생할 수 있다) JSON.parse가 던진
// 예외가 readPapersUnder 밖으로 나가, 멀쩡한 나머지 12,000여 편까지 통째로 못 읽고
// 시각화가 아예 그려지지 않았다.

// 기존 테스트들과 같은 관례 — 실제 볼트의 설정 폴더 이름에 의존하지 않는다.
const PLUGIN_DIR = 'test-plugin-dir/papergraph3d';

const paper = (sourceId: string): string =>
	JSON.stringify({
		schemaVersion: 4,
		paper: {
			title: `제목 ${sourceId}`,
			sourceId,
			authors: [],
			abstract: '',
			references: [],
			publicationDate: '2024-01-01',
			citationCount: 0,
			citationsKnown: false,
			collectedApis: ['arxiv'],
			collectedQueries: [],
			embedding: [0.1, 0.2, 0.3],
			embeddingModel: 'test-model',
			embeddingSource: 'local',
			embeddingSucceeded: true,
			extra: {},
		},
	});

describe('손상된 논문 파일 처리', () => {
	let vault: VaultStub;

	beforeEach(() => {
		vault = new VaultStub();
		File.init(vault.asVault(), PLUGIN_DIR);
	});

	it('깨진 파일은 건너뛰고 나머지는 그대로 읽는다', async () => {
		vault.files.set('PaperGraph3D/2024/01/01/정상1 (a).json', paper('arxiv:a'));
		// NaN은 JSON 표준이 아니라 JSON.parse가 던진다 — 실제로 관측된 손상 형태다.
		vault.files.set(
			'PaperGraph3D/2024/01/01/손상 (b).json',
			'{"schemaVersion":4,"paper":{"embedding":[NaN,0.2]}}',
		);
		vault.files.set('PaperGraph3D/2024/01/01/정상2 (c).json', paper('arxiv:c'));

		const papers = await File.readAllPapers();

		assert.equal(papers.length, 2, '손상된 1편만 빠지고 나머지는 읽혀야 한다');
		assert.deepEqual(
			papers.map((p) => p.sourceId).sort(),
			['arxiv:a', 'arxiv:c'],
			'멀쩡한 논문이 사라지면 안 된다',
		);
	});

	it('중간이 잘린 파일도 전체를 막지 않는다', async () => {
		vault.files.set('PaperGraph3D/2024/01/01/정상 (a).json', paper('arxiv:a'));
		// 쓰는 도중 중단된 파일 — 닫는 괄호가 없다.
		vault.files.set('PaperGraph3D/2024/01/01/잘림 (b).json', '{"schemaVersion":4,"paper":{"tit');

		const papers = await File.readAllPapers();

		assert.equal(papers.length, 1);
		assert.equal(papers[0]?.sourceId, 'arxiv:a');
	});

	it('전부 손상돼도 예외 대신 빈 배열을 준다', async () => {
		vault.files.set('PaperGraph3D/2024/01/01/손상1 (a).json', '{{{');
		vault.files.set('PaperGraph3D/2024/01/01/손상2 (b).json', 'not json at all');

		const papers = await File.readAllPapers();

		// 호출자(PCA)가 "유효 논문 부족"으로 안내할 수 있어야 한다 — 여기서 던지면
		// 그 안내 대신 알 수 없는 오류 문구가 화면에 뜬다.
		assert.deepEqual(papers, []);
	});
});
