import { Notice } from 'obsidian';

// "이유가 바뀔 때만 알린다"(once-per-reason 게이팅) — 예전 PaperGraph3D 프로젝트의
// Scheduler.notifyFailure(FR-012a)와 같은 취지다. 자동 실행(스케줄러, 신규 구독 등록
// 직후 자동 수집)은 실패해도 Notice를 안 띄우게 설계돼 있었는데(main.ts는 로그만
// 남긴다), 그러면 같은 원인으로 며칠씩 조용히 실패해도 사용자가 알 방법이 없다. 그렇다고
// 매 실행(스케줄러는 5분마다)마다 Notice를 띄우면 스팸이 된다 — 그 사이의 절충이 이
// 게이팅이다: "처음 이 이유로 실패하기 시작한 순간"과 "실패 이유가 바뀐 순간"에만 한 번
// 알리고, 같은 이유가 반복되는 동안은 조용하다.
//
// Embedding.ts의 서킷브레이커(연속 3회 실패의 첫 번째에만 알림)와는 게이팅 기준이 다르다
// — 그쪽은 "스트릭의 시작"이 기준이라 재시도 카운트 상태를 따로 들고 있고, 여기는 "이전과
// 다른 이유"가 기준이라 상태가 문자열 하나(lastReason)면 충분하다. 두 상태 모델을 억지로
// 하나로 합치면 어느 한쪽이 원래 의도와 다르게 동작할 위험이 있어 별도로 둔다.
export class FailureNotifier {
	private lastReason: string | undefined;

	// reason이 직전 실패와 같으면 조용히 넘어간다(false 반환). 다르면(최초 실패 포함)
	// Notice를 띄우고 true를 반환한다 — 호출자가 "이번엔 알렸다"는 사실을 로그에 함께
	// 남기고 싶을 수 있어 반환값을 둔다.
	notifyFailure(reason: string, buildMessage: (reason: string) => string): boolean {
		if (reason === this.lastReason) {
			return false;
		}
		this.lastReason = reason;
		new Notice(buildMessage(reason));
		return true;
	}

	// 성공을 기록한다 — 다음에 실패가 나면 이유가 같아도 다시 알린다. 한 번 회복됐다가
	// 또 실패하기 시작한 것은, 사용자 입장에서 "여전히 실패 중"이 아니라 "다시 실패했다"는
	// 새로운 사실이기 때문이다.
	notifySuccess(): void {
		this.lastReason = undefined;
	}
}
