// ⚠️ 임시 테스트 헬퍼 — 프로덕션 테스트 프레임워크 정의 후 삭제할 것
// (docs/devLog/004.md "임시 테스트 인프라" 섹션 참고)

import { JSDOM } from 'jsdom';

// ── 환경 준비 ────────────────────────────────────────────────────────
// ApiSupport.parseXmlOrThrow가 브라우저 전역 DOMParser를 쓴다. Node에는 없으므로
// jsdom의 것을 전역에 심는다. jsdom을 고른 이유는 잘못된 XML에 <parsererror>를 넣는
// 브라우저 동작까지 재현하기 때문이다 — [1] 정책(XML 깨짐 → throw)을 검사하려면 필요하다.
export function installDomParser(): void {
	if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'undefined') {
		(globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM().window.DOMParser;
	}
}

// ── arXiv Atom 피드 만들기 ───────────────────────────────────────────

export interface EntryOptions {
	// 기본값은 정상 논문. 각 필드를 null로 주면 그 태그를 통째로 빼서 [2] 정책을 검사한다.
	id?: string | null;
	title?: string | null;
	summary?: string | null;
	published?: string | null;
	authors?: string[];
}

export function entry(options: EntryOptions = {}): string {
	const {
		id = 'http://arxiv.org/abs/2501.00001v1',
		title = 'A Test Paper',
		summary = 'An abstract.',
		published = '2025-01-15T10:30:00Z',
		authors = ['Alice Kim', 'Bob Lee'],
	} = options;

	const parts: string[] = ['  <entry>'];
	if (id !== null) {
		parts.push(`    <id>${id}</id>`);
	}
	if (title !== null) {
		parts.push(`    <title>${title}</title>`);
	}
	if (summary !== null) {
		parts.push(`    <summary>${summary}</summary>`);
	}
	if (published !== null) {
		parts.push(`    <published>${published}</published>`);
	}
	for (const name of authors) {
		parts.push(`    <author><name>${name}</name></author>`);
	}
	parts.push('  </entry>');
	return parts.join('\n');
}

// entries를 감싼 정상 Atom 피드. totalResults를 undefined로 주면
// <opensearch:totalResults> 태그 자체를 빼서 "못 읽는 경우"(-1 폴백)를 검사할 수 있다.
export function feed(entries: string[], totalResults?: number): string {
	const total =
		totalResults === undefined
			? ''
			: `  <opensearch:totalResults>${totalResults}</opensearch:totalResults>\n`;
	return (
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<feed xmlns="http://www.w3.org/2005/Atom" ' +
		'xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">\n' +
		total +
		entries.join('\n') +
		'\n</feed>'
	);
}

// arXiv가 잘못된 쿼리에 돌려주는 "200 OK인데 사실은 에러"인 피드. HTTP 에러가 아니고
// id/title/summary가 다 채워져 있어 필수 필드 검사를 통과해버리는 게 이 응답의 함정이다.
export function errorFeed(reason = 'query syntax error'): string {
	return feed(
		[
			entry({
				id: 'http://arxiv.org/api/errors#incorrect_id_format',
				title: 'Error',
				summary: reason,
				authors: [],
			}),
		],
		1,
	);
}

// id가 순번으로 다른 정상 entry n개. 페이지네이션 테스트용.
export function entries(count: number, startIndex = 0, publishedDay = 15): string[] {
	return Array.from({ length: count }, (_, i) => {
		const n = startIndex + i;
		return entry({
			id: `http://arxiv.org/abs/2501.${String(n).padStart(5, '0')}v1`,
			title: `Paper ${n}`,
			published: `2025-01-${String(publishedDay).padStart(2, '0')}T10:${String(n % 60).padStart(2, '0')}:00Z`,
		});
	});
}

// ── URL 파싱 헬퍼 ────────────────────────────────────────────────────
// 요청 URL에서 쿼리 파라미터를 꺼낸다. search_query/start/sortOrder가 의도대로
// 실렸는지 검사할 때 쓴다.
export function queryParams(url: string): URLSearchParams {
	return new URL(url).searchParams;
}

// ── 타이머 가속 ──────────────────────────────────────────────────────
// ArxivAPI는 페이지 사이 3초, 재시도 사이 3초를 실제로 기다린다(arXiv 권장 간격).
// 그대로 두면 페이지네이션 테스트 하나가 수십 초 걸리므로, 테스트 동안만 setTimeout의
// 지연을 0으로 만든다. 타이머를 가짜로 바꾸는 게 아니라 실제 setTimeout에 0ms를 넘기는
// 것이라 비동기 순서는 그대로 유지된다.
export async function withFastTimers<T>(run: () => Promise<T>): Promise<T> {
	const original = globalThis.setTimeout;
	const patched = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
		original(handler, 0, ...args)) as typeof globalThis.setTimeout;
	globalThis.setTimeout = patched;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = original;
	}
}
