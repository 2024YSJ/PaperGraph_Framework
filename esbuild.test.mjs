// ⚠️ 임시 테스트 번들 설정 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';

// 테스트를 node --test로 돌리기 위한 번들 단계.
//
// 왜 번들이 필요한가:
//   1. 'obsidian' 패키지는 타입 정의만 있고 런타임 구현이 없다(main: ""). alias로
//      test/stubs/obsidian.ts를 그 자리에 끼워 넣어야 Obsidian 밖에서 import가 된다.
//   2. src의 import가 확장자 없는 형태('./SearchQuery')라 Node ESM 해석기가 그대로는
//      못 읽는다. 번들러가 해결해 준다.
//
// jsdom과 node: 내장 모듈은 external로 두고 런타임에 그대로 require한다.

const OUT_DIR = '.test-build';

await rm(OUT_DIR, { recursive: true, force: true });

const testFiles = (await readdir('test'))
	.filter((name) => name.endsWith('.test.ts'))
	.map((name) => path.join('test', name));

if (testFiles.length === 0) {
	console.error('test/ 아래에 *.test.ts 파일이 없습니다.');
	process.exit(1);
}

await esbuild.build({
	entryPoints: testFiles,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	outdir: OUT_DIR,
	outExtension: { '.js': '.mjs' },
	sourcemap: 'inline',
	logLevel: 'info',
	external: ['jsdom', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	alias: {
		obsidian: path.resolve('test/stubs/obsidian.ts'),
	},
});
