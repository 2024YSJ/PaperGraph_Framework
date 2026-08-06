// ⚠️ 임시 테스트 대역 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

// 'obsidian' 모듈의 테스트 대역. esbuild.test.mjs가 alias로 이 파일을 'obsidian' 자리에
// 끼워 넣는다 — 실제 obsidian 패키지는 타입 정의만 있고(main: "") 런타임 구현이 없어서
// Obsidian 밖에서는 import 자체가 불가능하기 때문이다.
//
// 대역으로 바꾸는 건 requestUrl(= 네트워크) 하나뿐이고, ApiSupport/API의 나머지 코드는
// 전부 실제 구현이 돈다. "가짜 응답을 넣고 진짜 파이프라인을 통과시킨다"가 이 테스트의 전제.

// Vault 파일 핸들. File.readVaultText/writeVaultText가 `instanceof TFile`로 "이미 있는
// 파일인가"를 판별하므로, 대역 Vault는 반드시 이 클래스의 인스턴스를 돌려줘야 한다.
// extension은 getFiles() 순회(File.readAllPapers의 .json 필터)가 읽는다.
export class TFile {
	extension: string;

	constructor(public path: string) {
		const dot = path.lastIndexOf('.');
		this.extension = dot === -1 ? '' : path.slice(dot + 1);
	}
}

// 폴더 핸들. getAbstractFileByPath가 폴더를 돌려줄 때 TFile이 아니어야 한다.
export class TFolder {
	constructor(public path: string) {}
}

// Notice는 UI 알림이라 테스트에서 할 일이 없지만, Embedding.ts가 import하므로 번들이
// 깨지지 않도록 대역이 필요하다. 띄운 메시지는 검사할 수 있게 모아둔다.
const NOTICES: string[] = [];

export class Notice {
	constructor(message: string) {
		NOTICES.push(message);
	}
}

export function recordedNotices(): string[] {
	return NOTICES;
}

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

export type RequestHandler = (
	param: RequestUrlParam,
) => RequestUrlResponse | Promise<RequestUrlResponse>;

// 상태를 globalThis에 두는 이유: 번들러가 이 파일을 'obsidian' alias와 상대경로 import
// 양쪽으로 끌어와 모듈 인스턴스가 둘로 갈릴 가능성을 없애기 위함. 대역이 하나여야
// 테스트가 요청을 관찰할 수 있다.
interface StubState {
	handler: RequestHandler;
	requests: RequestUrlParam[];
}

const KEY = '__pg3d_requestUrl_stub__';

function state(): StubState {
	const global = globalThis as unknown as Record<string, StubState | undefined>;
	let current = global[KEY];
	if (!current) {
		current = {
			handler: () => {
				throw new Error('requestUrl stub: 핸들러가 설정되지 않았습니다 (mockRequests 호출 필요)');
			},
			requests: [],
		};
		global[KEY] = current;
	}
	return current;
}

// 이번 테스트에서 네트워크가 어떻게 응답할지 지정하고, 기록된 요청 목록을 비운다.
export function mockRequests(handler: RequestHandler): void {
	const current = state();
	current.handler = handler;
	current.requests = [];
}

// 지금까지 실제로 나간 요청들(순서 보존). 페이지네이션이 정말 돌았는지, 헤더가 실렸는지
// 등을 검사하는 데 쓴다.
export function recordedRequests(): RequestUrlParam[] {
	return state().requests;
}

export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
	const current = state();
	current.requests.push(param);
	return current.handler(param);
}

// 응답 하나를 만드는 헬퍼. json은 text에서 지연 파싱한다(실제 requestUrl과 같은 성격).
export function response(
	status: number,
	text: string,
	headers: Record<string, string> = {},
): RequestUrlResponse {
	let parsed: unknown;
	let parsedDone = false;
	return {
		status,
		headers,
		text,
		get json(): unknown {
			if (!parsedDone) {
				parsed = text ? JSON.parse(text) : undefined;
				parsedDone = true;
			}
			return parsed;
		},
		arrayBuffer: new ArrayBuffer(0),
	};
}
