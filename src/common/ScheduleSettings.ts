// 자동(백그라운드) 수집 스케줄 설정. Schedule.json으로 저장된다(File.ts).
export interface ScheduleSettings {
	enabled: boolean;
	// 매일 자동 수집을 실행할 로컬 시각(0~23시). 폴링이 아니라 이 시각까지 남은 시간을
	// 계산해 정확히 한 번 타이머를 거는 방식이라(Scheduler 참고), 허용 시간대 대신 딱
	// 한 시각만 있으면 된다.
	targetHour: number;
	// targetHour의 분(0~59). 정시 타이머는 옵시디언이 그 순간까지 계속 켜져 있어야만
	// 울리고, 실제로는 그 시각을 지나 사용자가 옵시디언을 열 때의 캐치업(missedToday)이
	// 더 자주 쓰인다 — 캐치업 여부는 "지금이 목표 시:분을 지났는가"로 판정하므로, 분이
	// 없으면 사용자가 평소 여는 시각(예: 7시 30분)을 목표로 정밀하게 잡을 수 없다.
	targetMinute: number;
	// 마지막으로 자동 수집을 실행한 시각(ms, epoch). 0이면 아직 한 번도 실행한 적 없음 —
	// "오늘 이미 돌았는가"를 로컬 날짜 비교로 판단하는 데 쓴다(Scheduler.isSameLocalDay).
	lastRunAt: number;
	// 마지막으로 "플러그인 로드 시 자동 보정"(main.ts onload의 collectflow.repair() 호출)이
	// 실제로 실행된 시각(ms, epoch). 0이면 아직 없음. CollectAndSave 인스턴스는 로드마다
	// 새로 만들어져(new CollectAndSave()) 인메모리 상태가 재시작 사이에 살아남지 못하므로,
	// 재시작 간 쿨다운이 필요한 이 값만 디스크(Schedule.json)에 남긴다 — shouldRunLoadRepair
	// 참고.
	lastLoadRepairAt: number;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
	enabled: false,
	targetHour: 3,
	targetMinute: 0,
	lastRunAt: 0,
	lastLoadRepairAt: 0,
};

// 로드 시 자동 보정(citation 재조회 포함 전체 보정)의 재시작 간 쿨다운. Obsidian을 자주
// 껐다 켜면 매번 Semantic Scholar에 즉시 요청이 나가 이미 rate limit(429)에 걸린 상태를
// 계속 악화시킨다(2026-08 재현 확인) — 10분은 S2 공식 문서에 나오는 기준값이 아니라
// CollectAndSave.AUTO_CITATION_REPAIR_COOLDOWN_MS(수집 직후 인메모리 재시도용, 별개 경로)와
// 값만 맞춘 임의의 라운드 넘버다. S2 rate limit 문서 어디에도 "재시도 묶음 사이 휴지 시간"
// 기준은 없다 — 새 값을 지어내는 대신 기존과 같은 값으로 일관성만 맞췄다.
export const LOAD_REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

// 로드 시 자동 보정을 이번에 실행해도 되는지. lastRepairAt이 없으면(첫 실행) 항상 실행.
// 사용자가 명시적으로 누르는 수동 「보정」 버튼(CollectAndSave.repair() 직접 호출 경로)은
// 이 함수를 거치지 않는다 — 쿨다운은 onload 자동 호출에만 건다(main.ts 참고).
export function shouldRunLoadRepair(
	lastRepairAt: number,
	now: number,
	cooldownMs: number = LOAD_REPAIR_COOLDOWN_MS,
): boolean {
	if (lastRepairAt <= 0) {
		return true;
	}
	return now - lastRepairAt >= cooldownMs;
}
