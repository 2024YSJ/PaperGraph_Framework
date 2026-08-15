# 013-refresh 작업 정리 
`013-refresh` 브랜치에서 진행한 작업을 최종 코드 기준으로 정리한다: (1) 저장된 논문
전체를 강제로 다시 확인하는 "새로고침" 기능 추가, (2) 자동 수집 스케줄러를 5분 폴링
방식에서 정확한 시각 기반 타이머로 개편, (3) `ApiSupport`/`Notify`의 Obsidian 의존
제거, (4) 그 외 자잘한 정리, (5) 보정(repair)·재임베딩·새로고침·부분 재조회 네 몸통의
disposed 처리/실패 격리 방식을 점검해 일관되게 맞춘 것.

## 1. 새로고침 기능

### 배경

기존 보정(`repair`) 계열은 전부 "실패한 것만" 다시 시도하는 구조다 —
`citationsKnown=false`나 `embeddingSucceeded=false`로 플래그가 선 논문만 대상으로
삼는다. 그런데 arXiv 논문은 개정판(revision)이 올라오면 제목·초록이 바뀔 수 있고,
인용수도 시간이 지나면서 계속 변한다 — 이런 "성공했지만 오래된" 값은 보정 대상에
안 걸린다. 코퍼스 전체를 대상으로 강제로 다시 확인하는 별도 경로가 필요했다.

### 최종 구조

- **`CollectAndSave.refreshAll()`** — 새 job kind `'refresh'`로 큐에 등록. `repair`
  계열과 같은 자리(`repairEmbeddings`/`repairCitations` 옆)에 있다. `citationsKnown`
  필터 없이 코퍼스 전체(`File.readAllPapers()`)를 대상으로 한다.
- **`refreshAllBody()`** — `repairCitationsBody`와 같은 API별 순회 구조
  (`File.supportedApiNames()` + `File.createApi()`)를 쓰되 `citationsKnown` 필터가
  없다. API별로 `api.Refresh?.(targets)` 하나만 호출한다 — `interface API`에
  `Refresh?(papers: Paper[]): Promise<void>` 단일 메서드로 계약을 잡아, 무엇을
  갱신하는지(인용수·제목·초록·저자 등)는 전적으로 구현체가 정하고 `CollectAndSave`는
  알지 않는다. 미구현 API(`Refresh`가 없는 출처)는 자연히 건너뛴다.
  - `ArxivAPI.Refresh()`는 내부적으로 `EnrichCitations(papers, { force: true })` →
    private `refreshContent()`(id_list로 재조회해 제목/초록/저자를 덮어씀) 순으로
    실행한다 — 이 조합은 arXiv 구현체의 내부 결정이지 `API` 인터페이스의 계약이 아니다.
- **재임베딩 조건** — `Paper.embeddingSourceOf(paper)`(title+abstract를 합친 비교 키)를
  `Refresh` 호출 전후로 비교해 **실제로 내용이 달라진 논문만** 재임베딩한다. 인용수만
  바뀐 논문까지 매번 재임베딩하면 비용이 크기 때문. `embeddingSourceOf`는
  `Embedding.buildModelInput`이 실제 모델에 넣는 필드 집합과 항상 같아야 하지만
  (모델 입력이 늘면 재임베딩 판정도 같이 늘어야 하므로), 둘을 하나로 합치지는 않았다 —
  전자는 모델 학습 포맷, 후자는 "무엇이 달라지면 다시 계산해야 하는가"라는 도메인
  판단이라 바뀌는 이유가 다르다.
- **진행률** — `run()`의 구독별(API별) 진행 표시와 다르게, 코퍼스 전체 논문 수 기준
  flat `done/total`이다(`RefreshStats`). 인용수/콘텐츠 재확인은 구독마다 다른 진행을
  보여줄 이유가 없다는 판단.
- **`RefreshStats`** — `citationsRefreshed`(다시 확인한 논문 수), `reembedded`(내용이
  바뀌어 재임베딩된 논문 수)를 집계한다. `repair` 계열의 `*Fixed`(고쳐진 수)와 이름을
  의도적으로 구분했다 — 새로고침은 "고친 수"가 아니라 "다시 확인한 수"라서.
- **`CollectController.refreshAllAuto()`** — 실제 실행 + Notice 진행률 표시를 담당한다.
  `run()` 계열이 쓰는 `runWithProgress`(구독별 `ProgressFlow.subscriptions` 배열 전제)를
  쓰지 않는다 — 새로고침의 진행이 API/구독 단위가 아니라 코퍼스 전체 논문 수 기준 flat
  `done/total`이라 그 배열 구조와 안 맞는다. 대신 Notice 하나를 직접 갱신하는 가벼운
  전용 처리를 쓴다.
- 미들웨어(`all`/`forEach`)는 부르지 않는다 — 이유는 아래 2절.

이벤트 배선은 기존 패턴 그대로: `main.ts`에 `collect:refresh` task 등록 →
`ui:collect-refresh` 이벤트 매핑. 진입점은 설정 탭 「새로고침」 버튼과 리본 아이콘
(`refresh-cw`) 둘 다에서 같은 이벤트를 재사용한다.

## 2. 새로고침이 원래 클래스 다이어그램 구조와 다른 이유

`docs/Structure/PaperGraph3D_Class_Diagram.md`는 새로고침이라는 개념 자체가 없던
시점에 작성됐다. `CollectAndSave`에는 `run()` 하나만 정의돼 있고, 그 설명은 "backfill과
최근 논문 수집을 인자로 구별해서 수행"이다 — 새로고침을 위한 자리가 원래 없었다.

새로고침을 추가할 때 두 가지 배치를 검토했다.

1. **`run()`의 세 번째 모드로 편입** — 한때 이렇게 구현했었다. 다이어그램의 수집 흐름
   (`모든 데이터 수집 -> 미들웨어 all -> loop{임베딩 -> 미들웨어 forEach -> 저장}`)을
   새로고침도 그대로 타게 하면, "수집 단계만 갈아끼우면 나머지는 재사용된다"는 게
   매력적으로 보였다.
2. **`repair` 계열의 자매 메서드로 배치** — 최종 채택.

(1)을 되돌린 이유: 다이어그램의 미들웨어 흐름은 **수집**(새 논문을 찾는 작업) 전용이라는
정책이 이미 코드에 있었다. `repairEmbeddingsBody`/`repairCitationsBody`의 기존 주석:

> 미들웨어는 돌리지 않는다 — 다이어그램의 미들웨어 흐름은 수집(run) 경로에 대한 정의고,
> 보정은 저장된 값의 필드 몇 개를 고치는 작업이라 범위 밖으로 둔다.

새로고침의 목적은 인용수 재조회 + 내용 변경 시 재임베딩이다. **새 논문을 한 편도 만들지
않는다.** 즉 "`citationsKnown` 필터가 없는 repair"이지 수집이 아니다. 수집 흐름 규칙을
새로고침에 적용하면, 원래 수집 전용으로 만든 미들웨어가 새로고침을 누를 때마다 코퍼스
전체에 대해서도 함께 발동하게 되는 의도치 않은 결합이 생긴다.

**결론**: 새로고침이 다이어그램의 `run()` 흐름을 타지 않는 것은 원래 구조에서 벗어난
게 아니라, `run()` 흐름이 애초에 "수집"만을 위한 것이고 새로고침은 그 범위 밖에 있는
`repair` 계열 작업이라는 걸 뒤늦게 인식한 결과다. 다이어그램 자체는 새로고침/보정을
언급하지 않으므로 수정하지 않았다 — `CollectAndSave`가 `run()` 외에 `repair`,
`repairEmbeddings`, `repairCitations`, `refreshAll` 같은 보조 메서드를 갖는 것은
다이어그램의 `interface API`가 `... // 각종 필요한 함수들`로 열어둔 확장 여지와 같은
성격이다.

**미들웨어로 확장하고 싶다면**: 새로고침 결과에 후처리를 걸고 싶은 개발자는 미들웨어가
아니라 Task 계층을 쓴다 — `EventListener.checking()`이 같은 `eventName`에 걸린 task를
전부 순서대로 실행하는 팬아웃이므로(009), `collect:refresh` 뒤에 자기 Task를 추가로
등록하면 된다.

### 알아둘 트레이드오프

- 새로고침은 미들웨어로 확장할 수 없다 — 결함이 아니라 보정 계열 전체가 공유하는 설계
  결정이다.
- `Refresh`가 optional이라 미구현 출처의 논문은 인용수도 갱신되지 않는다. arXiv 외
  출처를 추가할 때 각 구현체가 `Refresh`를 반드시 넣어야 한다.
- API 갱신 대상은 `File.supportedApiNames()`/`File.createApi()`로 가져온다(보정 계열
  관례) — 구독이 삭제된 논문도 계속 새로고침 대상에 남는다(다이어그램의 `Subscriptions`
  경유가 아니다). 갱신에 구독 설정/자격증명이 필요 없는 새로고침의 성격상 정합적이라고
  판단했다.

## 3. 자동 수집 스케줄러 — 매일 지정 시각 실행 + 캐치업

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
`new Scheduler(this.eventListener, (id) => this.registerInterval(id), (message) => new
Notice(message))`로 이 콜백들에 `Plugin.registerInterval`과 실패 알림(Notice)을
연결한다. 이렇게 하면 `Scheduler`는 여전히 `obsidian`을 import하지 않으면서도(Obsidian을
몰라야 한다는 기존 원칙 유지), 매번 새로 거는 타이머가 `Plugin.registerInterval`에
등록돼 플러그인 언로드 시 Obsidian이 자동으로 정리해 준다 — `onunload()`가
`scheduler.stop()`을 부르지 않아도 타이머가 남지 않는다(다만 `stop()`도 즉시 취소용으로
별도 유지하며 `onunload()`에서 호출한다).

### `SettingTab` → `ScheduleModal`

주기(시간)/허용 시작 시각/허용 종료 시각 세 입력을 "실행 시각" 하나로 단순화했다.
설정 탭 인라인이 아니라 전용 모달(`ScheduleModal`, `ApiManagementModal`과 같은 패턴)로
분리하고, 리본 아이콘(`clock`)에서 바로 열 수 있게 했다. 자동 수집 토글 on은
`scheduler.enableNow()`, off는 `scheduler.stop()`을 호출한다. 켜져 있는 동안은 실행
시각을 잠가(꺼야 바꿀 수 있음) "지금 예약된 타이머가 어느 값 기준인지" 모호해지는 걸
막는다.

### 유지한 것

`EventListener`/`TaskManager`/`CollectController`로 이어지는 실행 경로(`Scheduler`는
`eventListener.checking('scheduler:collect-recent')`만 부르고 `CollectAndSave`를
직접 모른다)와 "Scheduler는 Obsidian을 몰라야 한다"는 계층 분리 원칙은 그대로다 —
바뀐 건 "언제 실행을 트리거할지"뿐이고, "무엇을 실행할지"는 손대지 않았다.

### 검증

`tsc --noEmit`, `eslint`(오류 0), `npm run build`, `npm test`(130개 테스트 전부 통과)
모두 확인.

## 5. 자잘한 정리

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

## 6. 보정 계열 네 몸통 — disposed 처리·실패 격리 통일

### 배경

새로고침을 만들고 나서 코퍼스를 손대는 몸통이 넷이 됐다: `repairEmbeddingsBody`(PCA가
`needsReembedding`으로 좁혀준 논문을 재임베딩 — [VisualizationView.ts](../../src/adapter/VisualizationView.ts)의
"확인 후 고치기" 흐름이 트리거하는 유일한 경로), `repairCitationsBody`(인용수 재보강),
`refreshAllBody`(새로고침), `retrySkippedEntriesNow`(7번, 부분 재조회). 넷 다 "저장된
논문을 다시 훑어 고친다"는 같은 모양인데, `disposed`(플러그인 언로드 신호)를 얼마나
잘게 확인하는지와 API 호출이 실패했을 때 나머지를 계속 진행하는지가 서로 달랐다 —
`repairEmbeddingsBody`만 논문 한 편 단위로 `disposed`를 확인했고, 나머지 셋은 API/그룹
단위에서만 확인했다. `refreshAllBody`는 한술 더 떠 `api.Refresh()` 호출에 try/catch가
아예 없어서, 출처 하나가 예외를 던지면 새로고침 전체가 그 자리에서 죽고 아직 순회하지
않은 나머지 출처는 이번 실행에서 시도조차 못 하는 문제가 있었다.

**중요: `repairEmbeddingsBody`는 이번 정리에서 손대지 않았다.** PCA가 임베딩 실패를
감지하면 `collectflow.repairEmbeddings(needsReembedding)`을 불러 그 논문들만 재시도하는
흐름([CollectAndSave.ts](../../src/collect/CollectAndSave.ts)의 `repairEmbeddings()` →
`repairEmbeddingsNow()` → `repairEmbeddingsBody()`)은 이미 논문 단위 `disposed` 체크를
갖고 있어 기준이 되는 쪽이었다 — 나머지 셋을 그 기준에 맞췄지, 거꾸로 손대지 않았다.

### 무엇을 맞췄나

- **`disposed` 체크를 논문 단위로 통일** — `repairCitationsBody`, `refreshAllBody`,
  `retrySkippedEntriesNow` 세 곳의 논문 순회 루프에 `repairEmbeddingsBody`와 같은
  "이 논문에서 멈추면 나머지는 그냥 아직 안 고쳐진 상태로 남는다"는 체크를 추가했다.
  `retrySkippedEntriesNow`는 `RetryMissingEntries`로 이미 네트워크에서 복구된 논문이
  멈출 때 허공으로 사라지지 않도록, 처리하지 못한 것을 `stillMissingRecords`에 명시적으로
  되돌려 `SkippedEntries.json` 기록에서 빠지지 않게 했다.
- **`refreshAllBody`에 출처 격리 추가** — `api.Refresh(targets)` 호출을 try/catch로
  감쌌다. `EnrichCitations`는 인터페이스 주석에 "실패해도 예외를 던지지 않는다"는 [3]
  정책이 명시돼 있어 원래도 안전했지만, `Refresh`에는 그런 계약이 없다 — 구현체가 실수로
  예외를 던질 수 있다는 전제로 `collect()`의 구독 격리와 같은 방어를 걸었다. 실패한
  출처는 `RefreshStats.failedApis`에 `{apiName, error}`로 남고, 그 출처의 논문은
  `citationsRefreshed`를 올리지 않는다("다시 확인했다"고 거짓으로 세지 않기 위해).
  나머지 출처는 계속 진행된다.
- **`retrySkippedEntriesNow`의 그룹 루프를 `continue`에서 `break`로** — disposed일 때
  나머지 셋(`collect()`, `repairCitationsBody`, `refreshAllBody`)은 전부 `break`로 즉시
  빠져나가는데 이 함수만 남은 그룹을 계속 순회하며 하나씩 처리하고 있었다. `groups.values()`를
  배열로 뽑아 인덱스를 추적하도록 바꿔, disposed면 현재 그룹부터 남은 전부를 한 번에
  `stillMissingRecords`에 넣고 즉시 `break`하게 했다 — 결과(레코드 보존)는 같지만
  "disposed면 멈춘다"는 관용구가 넷 다 같은 모양이 됐다.
- **`CollectController.refreshAllAuto()`** — 완료 Notice에 실패한 출처가 있으면
  `"— arxiv 실패"`처럼 덧붙이도록 했다. `collect()`의 `failedSubscriptions`를
  `buildPartialFailureSuffix`가 알리는 것과 같은 이유 — 조용히 감추면 사용자는 일부
  출처가 새로고침되지 않은 걸 모른다.

### 왜 지금 손봤나

새로고침을 추가하면서 넷 중 하나(`refreshAllBody`)만 새로 짠 코드라 나머지 셋과
다른 습관이 섞여 들어갔다. `ApiSupport`의 요청 단위 재시도(429/5xx/timeout, 최대 3회)는
처음부터 잘 구조화돼 있어 손댈 게 없었고, 문제는 그 위 계층 — "요청이 최종 실패했을 때
`CollectAndSave`가 그 실패를 얼마나 잘 격리하는가", "언로드 신호를 얼마나 촘촘히
보는가" — 에서만 나타났다. `repairEmbeddingsBody`가 이미 옳은 답을 갖고 있었으므로
새 코드가 아니라 기존 기준에 맞추는 방향으로 정리했다.

### 검증

`tsc --noEmit`, `eslint`(오류 0), `npm run build` 모두 통과.

## 7. 자동 수집 실행 시각에 분 단위 추가

### 배경

`targetHour`(0~23시)만 있던 원래 설계는 정시(0분) 기준으로만 목표를 잡을 수 있었다.
실제로 자주 쓰이는 경로는 `scheduleNext()`의 정시 타이머보다 `start()`의 캐치업
(`missedToday`)이다 — 옵시디언이 그 정확한 순간에 계속 켜져 있어야만 타이머가 울리기
때문에, 대부분은 "그 시각을 지나 사용자가 옵시디언을 열 때" 캐치업으로 실행된다.
`missedToday`가 시(hour)만 비교하면, 목표를 7시로 두고 7시 10분에만 열어도 캐치업이
즉시 도는데, 사용자가 평소 7시 30분에 여는 습관이라면 그 사이(7:00~7:29)를 표현할
방법이 없었다 — 8시로 올리면 이번엔 7시대에 여는 걸로는 절대 캐치업이 안 돌고 8시
정각까지 옵시디언을 계속 켜놔야 한다.

### 변경

- **`ScheduleSettings.targetMinute`(0~59) 추가** — `File.readScheduleSettings()`가
  저장된 값과 `DEFAULT_SCHEDULE_SETTINGS`를 머지하는 구조라(`File.ts`), 기존
  `Schedule.json`에 이 필드가 없어도 기본값 0으로 채워져 마이그레이션이 따로 필요
  없다.
- **`Scheduler.missedToday`** — `now.getHours() < targetHour` 비교를
  `시*60+분` 합산 비교로 바꿔 시:분 단위로 "지났는가"를 판단한다.
- **`Scheduler.msUntilNextTargetHour` → `msUntilNextTarget`** — 정시(0분) 대신
  `targetHour:targetMinute`까지 남은 ms를 계산하도록 이름과 구현을 함께 바꿨다.
- **`ScheduleModal`** — 숫자 입력(0~23) 하나였던 "실행 시각"을 `<input type="time">`
  하나로 바꿨다. 네이티브 time input의 값 포맷이 항상 `"HH:MM"`(24시간제)이라 별도
  파서 없이 시:분을 함께 받고, `updateScheduleSettings({ targetHour, targetMinute })`로
  한 번에 저장한다. 시/분을 굳이 별도 입력 두 개로 쪼개지 않았다 — "몇 시 몇 분에
  실행"은 사용자에게 하나의 개념이라 시각 표시도 하나로 묶는 게 자연스럽다.

### 검증

`tsc --noEmit`, `eslint`(오류 0), `npm run build` 모두 통과.

## 검증

`tsc --noEmit`, `npm run build`, `eslint`(오류 0, 경고는 이 브랜치와 무관한 기존 것)
모두 통과. 실기기에서 리본/설정탭 「새로고침」 진행률·완료 문구, 내용이 바뀐 논문만
재임베딩되는지, 자동 수집 켜기/끄기·목표 시:분 변경 후 재예약 여부(특히 캐치업이
분 단위 경계에서 정확히 판단되는지), 새로고침 중 한 출처만 실패시켜도 나머지 출처가
계속 진행되는지는 다음 확인 때 마저 한다.
