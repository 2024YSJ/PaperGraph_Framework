# 8월 13일 작업 기록 — 전체 코퍼스 새로고침 · 자동 수집 스케줄러 개편

`013-refresh` 브랜치에서 진행한 작업을 정리한다: (1) 저장된 논문 전체를 강제로
다시 확인하는 "새로고침" 기능 추가, (2) 자동 수집 스케줄러를 5분 폴링 방식에서 정확한
시각 기반 타이머로 개편, (3) 그 외 자잘한 정리, (4) 작업 도중 `dev`에 올라온
`EventListener`/`Task` 관련 커밋을 merge하고 우리 작업과의 정합성을 확인한 경위.

## 1. 새로고침 기능

### 배경

기존 보정(`repair`) 계열은 전부 "실패한 것만" 다시 시도하는 구조다 —
`citationsKnown=false`나 `embeddingSucceeded=false`로 플래그가 선 논문만 대상으로
삼는다. 그런데 arXiv 논문은 개정판(revision)이 올라오면 제목·초록이 바뀔 수 있고,
인용수도 시간이 지나면서 계속 변한다 — 이런 "성공했지만 오래된" 값은 보정 대상에
안 걸린다. 코퍼스 전체를 대상으로 강제로 다시 확인하는 별도 경로가 필요했다.

### 구현

- **`CollectAndSave.refreshAll()`** — 새 job kind `'refresh'`로 큐에 등록. `repair`
  계열과 달리 `citationsKnown` 필터 없이 코퍼스 전체(`File.readAllPapers()`)를
  대상으로 한다.
- **`refreshAllBody()`** — API별로 순회하며 `EnrichCitations(targets, { force: true })`로
  인용수를 무조건 다시 조회한다. `API.RefreshContent`를 구현한 출처(현재 `ArxivAPI`
  하나, id_list로 재조회)는 제목·초록도 최신값으로 동기화한다. `RefreshContent`는
  optional 메서드라 구현 안 한 출처는 자연히 건너뛴다 — 어떤 API가 콘텐츠 재조회를
  지원하는지 `CollectAndSave`가 알 필요가 없다(출처 중립).
- **재임베딩 조건** — `RefreshContent` 호출 전후로 title/abstract 스냅샷을 비교해
  **실제로 내용이 달라진 논문만** 재임베딩한다. 인용수만 바뀐 논문까지 매번
  재임베딩하면 비용이 크기 때문.
- **진행률** — `run()`의 구독별(API별) 진행 표시와 다르게, 코퍼스 전체 논문 수 기준
  flat `done/total`이다(`RefreshStats`). 인용수/콘텐츠 재확인은 구독마다 다른 진행을
  보여줄 이유가 없다는 판단.
- **`RefreshStats`** — `citationsRefreshed`(다시 확인한 논문 수), `reembedded`(내용이
  바뀌어 재임베딩된 논문 수)를 집계한다. `repair` 계열의 `*Fixed`(고쳐진 수)와 이름을
  의도적으로 구분했다 — 새로고침은 "고친 수"가 아니라 "다시 확인한 수"라서.

### 연결

`CollectController.refreshAllAuto()`가 실제 실행 + Notice 진행률 표시를 담당한다.
`run()` 계열처럼 미들웨어를 거치는 대신, Notice 하나를 직접 갱신하는 가벼운 전용
처리를 쓴다(`refreshAll()`의 구독별 `ProgressFlow` 배열 구조와 안 맞아서).

이벤트 배선은 기존 패턴 그대로: `main.ts`에 `collect:refresh` task 등록 →
`ui:collect-refresh` 이벤트 매핑. 진입점은 설정 탭 「새로고침」 버튼과 리본 아이콘
(`refresh-cw`) 둘 다에서 같은 이벤트를 재사용한다.

## 2. 자동 수집 스케줄러 — 매일 지정 시각 실행 + 캐치업

"사용자가 설정한 시각에 매일 자동으로 구독을 수집하고, 그 시각에 옵시디언이 꺼져
있었으면 알아서 따라잡는다"를 요구사항으로 잡고, 다음과 같이 최종 구현했다.

### `ScheduleSettings`

```ts
interface ScheduleSettings {
  enabled: boolean;
  targetHour: number;  // 0~23, 매일 이 시각에 실행
  lastRunAt: number;   // 마지막 실행 시각(ms) — "오늘 이미 돌았는가" 판단용
}
```

설정값은 "몇 시에 돌릴지" 하나로 단순하게 유지한다.

### `Scheduler` — 시각 계산형 1회성 타이머 + 재귀 재예약

폴링 대신, "다음 목표 시각까지 남은 시간"을 계산해 그 시점에 정확히 한 번 실행되는
`setTimeout`을 건다. 실행될 때마다 스스로를 다시 호출해 그 다음 날 것을 재예약한다
(`setInterval`처럼 고정 간격으로 반복하지 않고 매번 "다음 목표 시각"을 새로 계산하므로
실행 시각이 누적 오차로 밀리지 않는다).

- **`start()`** — 플러그인 로드 시 1회 호출. 오늘 목표 시각을 이미 지났는데 아직
  실행 안 됐으면(그 시각에 앱이 꺼져 있었다는 뜻) 즉시 캐치업 실행 후 다음 타이머를
  예약한다. "오늘 이미 실행했는가"는 로컬 날짜(연/월/일)가 같은지로 판단한다 — 시간
  델타(`now - lastRunAt >= 24h`)로 판단하면 실행 시각이 매일 조금씩 밀릴 수 있어서다.
- **`enableNow()`** — 설정 탭에서 자동 수집을 막 켜는 순간 호출. 조건을 보지 않고
  무조건 즉시 1회 실행 후 재예약한다("켜면 바로 확인하고 싶다"는 요청).
- **`stop()`** — 자동 수집을 끄거나 언로드될 때 타이머를 취소한다.
- **`scheduleNext()`** — 매번 `Schedule.json`을 다시 읽어 목표 시각까지 남은 ms를
  계산하고 `setTimeout`을 건다. 설정 탭에서 목표 시각을 바꾸면 다음 재예약부터
  반영된다.

캐치업 시 밀린 기간을 별도로 메우는 로직은 두지 않았다 — `recent` 수집의 커서
(`api.updateTime`) + 재스캔 창(`recentRescanWindowMs`, 4일) 구조가 이미 그 역할을
한다. `resolveWindow()`가 계산하는 구간은 `[커서 - 4일, 지금]`이라, 다운타임이
길어질수록 커서가 오래돼 구간이 자동으로 넓어진다. `MAX_PAGES` 상한에 걸려도 커서는
실제로 훑은 지점까지만 전진하므로, 큰 캐치업은 여러 번의 스케줄 실행에 걸쳐 자연스럽게
나뉜다.

### 타이머 소유권 — `Plugin.registerInterval`에 위임

`Scheduler`가 `window.setTimeout`으로 타이머를 걸되, 그 id는 생성자로 주입받은
`registerTimer: (id: number) => void` 콜백에 넘긴다. `main.ts`는
`new Scheduler(this.eventListener, (id) => this.registerInterval(id))`로 이 콜백에
`Plugin.registerInterval`을 연결한다. 이렇게 하면 `Scheduler`는 여전히 `obsidian`을
import하지 않으면서도(Obsidian을 몰라야 한다는 기존 원칙 유지), 매번 새로 거는
타이머가 `Plugin.registerInterval`에 등록돼 플러그인 언로드 시 Obsidian이 자동으로
정리해 준다 — `onunload()`가 `scheduler.stop()`을 부르지 않아도 타이머가 남지 않는다
(다만 `stop()`도 즉시 취소용으로 별도 유지하며 `onunload()`에서 호출한다).

### `SettingTab`

주기(시간)/허용 시작 시각/허용 종료 시각 세 입력을 "실행 시각" 드롭다운 하나로
단순화했다. 자동 수집 토글 on은 `scheduler.enableNow()`, off는 `scheduler.stop()`을
호출한다. 켜져 있는 동안은 실행 시각을 잠가(꺼야 바꿀 수 있음) "지금 예약된 타이머가
어느 값 기준인지" 모호해지는 걸 막는다.

### 유지한 것

`EventListener`/`TaskManager`/`CollectController`로 이어지는 실행 경로(`Scheduler`는
`eventListener.checking('scheduler:collect-recent')`만 부르고 `CollectAndSave`를
직접 모른다)와 "Scheduler는 Obsidian을 몰라야 한다"는 계층 분리 원칙은 그대로다 —
바뀐 건 "언제 실행을 트리거할지"뿐이고, "무엇을 실행할지"는 손대지 않았다.

## 3. 자잘한 정리

- **`ApiManagementModal.ts` — "API 추가" → "구독 추가" 용어 통일.** 지원 출처가 지금
  arXiv 하나뿐이라 "어느 API인지 고르는" 드롭다운은 매번 같은 값을 다시 고르게 할
  뿐이었다 — 제거하고 `File.supportedApiNames()[0]`을 자동으로 쓴다. 지원 목록 자체는
  여전히 File의 API 레지스트리가 진실이라, 출처가 늘어나면 그때 선택 UI를 다시 붙이면
  된다. 버튼 문구도 "추가" → "구독 추가"로 맞췄다.
- **`CollectController.ts` — 사용자 노출 문구에서 "Backfill" → "과거 논문 수집".**
  메뉴 항목·모달 제목·큐 라벨(`describeTargets`)에 쓰이던 영문 "Backfill"을 한글로
  통일했다. `CollectAndSave.run()`의 내부 mode 값(`'backfill'`)과 job kind는 안
  바꿨다 — 사용자 화면 문구만 대상으로 했다.
- **`File.ts`** — 위 "API 추가" → "구독 추가" 이름 변경에 맞춰 주석 한 곳(참조하던
  UI 문구)만 동기화.

## 4. dev 병합 — `EventListener` 팬아웃 복구 + `Task` 빌드 오류 수정 반영

작업 도중 `dev`에 팀원이 커밋 2개를 올렸다. `013-refresh`를 그 위에 merge(fast-forward,
충돌 없음)한 뒤 로컬 작업분을 재적용하면서 다음을 함께 반영했다.

- **`Task` 빌드 오류 수정** — `Task`가 class에서 interface로 바뀐 뒤에도 `main.ts`
  네 곳(`collect:recent`/`-one`/`repair`/`refresh`)이 `new Task()` + 필드 대입 패턴을
  그대로 써서 `tsc`가 `TS2693`으로 빌드를 막고 있었다. 객체 리터럴로 교체 — 우리
  로컬 `main.ts`는 처음부터 이 형태였으므로 실질적으로 충돌 없이 그대로 들어왔다.
- **`EventListener` 팬아웃 복구** — `009`/`dev`가 이 클래스를 두 번 독립적으로
  구현하면서(`009`는 `events.filter()` 기반 팬아웃, `dev`는 `events.find()` 기반
  단일 매칭) `dev` merge 때 팬아웃이 조용히 사라져 있었던 걸 발견해 `filter()` +
  `Promise<unknown[]>` 반환으로 되돌렸다. `bindTaskManager` 이름과 한글 에러 메시지는
  이미 전역에 쓰이고 있어 유지.
  - **바로 위 "3. 자잘한 정리"에서 언급한 `test/eventSystem.test.ts` 방향(단일 매칭
    검증)은 이 복구로 다시 뒤집혔다** — 최종적으로는 `dev`의 팬아웃 버전(같은
    `eventName`에 걸린 task를 전부 순서대로 실행, 결과 배열 반환)을 그대로 채택했다.
  - 이 변경이 우리 스케줄러/새로고침 기능에 영향을 주는지 점검한 결과: `checking()`을
    호출하는 6곳(`main.ts` 3곳, `Scheduler.runNow()`, `SettingTab`의 새로고침 버튼,
    `ApiManagementModal`) 전부 반환값을 쓰지 않고 `await`/`.catch`만 하고, `setEventListener()`
    로 등록된 5개 `eventName`도 전부 1:1이라 실제 동작 변화는 없다 — 팬아웃 능력이
    복구됐을 뿐 지금 당장 여러 task가 걸린 이벤트는 없다.

## 검증

`tsc --noEmit` 통과. 실기기에서 새로고침 버튼/리본 아이콘, 자동 수집 켜기/끄기·
목표 시각 변경 후 재예약 여부는 다음 확인 때 마저 한다.
