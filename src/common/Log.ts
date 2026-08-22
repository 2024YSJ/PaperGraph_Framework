// 수집 파이프라인 전반의 콘솔 로거.
//
// 다른 모듈에 상태를 심지 않는다: 파일 하나에 전부 들어 있고, 호출부는 `Log.xxx(...)`
// 한 줄씩만 추가한다.
//
// vault에는 아무것도 쓰지 않는다 — 프레임워크가 사용자 볼트에 진단용 파일을 몰래
// 만들면 안 된다는 판단으로, 예전에 있던 collect-log.md 파일 기록(큐/flush/트리밍
// 로직)은 걷어냈다. 콘솔 출력만 남긴다.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// 콘솔 필터 입력창에 이걸 치면 이 플러그인 로그만 걸러진다.
const CONSOLE_PREFIX = '[PaperGraph]';

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
	// 스택을 직접 꺼내야 콘솔 로그만 보고도 원인을 알 수 있다.
	static error(scope: string, message: string, error?: unknown, data?: unknown): void {
		Log.write('error', scope, message, {
			...(typeof data === 'object' && data !== null ? data : data === undefined ? {} : { data }),
			error: Log.describeError(error),
		});
	}

	// ── 내부 ───────────────────────────────────────────────────────

	private static write(level: LogLevel, scope: string, message: string, data?: unknown): void {
		const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}${Log.format(data)}`;

		// Obsidian 플러그인 가이드라인(lint로 강제됨)이 허용하는 콘솔 메서드는 debug/warn/
		// error뿐이다 — log/info는 쓸 수 없다. 그래서 debug와 info가 같은 곳으로 나간다.
		// ⚠️ console.debug는 크롬 개발자 도구의 기본 필터에서 숨겨진다. 콘솔 좌상단 로그
		// 레벨을 "All levels"(Verbose 포함)로 바꿔야 보인다.
		const consoleMethod =
			level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
		if (data === undefined) {
			consoleMethod(`${CONSOLE_PREFIX} ${line}`);
		} else {
			consoleMethod(`${CONSOLE_PREFIX} ${line}`, data);
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
}
