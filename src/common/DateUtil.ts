// 날짜(YYYY-MM-DD) 검증을 한 곳에 모은 유틸.
//
// 별도 파일로 둔 이유: File은 API를 import하고 있어서, API 쪽에서 File의 헬퍼를 쓰면
// 순환 참조가 된다. 쓰기(File.publicationDir) / 읽기(File.readPapersUnder) / 수집
// (ArxivAPI 파싱, CollectAndSave 기간 검사) 세 경로가 같은 규칙을 써야 하므로
// 의존성이 없는 모듈로 뺐다.
//
// 배경(QA 12번/15번): 예전에는 `/^\d{4}-\d{2}-\d{2}$/` "모양"만 보고 slice로 잘라
// 폴더를 만들었다. 그래서 3월 50일(2026-03-50)처럼 달력에 없는 날짜나 미래 날짜로
// 폴더/파일을 만들어 두면 그대로 임베딩·시각화까지 됐다.

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

// 모양뿐 아니라 "달력에 실제로 존재하는 날짜"인지까지 확인한다. Date는 범위를 벗어난
// 값을 조용히 굴려버리므로(2026-02-31 -> 3월 3일), 만든 Date의 연/월/일이 입력과
// 그대로 일치하는지 왕복 확인하는 게 핵심이다.
export function isCalendarDate(value: string): boolean {
	const match = DATE_SHAPE.exec(value ?? '');
	if (!match) {
		return false;
	}
	const [, y, mo, d] = match;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

// 미래 날짜가 아닌지. 논문 제출일은 발행처(arXiv)의 타임존 기준이라 사용자 로컬 기준
// '오늘'보다 하루 앞설 수 있다 — 정상 데이터를 미래로 오인하지 않도록 +1일 여유를 둔다.
export function isNotFuture(value: string, now: number = Date.now()): boolean {
	if (!isCalendarDate(value)) {
		return false;
	}
	const [y, mo, d] = value.split('-');
	const target = Date.UTC(Number(y), Number(mo) - 1, Number(d));
	const current = new Date(now);
	const todayUtc = Date.UTC(
		current.getUTCFullYear(),
		current.getUTCMonth(),
		current.getUTCDate(),
	);
	return target <= todayUtc + 24 * 60 * 60 * 1000;
}

// 위 둘을 함께 만족해야 "논문 날짜로 쓸 수 있는 값"이다. 저장 경로와 스캔 양쪽에서 쓴다.
export function isUsablePaperDate(value: string, now: number = Date.now()): boolean {
	return isCalendarDate(value) && isNotFuture(value, now);
}
