# EventListener / TaskManager 구현

006 devLog가 "다음 담당자 참고"로 남긴 미구현 스텁(`EventListener.checking()` /
`TaskManager.runTask()`)을 구현한다. 이 둘이 스텁인 동안은 커맨드 팔레트의
"최근 논문 수집 실행"/"보정 실행" 커맨드가 항상 "아직 구현되지 않음" Notice만
띄웠다 — 설정 탭의 버튼만이 `collectflow`를 직접 호출하는 유일한 실동작 경로였다.

006이 열어둔 질문 5가지를 먼저 확정한 뒤 구현했다.

## 확정 사항

### 1. EventListener가 TaskManager를 참조하는 방법: `setTaskManager()` 등록 함수

다이어그램에 둘 사이 연결선이 없었다(006 관찰). `checking()`이 결국
`runTask()`를 불러야 하므로 참조가 필요한데, 생성자 주입 대신 다른 등록 함수들
(`setEventListener`/`setTask`)과 같은 패턴으로 `setTaskManager(taskManager)`를
추가했다 — "등록 계열 함수는 `init()`에서 안전하게 끝나야 한다"는 001의 스텁
컨벤션과 결이 맞는다. `main.ts.init()`에서 `EventListener`/`TaskManager`를 만든
직후 한 번 호출한다.

### 2. `unknown[]` 인자 전달: 그대로 끝까지 관통시킨다

지금 등록된 두 Task(`collect:recent`/`collect:repair`)는 클로저로 인자를 이미
캡처해서 실제로는 `args`가 필요 없다. 그래도 `checking(eventName, ...args)` →
`runTask(taskName, ...args)` → `task.func(...args)`로 인자를 그대로 흘려보내게
구현했다 — 시그니처가 이미 `unknown[]`을 약속하고 있고, 001의 "확장 가능한
프레임워크" 방향상 나중에 인자를 쓰는 Task가 추가될 확장 지점을 지금 끊을
이유가 없다.

### 3. 미매칭 처리: `eventName`/`taskName` 둘 다 throw

`File.createApi`의 미등록 `apiName` 처리(throw)와 같은 규칙을 따른다.
`EventListener.checking()`은 매칭되는 이벤트가 하나도 없으면
`No task registered for event: ${eventName}`을 던지고, `TaskManager.runTask()`는
매칭되는 Task가 없으면 `No task registered with name: ${taskName}`을 던진다.
"무시(no-op)"를 택하지 않은 이유: 커맨드 팔레트 콜백이 성공/실패 Notice를
정확히 나눠야 하는데, 무시하면 "아무 일도 안 일어났는데 성공 Notice가 뜨는"
잘못된 피드백이 된다.

### 4~5. 같은 이벤트에 여러 Task — 팬아웃 확정, 반환 타입은 배열

`events`가 배열이라 구조상 한 `eventName`에 여러 `taskName`을 등록할 수 있다.
006이 "001의 확장 방향과는 `find`가 아니라 `filter`(팬아웃)가 더 맞아 보인다"고
남긴 판단을 그대로 채택했다 — 개발자가 미들웨어처럼 이벤트에도 여러 반응을
얹을 수 있어야 프레임워크 취지에 맞는다. 따라서:

- `EventListener.checking()`은 매칭되는 모든 `(eventName, taskName)` 쌍을
  **순서대로**(`for...of` + `await`, 병렬 아님) 실행하고, 각 결과를 모은
  `Promise<unknown[]>`을 반환한다.
- 순차 실행을 택한 이유는 프로젝트 전반의 관례(arXiv 페이지네이션, `embed()`
  호출 등)와 같다 — Task가 `collectflow`처럼 공유 상태를 다루는 경우 병렬
  호출은 006이 "동시성 가정" 절에서 지적한 것과 같은 종류의 레이스를 만들 수
  있다.
- `TaskManager.runTask()`는 여전히 단건이다(`find`) — `taskName`은 등록
  시점에 유일한 식별자라는 전제(`Task` 자체는 팬아웃 대상이 아님)를 유지하고,
  팬아웃은 오직 `EventListener.events` 배열 쪽 책임으로 뒀다.

## 에러 격리하지 않음 — 미들웨어와 다른 이유

`CollectAndSave.runMiddlewares()`는 외부 개발자가 붙인 미들웨어 버그가 수집
전체를 죽이지 않도록 try/catch로 실패를 격리한다(006). `TaskManager.runTask()`/
`EventListener.checking()`은 반대로 **격리하지 않고 그대로 전파**한다 — 이
둘이 실행하는 Task(`collect:recent`/`collect:repair`)는 사용자가 명시적으로
누른 커맨드의 본체이고, 실패를 삼키면 "성공한 척 조용히 실패"하게 된다.
호출자(커맨드 콜백)가 성공/실패를 구분해 Notice로 보여줘야 하므로 에러가
그대로 올라와야 한다.

## `main.ts` 갱신 — "미구현" catch를 실제 에러 표시로 교체

006이 "열린 항목"에 남긴 경고(`main.ts`의 커맨드 catch가 `run()`/`repair()`
구현 후에는 진짜 실패까지 "아직 구현되지 않음"으로 가릴 것)가 이제 실제로
발생하는 상황이 됐다 — `checking()`이 스텁이 아니게 됐으니 그대로 두면 안
된다. 두 커맨드의 `catch { new Notice('아직 구현되지 않음...') }`를
`SettingTab.ts`가 이미 쓰던 패턴(`e instanceof Error ? e.message : String(e)`)
으로 바꾸고, 성공 시에도 완료 Notice를 추가했다. `init()`에서
`this.eventListener.setTaskManager(this.taskManager)` 한 줄을 추가해 배선을
완성했다.

## 검증

`test/eventSystem.test.ts` 추가(node:test, Obsidian 대역 불필요 — 둘 다
obsidian을 모르는 순수 TS이므로): 단건 실행/인자 전달, Promise 반환 언래핑,
미등록 eventName/taskName의 throw, 에러 비삼킴, 팬아웃 순서(첫 Task가 완전히
끝난 뒤 두 번째가 시작하는지)까지 확인. `npm run build` / `npm test`
(104 → **123/123**) / `npm run lint`(0 errors, 기존 경고 외 신규 경고 없음)
통과. Obsidian 실기기 검증은 하지 않았다.

## 열린 항목 (이번 범위 밖)

- 시각화 phase(`VisualizationFlow`)는 이번 결정(팬아웃/throw 규칙)을 그대로
  물려받을 수 있지만, 현재 이벤트/커맨드로 트리거되지 않고 리본 클릭 →
  `activateVisualizationView()` → 뷰 `onOpen()`이 직접 `run()`을 부르는
  별도 경로다. `EventListener`를 시각화에도 쓸지는 아직 미정.
- 006이 남긴 나머지 항목(S2 배치 조회의 구독 간 중복, 구독 UI 확정 디자인,
  `SettingTab`의 옛 문구, `repair()` 다이어그램 미반영)은 이번 작업 범위
  밖이라 그대로 유효하다.

## 후속 수정 — `Task`를 class에서 interface로 전환 (2026-08-09)

다이어그램은 `Class Task`로 표기돼 있었지만, `Middleware`(`src/common/Middleware.ts`)가
이미 `interface`로 정의돼 구체 구현체(`CitationColorMiddleware` 등)가 `implements`로
붙는 패턴을 쓰고 있다. `Task`도 "사용자가 등록하는 확장 지점"이라는 성격이 Middleware와
같으므로 같은 패턴으로 맞췄다 — class 상속(`extends`)이 아니라 interface 구현
(`class MyTask implements Task { ... }`)으로 확장하게 한다. taskName/func 외에
자기만의 필드·메서드를 가진 Task를 만들고 싶은 개발자가 있어도 구조가 막지 않는다.

- `src/common/Task.ts`: `export class Task` → `export interface Task`(필드는 동일).
- `src/main.ts`: `new Task()` + 필드 대입 두 군데를 객체 리터럴(`const x: Task = { taskName, func }`)로
  교체. `TaskManager.setTask()`/`runTask()`는 구조적 타이핑이라 그대로 동작.
- `test/eventSystem.test.ts`의 `makeTask` 헬퍼도 객체 리터럴로 교체.
- `docs/Structure/PaperGraph3D_Class_Diagram.md`: `Class Task` → `interface Task`로 갱신,
  변경 사유를 다이어그램에도 남김.
- 검증: `npm run build` / `npm test`(123/123) / `npm run lint`(0 errors) 재확인.

## 커밋

- (작성 예정)
