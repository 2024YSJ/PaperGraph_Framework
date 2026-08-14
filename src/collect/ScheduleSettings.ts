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
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
	enabled: false,
	targetHour: 3,
	targetMinute: 0,
	lastRunAt: 0,
};
