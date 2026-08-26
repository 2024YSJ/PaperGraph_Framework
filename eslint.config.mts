import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'.test-build',
		'esbuild.config.mjs',
		'esbuild.test.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 테스트는 Obsidian 안이 아니라 Node에서 돈다. obsidianmd 규칙(window/activeWindow
		// 사용 등)은 플러그인 런타임을 전제하므로 여기선 적용 대상이 아니다.
		// no-floating-promises는 node:test의 describe()가 Promise를 반환하는 설계라
		// 매 블록마다 void를 붙이게 만들어 끈다.
		files: ['test/**/*.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
);
