// 자동(백그라운드) 수집 스케줄 설정. Schedule.json으로 저장된다(File.ts).
//
// windowStartHour===windowEndHour는 "시간대 제한 없음"으로 취급한다 — 시작/끝이 같은
// 구간은 폭이 0이라 의미 있는 창을 표현할 수 없으므로, 그 값 자체를 "제한 안 함" 신호로
// 재사용한다(별도 boolean 플래그를 추가로 안 둬도 된다).
export interface ScheduleSettings {
	enabled: boolean;
	// 최근 논문 수집을 몇 시간 간격으로 반복할지.
	intervalHours: number;
	// 자동 수집을 허용할 로컬 시각 구간 [start, end). 0~23. start > end면 자정을 넘는
	// 구간(예: 22시~6시)으로 본다 — Scheduler.withinWindow 참고.
	windowStartHour: number;
	windowEndHour: number;
	// 마지막으로 자동 수집을 시작한 시각(ms, epoch). 0이면 아직 한 번도 실행한 적 없음 —
	// 이 값과 intervalHours로 "다음 실행이 언제인가"를 계산한다.
	lastRunAt: number;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
	enabled: false,
	intervalHours: 24,
	windowStartHour: 0,
	windowEndHour: 0,
	lastRunAt: 0,
};
