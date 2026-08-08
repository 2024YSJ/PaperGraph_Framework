import { Vault } from 'obsidian';

// ⚠️ 임시 진단 코드 — 삭제 예정. 프로덕션 기능이 아니라 테스트/디버깅용이다.
// (수집이 조용히 끊기는 원인을 잡으려고 넣었다. 원인이 잡히면 이 파일과 호출 줄들을
//  통째로 걷어낸다 — 아래 "지우는 법" 참고.)
//
// 수집 경로 진단용 로거.
//
// 다른 모듈에 상태를 심지 않는다: 파일 하나에 전부 들어 있고, 호출부는 `Log.xxx(...)`
// 한 줄씩만 추가한다. 지울 때 남는 구조가 없어야 하기 때문이다.
//
// 콘솔과 파일에 동시에 쓰는 이유: Obsidian 개발자 도구 콘솔은 기본 필터가 debug를 숨기고
// 플러그인 리로드 때 날아가서, 원격의 사용자에게 "콘솔 좀 보여달라"고 하기가 어렵다.
// 파일로도 남겨두면 그 파일 하나만 받으면 된다.
//
// ── 지우는 법 (진단이 끝나면) ────────────────────────────────────────
//   1. 이 파일(src/common/Log.ts) 삭제
//   2. `Log.` 호출 줄 전부 제거 (rg "Log\." src)
//   3. main.ts의 Log.init(...) 한 줄 제거
//   4. SettingTab의 「수집 로그」 Setting 블록 제거
//   5. 이미 만들어진 로그 파일은 사용자가 「로그 파일 삭제」 버튼으로 지우거나,
//      플러그인 폴더에서 collect-log.md를 직접 지우면 된다.
// 파일에 남기는 부분만 먼저 떼고 콘솔 로그는 남기고 싶다면 setFileEnabled(false)를
// 기본값으로 바꾸는 것으로 충분하다.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// 콘솔 필터 입력창에 이걸 치면 이 플러그인 로그만 걸러진다.
const CONSOLE_PREFIX = '[PaperGraph]';

// ⚠️ 임시(삭제 예정) — 파일 기록 관련. 로그 파일은 플러그인 폴더에 하나만 둔다.
// 설정탭이 경로를 그대로 보여주므로(사용자가 찾아서 보낼 수 있게) export한다.
export const LOG_FILE_NAME = 'collect-log.md';

// 파일이 무한정 커지지 않게 하는 상한. 넘으면 앞쪽(오래된 쪽)을 잘라낸다 — 진단에 필요한
// 건 대개 마지막 실행이라 뒤쪽을 남긴다. 진단용 임시물이므로 넉넉히 잡을 이유가 없다.
const MAX_LOG_BYTES = 512 * 1024;
const TRIM_TO_BYTES = 256 * 1024;

// 버퍼를 비우는 조건: 이만큼 쌓이면 즉시, 아니면 이 간격마다.
const FLUSH_AT_LINES = 100;
const FLUSH_INTERVAL_MS = 2_000;

// 무엇이 들어와도 사람이 읽을 수 있는 한 줄로. 객체를 그냥 String()에 넣으면
// "[object Object]"가 되어 아무 정보도 안 남으므로 JSON을 먼저 시도한다.
function describe(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === null || typeof value !== 'object') {
		// number/boolean/undefined/symbol/bigint — 전부 원시값이라 안전하다.
		return typeof value === 'symbol' ? value.toString() : `${String(value)}`;
	}
	try {
		return JSON.stringify(value) ?? Object.prototype.toString.call(value);
	} catch {
		// 순환 참조 등 — 최소한 어떤 종류였는지는 남긴다.
		return Object.prototype.toString.call(value);
	}
}

export class Log {
	private static vault: Vault | undefined;
	private static pluginDir = '';
	// 파일 기록 여부. 콘솔 출력은 이 값과 무관하게 항상 나간다 — 끄고 싶은 건 vault를
	// 더럽히는 파일 쪽이지 콘솔이 아니다.
	private static fileEnabled = true;

	// 파일 쓰기를 직렬화하는 체인. read-modify-write라 동시에 두 개가 돌면 서로를 덮어쓴다.
	// 수집은 순차 실행이지만 EnrichCitations 등 비동기 경로가 섞이므로 여기서 보장한다.
	private static queue: Promise<void> = Promise.resolve();
	// 아직 파일에 안 쓴 줄들 (scheduleFlush/flush 참고).
	private static buffer: string[] = [];
	private static flushTimer: ReturnType<typeof setTimeout> | undefined;

	// File.init과 같은 시점(main.ts init)에 불린다. 부르지 않으면 콘솔로만 나간다 —
	// 로깅이 초기화 순서 때문에 터지는 일은 없어야 한다.
	static init(vault: Vault, pluginDir: string): void {
		Log.vault = vault;
		Log.pluginDir = pluginDir;
	}

	// ⚠️ 아래 세 개는 파일 기록 전용 — 진단이 끝나면 이 묶음과 append/clear를 함께 지운다.
	// 콘솔 로깅만 남기려면 이것들만 걷어내면 된다.
	static setFileEnabled(enabled: boolean): void {
		Log.fileEnabled = enabled;
	}

	static isFileEnabled(): boolean {
		return Log.fileEnabled;
	}

	static filePath(): string {
		return `${Log.pluginDir}/${LOG_FILE_NAME}`;
	}

	static debug(scope: string, message: string, data?: unknown): void {
		Log.write('debug', scope, message, data);
	}

	static info(scope: string, message: string, data?: unknown): void {
		Log.write('info', scope, message, data);
	}

	static warn(scope: string, message: string, data?: unknown): void {
		Log.write('warn', scope, message, data);
	}

	// 에러 객체는 그냥 JSON.stringify하면 "{}"가 되어 아무 정보도 안 남는다. 메시지와
	// 스택을 직접 꺼내야 파일 로그만 보고도 원인을 알 수 있다.
	static error(scope: string, message: string, error?: unknown, data?: unknown): void {
		Log.write('error', scope, message, {
			...(typeof data === 'object' && data !== null ? data : data === undefined ? {} : { data }),
			error: Log.describeError(error),
		});
	}

	// ⚠️ 임시(삭제 예정) — 파일 기록 전용. 플러그인이 언로드될 때 부른다(main.ts onunload).
	// 대기 중인 flush 타이머를 치우고 남은 버퍼를 최선을 다해(best-effort) 내보낸다 —
	// 완료를 기다리지 않는다. unload는 짧게 끝나야 하고, 이 시점에 vault I/O가 얼마나
	// 걸릴지 보장할 수 없기 때문이다. 마지막 몇 줄이 유실될 수 있지만, 그건 임시 진단
	// 로거가 감수할 수 있는 손실이다.
	static dispose(): void {
		if (Log.flushTimer !== undefined) {
			clearTimeout(Log.flushTimer);
			Log.flushTimer = undefined;
		}
		void Log.flush();
	}

	// ⚠️ 임시(삭제 예정) — 파일 기록 전용. 로그 파일을 지운다. 없으면 아무 일도 안 한다.
	static async clear(): Promise<void> {
		const vault = Log.vault;
		if (!vault) {
			return;
		}
		// 아직 안 쓴 줄까지 버린다 — 안 그러면 지운 직후 다음 flush가 파일을 되살린다.
		Log.buffer.length = 0;
		if (Log.flushTimer !== undefined) {
			clearTimeout(Log.flushTimer);
			Log.flushTimer = undefined;
		}
		// 큐에 실려 있던 쓰기가 삭제 뒤에 도착해 파일을 되살리지 않도록 순서를 맞춘다.
		Log.queue = Log.queue.then(async () => {
			try {
				const path = Log.filePath();
				if (await vault.adapter.exists(path)) {
					await vault.adapter.remove(path);
				}
			} catch {
				/* 로그 삭제 실패로 앱이 멈출 이유는 없다 */
			}
		});
		await Log.queue;
	}

	// ── 내부 ───────────────────────────────────────────────────────

	private static write(level: LogLevel, scope: string, message: string, data?: unknown): void {
		const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}${Log.format(data)}`;

		// Obsidian 플러그인 가이드라인(lint로 강제됨)이 허용하는 콘솔 메서드는 debug/warn/
		// error뿐이다 — log/info는 쓸 수 없다. 그래서 debug와 info가 같은 곳으로 나간다.
		// ⚠️ console.debug는 크롬 개발자 도구의 기본 필터에서 숨겨진다. 콘솔 좌상단 로그
		// 레벨을 "All levels"(Verbose 포함)로 바꿔야 보인다 — 설정탭 설명에도 적어 뒀다.
		const consoleMethod =
			level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
		if (data === undefined) {
			consoleMethod(`${CONSOLE_PREFIX} ${line}`);
		} else {
			consoleMethod(`${CONSOLE_PREFIX} ${line}`, data);
		}

		// debug는 파일에 남기지 않는다. 페이지마다 요청/응답 두 줄이 찍히는 arxiv.page가
		// 전부 debug라, 대용량 Backfill이면 이것만으로 로그 파일이 수십 MB가 된다. 상세
		// 추적이 필요하면 콘솔에서 보면 된다(콘솔에는 항상 나간다).
		if (Log.fileEnabled && level !== 'debug') {
			Log.buffer.push(line);
			Log.scheduleFlush();
		}
	}

	// data를 한 줄 JSON으로. 순환 참조나 BigInt처럼 stringify가 던지는 값이 섞여도
	// 로깅이 호출부를 죽이면 안 되므로 전부 삼킨다.
	private static format(data: unknown): string {
		if (data === undefined) {
			return '';
		}
		try {
			return ` | ${JSON.stringify(data)}`;
		} catch {
			return ` | ${describe(data)}`;
		}
	}

	private static describeError(error: unknown): unknown {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				stack: error.stack,
				// HttpRequestError처럼 상태코드를 필드로 들고 오는 에러의 정보를 잃지 않는다.
				...Object.fromEntries(
					Object.entries(error).filter(([, value]) => typeof value !== 'function'),
				),
			};
		}
		return error === undefined ? undefined : describe(error);
	}

	// ⚠️ 임시(삭제 예정) — 아래 두 개가 vault에 파일을 남기는 유일한 지점. 프로덕션
	// 기능이 아니라 원격 사용자에게서 로그를 받아보려고 넣은 테스트용 장치다.

	// 모아 뒀다 한 번에 쓴다. adapter에는 append가 없어 매번 파일 전체를 읽고 다시 써야
	// 하는데(read-modify-write), 줄마다 그러면 파일이 커질수록 한 줄 쓰는 비용이 파일
	// 크기에 비례해 늘어난다. 수집 한 번에 수천 줄이 나올 수 있으므로 반드시 묶어야 한다.
	private static scheduleFlush(): void {
		if (Log.buffer.length >= FLUSH_AT_LINES) {
			void Log.flush();
			return;
		}
		if (Log.flushTimer !== undefined) {
			return;
		}
		Log.flushTimer = setTimeout(() => {
			Log.flushTimer = undefined;
			void Log.flush();
		}, FLUSH_INTERVAL_MS);
	}

	private static flush(): Promise<void> {
		const vault = Log.vault;
		if (!vault || Log.buffer.length === 0) {
			return Promise.resolve();
		}
		// 버퍼를 먼저 비워, 쓰는 동안 들어온 줄이 다음 flush로 넘어가게 한다.
		const lines = Log.buffer.splice(0, Log.buffer.length);
		if (Log.flushTimer !== undefined) {
			clearTimeout(Log.flushTimer);
			Log.flushTimer = undefined;
		}

		Log.queue = Log.queue.then(async () => {
			try {
				const path = Log.filePath();
				const existing = (await vault.adapter.exists(path))
					? await vault.adapter.read(path)
					: '';
				let next = `${existing}${lines.join('\n')}\n`;
				if (next.length > MAX_LOG_BYTES) {
					// 잘린 지점이 줄 중간이면 첫 줄이 깨지므로 다음 줄바꿈까지 버린다.
					const cut = next.length - TRIM_TO_BYTES;
					const boundary = next.indexOf('\n', cut);
					next = `(앞부분 잘림)\n${next.slice(boundary >= 0 ? boundary + 1 : cut)}`;
				}
				await vault.adapter.write(path, next);
			} catch {
				/* 로그를 못 써서 수집이 죽는 일은 없어야 한다 */
			}
		});
		return Log.queue;
	}
}
