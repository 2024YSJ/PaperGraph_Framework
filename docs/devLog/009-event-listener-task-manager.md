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

## 후속 수정 — 팬아웃 회귀 복구 + 옵시디언 내장 이벤트 청취 가능성 확인 (2026-08-14)

`dev` 브랜치를 다시 살펴보다가, 이 문서가 확정한 설계(팬아웃)가 실제 코드에는 반영돼
있지 않은 걸 발견했다. `git log -p`로 보면 이 브랜치(`009-event-listener-task-manager`)
안에 커밋이 두 번 겹쳐 있었다:

1. `b886905`(2024YSJ) — 이 문서가 기록한 원래 구현. `setTaskManager()`,
   `events.filter()`로 팬아웃, 영문 에러 메시지, `checking()`이 `Promise<unknown[]>` 반환.
2. `e2b6267`(ddaaasb, "독스 수정사항 명세 개정안") — 같은 스텁을 독립적으로 다시 구현.
   `bindTaskManager()`, `events.find()`로 **단건만** 매칭(팬아웃 소실), 한국어 에러
   메시지, `checking()`이 `Promise<unknown>` 반환.

`dev` 머지에서 2번 버전이 최종 상태로 남으면서, 이 문서와 `test/eventSystem.test.ts`는
여전히 1번 버전의 API(`setTaskManager`, 영문 메시지, 배열 반환)를 전제로 한 채
어긋나 있었다 — `npm test`를 돌리면 `eventSystem.test.ts`가 5개 실패했다
(`setTaskManager is not a function`, 에러 메시지 정규식 불일치 등).

**수정**: `bindTaskManager` 이름과 한국어 에러 메시지는 이미 `main.ts`/`Scheduler.ts`
전반에 쓰이고 있어 그대로 두고, `EventListener.checking()`만 `find` → `filter` 기반으로
되돌렸다. 한 `eventName`에 매칭되는 모든 `(eventName, taskName)`을 찾아 순서대로
(`for...of` + `await`, 병렬 아님 — 이유는 위 "4~5" 절과 동일) 실행하고, 매칭이 없으면
여전히 throw한다. 반환 타입은 `Promise<unknown>` → `Promise<unknown[]>`로 되돌렸다 —
기존 호출부(`main.ts`/`Scheduler.ts`/`SettingTab.ts`/`ApiManagementModal.ts`)는 전부
반환값을 버리므로 영향 없음. `test/eventSystem.test.ts`도 현재 API(`bindTaskManager`,
한국어 메시지)에 맞춰 갱신했고, 팬아웃 테스트 자체는 그대로 유효함을 확인했다.

**겸사겸사 발견한 별개 문제**: `npm run build`가 `EventListener`와 무관하게 `main.ts`에서
실패하고 있었다. 바로 아래 "후속 수정 — `Task`를 class에서 interface로 전환"에서
확정한 객체 리터럴 패턴이, 같은 머지 과정에서 예전 패턴(`new Task()` + 필드 대입)으로
되돌아가 있었기 때문이다(`Task`가 interface라 `new Task()`는 `tsc`가 `TS2693`으로 막는다).
`collectRecentTask`/`collectRecentOneTask`/`collectRepairTask`/`collectRefreshTask`
네 군데를 전부 `const x: Task = { taskName, func }` 객체 리터럴로 다시 교체했다.

**옵시디언 내장 이벤트 청취 가능성**: `obsidian` npm 패키지는 타입 정의만 있고 런타임
구현이 없다(`package.json`의 `"main": ""`). 실제 `app.vault`/`app.workspace`는 Node에서
띄울 수 없지만, `obsidian.d.ts`가 선언한 `Events` 베이스 클래스 계약(`Vault`/`Workspace`/
`MetadataCache`가 전부 상속)은 알 수 있다:

```ts
export class Events {
  on(name: string, callback: (...data: unknown[]) => unknown, ctx?: any): EventRef;
  off(name: string, callback: (...data: unknown[]) => unknown): void;
  trigger(name: string, ...data: unknown[]): void;
}
```

이 계약을 재현한 최소 클래스로 임시 스크립트를 만들어 검증했다(프로젝트 루트에 만들었다가
실행 직후 삭제, 커밋 없음). `vault.on('create', cb)` 콜백 안에서
`eventListener.checking('vault:create', file)`을 부르는 방식(실제 `registerEvent(
vault.on(...))` 패턴 그대로)으로 `trigger`를 쐈을 때 등록된 task가 인자를 그대로 받아
실행되는 것, `workspace.on('file-open', cb)` 하나에 task 2개를 건 팬아웃도 정상 동작하는
것을 확인했다.

결론: `PaperGraph3DEvent`가 임의 문자열 `eventName`과 `unknown[]` pass-through로만 이뤄진
제네릭 구조라서, 옵시디언 내장 이벤트도 구조적으로는 표현 가능하다. 다만 현재 코드베이스
어디에도 `registerEvent`/`vault.on`/`workspace.on`/`metadataCache.on` 호출이 없어 실제로
연결된 내장 이벤트는 0개다 — 이벤트마다 아래 같은 한 줄짜리 어댑터를 추가해야 연결된다
(자동 브릿지 헬퍼는 없음):

```ts
this.registerEvent(
  this.app.vault.on('create', (file) => {
    void this.eventListener.checking('vault:create', file);
  })
);
```

옵시디언 내장 이벤트를 실제로 연결하는 작업(예: `vault:create`를 자동 재색인에 연결)은
이번 범위 밖 — 구조적으로 가능하다는 것만 확인했다.

검증: `npm run build`(에러 0, 기존 20건 해소) / `npm run lint`(에러 0, 경고는 기존 13건
그대로) / `npm test`(130/130) 통과.

## 커밋

- (작성 예정)
