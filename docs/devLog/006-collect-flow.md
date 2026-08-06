# 8월 6일 작업 기록 (우빈 — CollectAndSave.run 구현)

003(임베딩)·005(PCA)를 004에 병합한 뒤, 마지막까지 스텁으로 남아 있던
`CollectAndSave.run()`을 구현했다. 이 함수가 없어서 `main.ts`의 수집 커맨드 두 개가
"아직 구현되지 않음" Notice만 띄우고 있었고, 설정탭·시각화 뷰의 테스트 버튼들이
`ArxivAPI`를 직접 호출하며 `run()`을 우회하고 있었다.

003·004 devLog가 `run()` 구현자에게 남긴 계약을 하나씩 이행하는 것이 이번 작업의 목표다.

## 흐름

다이어그램 정의를 그대로 따랐다.

```
구독 로드 -> 수집(모드별) -> 중복 제거 -> 미들웨어(all)
  -> loop { 임베딩 -> 미들웨어(forEach) -> 저장 }
  -> 커서 갱신
```

세부 단계는 private 메서드로 쪼갰지만 **미들웨어 호출은 `run()` 본문에만 있다** —
다이어그램이 "데이터 수집 함수에서 미들웨어 호출 ← 하면 안됨"으로 명시한 부분이다.
수집 함수는 `Paper[]`를 반환하고 `run()`이 그 목록을 미들웨어에 인자로 넘긴다.

## 확정 판단

### 모델 미설치는 수집 시작 전에 끊는다 (문서에 없던 함정)

`Embedding.embed()` 코드를 읽다 발견한 것: **모델 미설치는 서킷브레이커를 트립시키지
않는다.** `location === undefined`면 `recordFailure()`를 거치지 않고 곧장 throw하기
때문이다("예상 가능한 상태 — 실패가 아니므로", `Embedding.ts` 주석). 그대로 진행하면:

- 브레이커가 안 걸려 **논문 2000편이면 2000번 throw**하고,
- `recordFailure()`를 안 타므로 **Notice가 한 번도 안 뜬다** — 왜 전부 실패했는지
  사용자가 알 방법이 없다.
- 재임베딩 경로가 아직 없어(003 문서), 그렇게 `embedding=[]`로 저장된 논문은 다음 수집
  창에 다시 걸리지 않는 한 **영구히 빈 벡터로 남는다**.

005 문서도 같은 시나리오를 다른 각도에서 경고한다 — 모델 미설치로 수집하면 전 논문이
PCA에서 제외돼 "유효 0편" 에러가 나는데 화면엔 숫자만 보인다고.

그래서 `run()`은 루프 진입 전이 아니라 **네트워크를 쓰기 전에** `isModelInstalled()`를
확인하고, 미설치면 무엇을 해야 하는지 담아 throw한다. 조용히 코퍼스를 망치느니 아무것도
하지 않는 쪽이 낫다는 판단이다.

### 임베딩 실패 시 (b) 선택 — 빈 값으로 저장

003이 남긴 (a) 저장 스킵 / (b) 빈 값+`embeddingSucceeded=false` 중 (b). `SettingTab`의
"테스트 (100개)" 버튼이 같은 이유로 (a)→(b)로 정정한 전례를 따랐다 — 스킵하면 "이 논문이
임베딩에 실패했다"는 사실이 어디에도 안 남아 나중에 재임베딩 대상을 찾을 수 없다.
가짜 벡터는 만들지 않는다(baseline 제거 원칙 유지).

### 커서가 없는 첫 실행은 24시간

커서(`Subscriptions.updateTime`)가 0/undefined인 상태에서 보정 창을 그냥 빼면 음수
epoch이 되어 1970년부터 훑게 된다. 그러면 상한(MAX_PAGES=20)에 걸려 **"조건에 맞는 가장
오래된 2000편"**을 가져오는 엉뚱한 동작이 된다. 첫 실행은 `FIRST_RUN_HOURS`(24시간)
구간으로 시작하고 커서를 거기서부터 전진시킨다.

### 커서를 옮기는 경로를 하나로 제한

`advancesCursor` 플래그로 구분했다. 커서를 옮기는 건 **`recent` + 범위를 직접 주지 않은
운영 경로** 뿐이다.

- `testOptions.hours`를 준 테스트 경로: 운영 커서를 오염시키면 안 되므로 갱신 안 함.
- `backfill`: 과거 구간을 메우는 작업이라 "어디까지 최신을 봤는가"와 무관 — 갱신 안 함.

갱신할 때는 004가 경고한 대로 `lastCoverage.truncated`면 `coveredThrough`를 쓴다.
API가 여러 개면 그중 가장 이른 지점(min)으로 보수적으로 맞춘다 — 하나라도 잘렸으면
그 지점부터 다시 훑어야 한다.

### backfill은 구간 없이 거부한다

"어느 구간을 메울지"가 backfill의 본질이라 기본값을 지어내지 않고 명확한 에러를 낸다.
⚠️ 그 결과 **`collect-backfill` 커맨드는 현재 항상 실패한다** — 아래 "열린 항목" 참고.

### API 호출도 순차

임베딩만이 아니라 API 순회도 `for...of` + `await`다. 병렬로 부르면 같은 호스트에 동시
요청이 나가 arXiv의 요청 간격 권고(페이지 간 3초)를 깨뜨린다.

### 중복 제거는 출처를 합치며 버린다

`sourceId` 기준 seen-set으로 걸러내되, 버리는 쪽의 `collectedApis`/`collectedQueries`를
남는 쪽으로 옮긴다(인덱스 쌍 불변식 유지 — `File.mergeCollectionSources`와 같은 규칙).
그냥 버리면 "이 논문이 어느 구독에도 걸렸다"는 정보가 사라진다.

## `main.ts` 커맨드 catch 교체

004가 지적한 대로 `catch { new Notice('아직 구현되지 않음...') }`을 실제 에러 표시로
바꿨다. `run()`이 사용자가 무엇을 해야 하는지 담아 throw하므로(모델 미설치, 구독 없음,
구간 누락) 그 메시지를 그대로 보여주는 게 가장 유용하다. 성공 시 Notice도 추가했다 —
그전엔 성공/실패 어느 쪽도 표시가 없었다.

## 검증

`test/collectAndSave.test.ts`에 통합 테스트 19건을 추가했다(전체 36 → 55건).
**대역은 네트워크(`requestUrl`)와 Vault 둘뿐이고 `File`·`ArxivAPI`·`CollectAndSave`는
전부 실제 코드가 돈다** — 커서가 정말 JSON으로 왕복하는지, `writePaper`가 기존 파일을
읽어 출처를 병합하는지는 `File`을 흉내 내면 검증되지 않기 때문이다.

`run()`이 `File.readSubscriptions()`로 구독을 직접 읽는 구조라 대역 API를 주입할 수 없어,
`Subscriptions.json`을 심어 실제 `ArxivAPI`가 복원되게 하고 응답만 대역으로 뒀다.

검증한 것: 사전 조건 4건(구독 없음/모델 미설치/backfill 구간 누락·NaN — 전부 **요청이
나가기 전에** 멈추는지 확인), 중복 제거 3건, 임베딩 계약 3건(순차 호출·브레이커 초기화·
실패해도 저장), 미들웨어 4건(all/forEach 호출 횟수와 인자, visual 제외, forEach가 임베딩
후·저장 전인지), 커서 6건(전진·첫 실행·4일 보정·테스트 경로 비오염·backfill 비오염·
truncated 시 coveredThrough 사용).

**임시 테스트 인프라 추가분** (004.md의 삭제 목록에 함께 포함될 것):
- `test/helpers/vaultStub.ts` — 메모리 Vault 대역
- `test/stubs/obsidian.ts`에 `TFile`/`TFolder`/`Notice` 추가

`npm run build`(tsc + esbuild), `npm test`(55/55), `npx eslint src test`(0 errors) 통과.
Obsidian 앱을 직접 열어 수동 클릭하는 검증은 하지 않았다.

## 2차 작업 (8월 7일): 보정 패스 · API 레지스트리 · 구독 UI 배선

1차 작업의 "열린 항목" 중 팀 논의로 방향이 확정된 것들을 구현했다.

### API 레지스트리 — 지원 API 목록을 코드 레벨로

`File.createApi`의 switch를 `API_FACTORIES` 레코드로 승격하고
`File.supportedApiNames()`를 노출했다. 구독 UI의 API 선택 드롭다운과 createApi가
같은 목록을 보므로 "UI는 받는데 복원은 못 하는 이름"이 생길 수 없다. 새 API 추가 =
레코드 한 줄 + import (UI 자동 반영).

### 보정 패스 — `CollectAndSave.repair()`

run()과 **별개 사이클**. 저장된 논문 전체를 훑어(`File.readAllPapers()` 신설 —
`vault.getFiles()` 기반이라 연도 열거 불필요) 실패 플래그가 선 것만 재시도한다:

- `embeddingSucceeded=false` → 재임베딩 (003 계약 그대로: 사전 모델 체크, 순차 호출,
  실패 시 값 유지)
- `citationsKnown=false` → S2 재보강. `ArxivAPI.enrichCitations`를
  **`EnrichCitations`로 공개**하고 `API` 인터페이스에 추가 — 내부의
  `if (citationsKnown) continue` 필터가 드디어 실사용된다(004가 예정했던 "저장된
  논문을 다시 읽어오는 호출자"가 바로 이것). 재임베딩과 재보강은 다른 실패·다른
  재시도지만 "읽기→필터→재시도→재저장" 뼈대 하나를 공유한다.
- **큐를 두지 않았다** — 디스크의 실패 플래그가 곧 재시도 목록이라, 별도 큐는
  큐↔디스크 동기화 문제만 새로 만든다. 값이 실제로 바뀐 논문만 재저장한다.
- 미들웨어는 돌리지 않는다(다이어그램의 미들웨어 흐름은 수집 경로 정의).
- `collect-repair` 커맨드 + `collect:repair` Task + 설정탭 "보정" 버튼으로 노출.

### 설정탭 개편

- **직접 호출 수집 버튼 3개(최근 논문/Backfill/커스텀 검색) 삭제** →
  `run('recent')` / `run('backfill', {from,to})` / `repair()` 경유 버튼으로 교체.
  Backfill은 날짜 입력 모달(종료일 당일 포함 +1일 로직 유지)로 범위를 받는다.
  실행 중 버튼을 잠근다 — 연타로 두 실행이 겹치면 embed() 순차 계약이 실행 단위에서
  깨진다. `CollectResultModal.ts` 삭제(유일 참조처가 사라짐).
- **`collect-backfill` 커맨드 제거** — 범위 입력이 필수인 작업이라 인자를 못 받는
  커맨드 팔레트에서는 항상 실패한다. 설정탭 Backfill 버튼이 유일한 경로.
- **구독 UI 배선**: API 이름 자유 텍스트 → `supportedApiNames()` 드롭다운. 설정탭을
  열면 `readSubscriptions()`로 복원하고, 추가/삭제 때마다 즉시 저장한다. 저장 시
  현재 저장본을 읽어 apis만 갈아끼운다 — **updateTime(수집 커서)을 UI 저장이
  덮어쓰면 다음 수집 구간이 틀어진다.** 조건 최대 3개(004 AND 규칙) 초과는 Notice로
  거부. 같은 API 중복 등록은 허용(같은 arXiv에 다른 조건 묶음 = 정당한 구독).
- **함정 버튼 2개 제거**: "저장 테스트 — Subscriptions"(`apis: []` 하드코딩 → 누르면
  등록된 구독 전멸)와 "저장 테스트 — Secret"(`new Secret()` → 누르면 등록된 API 키
  전멸). 둘 다 실데이터가 저장되는 지금은 데이터 파괴 버튼이었다.

### 검증 (2차)

`repair` 통합 테스트 5건 추가(전체 55 → 60건): 모델 미설치 시 시작 전 중단 /
실패 플래그 선 논문만 재시도 / 재실패 시 디스크 불변 / S2 요청에 대상만 실림 /
건강한 논문은 재시도·재저장 없음. 테스트 작성 중 실제 파이프라인이 sourceId를
**버전 없이**(`arxiv:2501.00003`) 저장한다는 것도 재확인했다 — S2 정렬 검증이
`stripVersion(echoed) !== id` 비교라, 버전 붙은 sourceId를 심으면 보강이 조용히
버려진다. `VaultStub.getFiles()`/`TFile.extension` 스텁 보강.
`npm run build` / `npm test`(60/60) / `eslint`(0 errors) 통과. Obsidian 수동 검증은
하지 않았다.

## 3차 작업 (8월 7일): 아키텍처 리뷰 반영

수석 아키텍처 리뷰에서 나온 지적 중 팀 결정으로 확정된 것만 반영했다. 리뷰가 제안했던
변경 중 실제로 틀렸던 판단(모델 미설치 시 재보강도 막아야 하는지, 재임베딩 자동 트리거
여부)은 팀 논의로 기각됐다 — 아래 "기각된 리뷰 제안" 참고.

### 중복 제거를 run()에서 들어냄 — 미들웨어 확장 지점으로 이동

`dedupe()`/`mergeCollectionSources()`(private static)를 `CollectAndSave`에서
삭제했다. 중복 제거는 담당자가 따로 있는 작업이라 run()이 직접 구현할 것이 아니었다.
`run()`은 수집된 `Paper[]`를 그대로 `'all'` 미들웨어에 넘기고, 그 미들웨어가 배열을
**in-place로** 줄이면(splice 등) 이후 임베딩·저장 단계가 줄어든 목록을 본다 —
`Middleware.run()`이 `void`를 반환하므로 새 배열을 돌려주는 방식은 애초에 불가능하고,
받은 참조를 직접 수정하는 것만 유일한 경로다. 이 계약을 테스트로 고정해뒀다
(`test/collectAndSave.test.ts`의 "중복 제거 확장 지점" describe 블록) — 중복 제거를
구현할 담당자가 참고할 수 있는 최소 예시이기도 하다.

### `main.ts` 커맨드 메시지를 "아직 구현되지 않음"으로 되돌림

1차 작업에서 004의 "run() 구현 후 catch를 실제 에러 표시로 바꿀 것" 지시를 그대로
따랐는데, **`EventListener.checking()`/`TaskManager.runTask()`가 여전히 스텁**이라는
전제를 확인하지 않았다. 그 결과 커맨드 팔레트에서 최근 논문 수집을 실행하면
`Not implemented: EventListener.checking(...)`이라는 내부 스텁 메시지가 사용자에게
그대로 노출되고 있었다. `EventListener`/`TaskManager` 담당자는 8/1 회의록 역할분담에
아예 없어 주인 없는 공용 인프라로 남아 있다 — 수집 담당이 만들 수는 있지만
(이벤트 배선 → run()/repair() 도달 경로가 지금 이것 때문에 막혀 있으므로) 이번
작업 범위로 넣지 않기로 하고, 우선 정직한 메시지로만 되돌렸다. `errorMessage()`
헬퍼는 참조가 사라져 같이 지웠다.

**다음에 EventListener/TaskManager를 구현할 때 정해야 할 것** (구조는 다이어그램에
있지만 아래는 안 정해져 있다):
1. `EventListener`가 `TaskManager`를 참조할 필드가 없다 — 다이어그램에도 연결선 없음.
   `main.ts.init()`에서 필드 주입이 결이 맞아 보인다.
2. `checking(eventName, ...args)` / `runTask(taskName, ...args)` / `Task.func(...args)`
   세 군데 다 `unknown[]`으로 열려 있는데 아무도 실제로 안 쓴다 — 지금 두 Task는
   클로저로 인자를 다 담아버려서 `args`가 필요 없다. 쓸지 말지 결정 필요.
3. 매칭 안 되는 eventName/taskName일 때 throw vs 무시.
4. 같은 eventName에 여러 task를 걸 수 있는가(`events`가 배열이라 구조상 가능) —
   001의 "미들웨어/태스크를 얹어 확장" 프레임워크화 방향과는 팬아웃(find가 아니라
   filter) 쪽이 더 맞아 보인다. 이 결정은 시각화 phase도 그대로 물려받으므로 팀 공유 필요.
5. 팬아웃이면 반환 타입도 `Promise<unknown>`에서 배열로 바뀌어야 한다.

## 4차 작업 (8월 7일): 새 설치 환경에서 설정탭이 죽던 버그 수정

"다른 팀원이 pull받아서 임시 UI로 바로 테스트할 수 있는 상태인가"를 점검하다가 발견한
회귀. 커맨드 팔레트 2개가 막혀 있어도 설정탭 버튼(최근 논문/Backfill/보정/구독 UI)은
전부 `plugin.collectflow`를 직접 호출하므로 `EventListener`와 무관하게 동작해야
정상인데, **`Subscriptions.json`이 한 번도 생성된 적 없는 완전히 새 환경**에서는
설정탭을 여는 순간부터 막혀 있었다.

### 원인

`File.readSubscriptions()`가 파일이 없을 때 돌려주는 폴백이 `apis`를 세팅하지 않았다:

```ts
() => {
    const subscriptions = new Subscriptions();
    subscriptions.secret = secret;
    return subscriptions;   // apis는 세팅 안 함
}
```

`Subscriptions.apis!: API[]`가 non-null assertion이라 컴파일은 통과하지만 런타임 값은
`undefined`다. 2차 작업에서 추가한 `SettingTab.loadSubscriptions()`가
`subscriptions.apis.map(...)`으로 이 값을 바로 순회하면서
`TypeError: Cannot read properties of undefined (reading 'map')`로 터졌다. try/catch로
감싸둬서 앱이 죽지는 않지만, **새로 pull받은 사람이 설정탭을 여는 첫 순간마다 에러
Notice가 뜨는** 최악의 타이밍이었다 — 정확히 이번 작업으로 새로 생긴 화면(구독 UI)이
가장 먼저 이 값에 의존했기 때문에 이전에는 드러나지 않던 경로다.

`run()` 쪽은 `const apis = this.sub.apis ?? []`로 이미 방어돼 있어 영향이 없었다 —
같은 값을 쓰는 두 호출자 중 하나만 방어돼 있던 상태.

### 수정

호출자마다 방어하는 대신 값을 만드는 자리(`File.ts`의 폴백)에서 고쳤다 — 앞으로
`readSubscriptions()`를 쓸 다른 호출자도 같은 함정을 밟지 않도록.

```ts
() => {
    const subscriptions = new Subscriptions();
    subscriptions.secret = secret;
    subscriptions.apis = [];
    return subscriptions;
}
```

### 검증

`File.readSubscriptions()`가 파일 없을 때 `apis`로 빈 배열(undefined 아님)을 돌려주는지
확인하는 회귀 테스트를 추가했다(60 → 61건).

### 같은 유형 전수 점검에서 추가로 나온 2건

위 버그가 "`!` 단언이라 타입은 채워진 것처럼 보이지만 런타임 값은 undefined"라는 유형이라,
push 전에 `src/` 전체의 `!` 필드와 설정탭 상태 흐름을 훑어 같은 유형을 더 찾았다.

1. **`updateTime`도 같은 폴백에서 비어 있었다.** 지금은 `resolveWindow()`의
   `typeof cursor === 'number'` 검사와 `JSON.stringify`가 undefined 키를 버리는 성질
   덕에 우연히 안전했지만, 방어가 두 군데로 흩어져 있어 하나만 바뀌어도 깨진다.
   파일이 있을 때의 `data.updateTime ?? 0`과 같은 값(0)으로 폴백도 맞춰, 두 경로가
   같은 모양을 내놓게 했다.
2. **설정탭 API 드롭다운의 표시값과 내부 상태가 어긋날 수 있었다.** `apiNameDraft`는
   `''`로 시작하는데 `loadSubscriptions()`가 끝나야 `'arxiv'`가 채워진다. 그 사이의
   첫 렌더에서는 드롭다운이 첫 옵션(`arxiv`)을 보여주지만 내부 값은 `''`이라,
   사용자가 그 상태에서 "추가"를 누르면 길이 검사에 걸려 **아무 일도 일어나지 않는다**.
   드롭다운을 만드는 시점에 비어 있으면 첫 옵션으로 채우도록 고쳤다(표시값과 상태 일치).

### 데이터 유실 경로 차단 (읽기 실패 후 저장)

점검 중 발견한 별개 문제. `loadSubscriptions()`가 실패해도 `subscriptionsLoaded`를
`true`로 세팅하고 `apiDrafts`는 빈 채로 남는다. 이 상태에서 사용자가 API를 하나 추가하면
`persistSubscriptions()`가 **화면의 빈 목록으로 디스크를 덮어써, 읽지 못했을 뿐 멀쩡히
있던 구독이 사라진다.**

현실적인 발생 경로가 있다: 팀원이 새 API를 추가한 브랜치에서 구독을 저장하면
`Subscriptions.json`에 이 버전이 모르는 `apiName`이 들어가고, 옛 코드로 열면
`File.createApi`가 `Unknown apiName`으로 throw → 읽기 실패 → 위 시나리오 성립.

`subscriptionsUnreadable` 플래그를 두어 **읽지 못한 상태에서는 저장을 거부**하도록 했다
(이유를 담은 Notice로 안내). 읽기가 성공하면 플래그가 해제된다. "읽지 못한 데이터를
덮어쓰지 않는다"는 규칙이라, 앞으로 구독 UI를 확정 디자인으로 갈아끼울 때도 유지해야 한다.

`File.readSubscriptions()`가 모르는 apiName에 대해 조용히 빈 목록을 주지 않고 실제로
throw하는지도 테스트로 고정했다 — 이 동작이 위 방어의 전제다.

### 최종 검증

`npm run build` / `npm test`(63/63) / `eslint src test`(0 errors) 통과.
Obsidian 수동 검증은 하지 않았다.

## 열린 항목 / 다음 담당자 참고

- **시각화 뷰의 "실제 arXiv 수집으로 실행"은 여전히 `run()`을 우회한다** — 시각화
  담당자 영역이라 손대지 않았다. `run()`은 결과를 반환하지 않고 저장까지 해버리므로,
  교체하려면 미들웨어(`type: 'all'`)로 결과를 가로채는 방식이 자연스럽다 — 미들웨어의
  첫 실사용처가 될 수 있다.
- **API 키 입력 UI("임시 UI — 아직 저장되지 않습니다")는 여전히 미연결** — 키 등록은
  FileTestModal의 Secret 폼으로 가능해 이번 범위에서 뺐다. 확정 설정 UI 작업 때 함께.
- **구독 UI의 확정 디자인**(라디오 등)은 시각화 클래스 이후 별도 작업 — 현재 배선은
  유지한 채 표현만 갈아끼우면 된다.
