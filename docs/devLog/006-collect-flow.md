# 수집 클래스 완성 (우빈 — CollectAndSave.run/repair 구현)

`CollectAndSave.run()`/`repair()`을 구현하고, 그 위에서 실기기 테스트로 드러난 데이터
유실·재작업·관측성 문제를 고쳤다. 003·004 devLog가 `run()` 구현자에게 남긴 계약을
이행하는 것이 출발점이었고, 이후 실사용 중 발견한 결함들을 이어서 정리했다. 이 문서는
그 과정에서 확정된 판단과 최종 코드 상태를 정리한다(중간에 만들었다 되돌린 것은 왜
되돌렸는지만 남기고 본문에서는 뺐다).

## 흐름

```
구독 로드 -> 사전 확인(구독 존재/모델 설치) -> 수집(모드별)
  -> 미들웨어(all) -> loop { 임베딩 또는 재사용 -> 미들웨어(forEach) -> 저장 }
  -> 커서 갱신
```

미들웨어 호출은 `run()` 본문에서만 한다 — 다이어그램이 "데이터 수집 함수에서 미들웨어
호출 ← 하면 안됨"으로 명시한 규칙. 수집 함수는 `Paper[]`를 반환하고 `run()`이 그
목록을 미들웨어에 넘긴다. 순회·에러 격리만 담당하는 `runMiddlewares()` 헬퍼로 모아
두었지만, 언제·무엇을 부를지 결정하는 흐름 제어는 여전히 `run()` 안에 있다.

`repair()`는 `run()`과 별개 사이클이다. 저장된 논문 전체를 훑어(`File.readAllPapers()`)
`embeddingSucceeded=false`는 재임베딩, `citationsKnown=false`는 S2 재보강을 시도한다.
미들웨어는 돌리지 않는다 — 다이어그램의 미들웨어 흐름은 수집(run) 경로에 대한 정의이고,
보정은 저장된 값 몇 개를 고치는 작업이라 범위 밖으로 뒀다.

## 확정 판단

### 모델 미설치는 수집 시작 전에 끊는다

`Embedding.embed()`는 모델 미설치를 서킷브레이커에 반영하지 않는다
(`recordFailure()`를 안 거치고 곧장 throw — "예상 가능한 상태"라는 이유). 그대로
진행하면 논문 수만큼 조용히 throw만 반복하고 Notice 하나 없이 전부
`embeddingSucceeded=false`로 저장된다. `run()`은 루프 진입 전, **네트워크를 쓰기
전에** `isModelInstalled()`를 확인하고 미설치면 안내 메시지와 함께 throw한다.

### 임베딩 실패 시 빈 값으로 저장 (스킵하지 않음)

003이 남긴 두 선택지(저장 스킵 / 빈 값+`embeddingSucceeded=false`) 중 후자를 택했다.
스킵하면 "이 논문이 임베딩에 실패했다"는 사실이 어디에도 안 남아 나중에 재임베딩
대상을 찾을 수 없다. 가짜 벡터는 만들지 않는다.

### 커서 정책

- **재스캔 창은 API가 선언한다**: `API.recentRescanWindowMs`(구현체별 readonly
  프로퍼티). `recent` 수집은 커서보다 이만큼 물러난 지점부터 다시 훑는다. arXiv는
  제출과 색인 사이에 지연이 있어, 커서 시점부터만 훑으면 "커서를 지난 뒤에 색인된
  논문"을 영영 못 본다. 이 창 자체는 커서에 반영하지 않는다. 원래는
  `CollectAndSave`에 상수로 고정돼 있었는데, "이 API가 얼마나 늦게 색인하는가"는
  그 API만 아는 사정이라 옮겼다 — `ArxivAPI.ARXIV_RETRY`(재시도 간격)를
  `ApiSupport`가 아니라 `ArxivAPI`에 둔 것과 같은 원칙("3초는 arXiv의 사정이지
  HTTP의 사정이 아니다"). 구독에 API가 여럿이면 그중 가장 보수적인(가장 긴) 값을
  쓴다 — 하나라도 놓치지 않아야 하므로. `ArxivAPI`는 4일로 선언한다(arXiv가 배치로
  공지해 금요일 마감분이 월요일에야 뜨는 주말 갭 ~3일 + 여유 — 이 저장소에서 실측한
  값은 아니고 이전 프로젝트의 관행을 이어받았다, 004 문서).
- **"최근"의 개념이 24시간에서 4일로 바뀌었다(코드만 반영)**: 커서가 없는 첫
  실행도 이제 같은 `recentRescanWindowMs`를 쓴다. 예전엔 첫 실행만 24시간짜리
  별도 상수(`FIRST_RUN_HOURS`)를 썼는데, 커서가 생긴 뒤로는 항상 4일 재스캔이 실제
  동작이었으므로 "최근"이라는 이름과 실제 동작(4일)이 처음부터 어긋나 있었다.
  개념을 4일로 통일해 일관되게 만들었다. **UI 문구·사용자 공지는 별도** — 회의를
  통해 알려야 한다는 판단으로 이번 범위에 포함하지 않았다.
- **커서 갱신 경로 제한**: `advancesCursor` 플래그로 recent 운영 경로만 커서를
  옮긴다. 범위를 직접 준 테스트 경로(`testOptions.hours`)와 `backfill`은 갱신하지
  않는다 — 전자는 운영 커서 오염 방지, 후자는 "과거 구간을 메우는 작업"이라 최신
  지점과 무관하기 때문.
- **truncated 처리**: `lastCoverage.truncated`면 `coveredThrough`를 커서로 쓴다.
  API가 여러 개면 가장 이른 지점(min)으로 보수적으로 맞춘다 — 요청 구간의 끝(`to`)을
  그대로 쓰면 못 본 구간을 봤다고 기록해 영구 누락된다.

### 재스캔이 이미 아는 인용수를 다시 S2에 묻지 않는다

재스캔 창에 다시 걸리는 논문 중 이미 `citationsKnown=true`로 저장된 것들은 S2에
다시 물어볼 필요가 없는데, 이전엔 `EnrichCitations`가 `collectWindow` 안에서
반환 직전에 자동으로 돌아 매번 다시 조회했다(freshly 파싱된 `Paper`는 항상
`citationsKnown=false`로 시작하므로 그 안의 `if (citationsKnown) continue` 필터가
무력했다).

- **`API.SearchRecentPaper`/`Backfill`에 `knownCitations?: ReadonlyMap<string, number>`
  선택 인자 추가** — 호출자(`CollectAndSave`)가 이미 아는 `sourceId -> citationCount`를
  넘기면, 구현체가 `EnrichCitations` 호출 **전에** 그 값으로 먼저 채워 넣는다.
  기존 필터가 그 논문들을 자연히 건너뛰므로 S2 재조회가 실제로 안 나간다. 인터페이스
  시그니처만 늘렸을 뿐 "API = Paper를 완성하는 방법"이라는 기존 설계(보강이 API
  내부에서 자동으로 도는 것)는 그대로 유지된다 — 별도 논의가 필요하다고 남겨뒀던
  "보강을 API 밖으로 빼는" 재구조화 없이 해결됐다.
- **`File.readKnownCitations()`** 추가 — `readAllPapers()`를 스캔해
  `citationsKnown=true`인 논문의 `sourceId -> citationCount` 맵을 만든다.
  `CollectAndSave.collect()`가 API 호출 전에 한 번 읽어 모든 API 호출에 넘긴다.
  전량 스캔이라 `repair()`와 같은 비용 특성을 공유한다(코퍼스가 커지면 부담 — 별도
  최적화는 실사용 규모가 나온 뒤로 미룸).

### Backfill은 구간 없이 거부한다

"어느 구간을 메울지"가 backfill의 본질이라 기본값을 지어내지 않고 명확한 에러를
낸다. 범위 입력이 필요한 작업이라 커맨드 팔레트(인자를 못 받음)에는 두지 않았고,
설정 탭의 Backfill 버튼(날짜 입력 모달)이 유일한 경로다.

### API 호출·임베딩 모두 순차

API 순회, `embed()` 호출 둘 다 `for...of` + `await`다. API를 병렬로 부르면 arXiv의
요청 간격 권고를 깨뜨리고, `embed()`는 세션/서킷브레이커 상태를 락 없이 공유해
병렬 호출 시 레이스가 난다(003 문서 "동시성 가정").

### 중복 제거는 미들웨어 확장 지점이지 run()의 책임이 아니다

처음엔 `run()` 내부에 `sourceId` seen-set으로 중복을 걸러냈으나, 이후 논의로
**미들웨어가 할 일**로 확정하고 `run()`에서 들어냈다. `run()`은 수집된 `Paper[]`를
그대로 `'all'` 미들웨어에 넘기고, 그 미들웨어가 배열을 **in-place로** 줄이면(splice
등) 이후 임베딩·저장 단계가 줄어든 목록을 본다 — `Middleware.run()`이 `void`를
반환해 새 배열을 돌려주는 방식은 애초에 불가능하기 때문이다. 이 계약은 테스트로
고정해뒀다(`test/collectAndSave.test.ts`의 "중복 제거 확장 지점" describe 블록).

### 저장본 재사용/보존 — 왜 미들웨어가 아니라 run() 내부인가

4일 재스캔 창 때문에 `recent` 수집은 최근 논문을 매번 다시 훑는데, 실기기 테스트에서
두 문제가 실제로 나타났다.

- **재작업**: "이미 임베딩됐나" 확인이 없어 재스캔 창에 걸리는 논문마다 실행할
  때마다 다시 임베딩했다(파이프라인에서 가장 비싼 단계).
- **데이터 유실**: 임베딩이 이번엔 실패하면 `embedOne()`이 `embedding=[]`으로 채우고,
  `File.writePaperAt`이 필드를 통째로 갈아끼워 **어제 성공한 벡터가 빈 값으로
  파괴됐다**(재현 확인).

이걸 중복 제거처럼 미들웨어로 넘길 수 있는지 검토했으나 구조적으로 안 된다는
결론이었다. `'all'`은 목록에서 항목을 **덜어내는** 것만 가능한데, 덜어내면
`File.writePaper`에 도달하지 못해 출처 병합·인용수 갱신이 사라진다. `'forEach'`는
임베딩이 **끝난 뒤** 호출돼 건너뛸 기회가 이미 지났다. 그래서 이 작업은 `run()`
내부(`embedOrReuse()`)와 `File` 계층에 둔다.

- **`File.readStoredPaper(paper)`**: 이 논문이 저장될 경로에 이미 있는 저장본을
  읽는다.
- **`CollectAndSave.embedOrReuse(paper)`**: `embedOne()` 호출 전에 저장본을 확인해,
  성공 상태면 그 벡터를 그대로 재사용하고 `embed()` 자체를 안 부른다. 논문은 그대로
  `'forEach'` → `writePaper`로 흘러가므로 출처 병합·인용수 갱신은 정상 동작한다
  (목록에서 빼는 방식과의 결정적 차이).
- **`File.writePaperAt`의 보존 규칙**(백스톱): 들어온 논문의 임베딩이 실패 상태인데
  기존 저장본이 성공 상태면 기존 값을 유지한다. `run()`의 재사용 경로가 대부분의
  경우를 먼저 막지만, `repair()`나 앞으로 생길 다른 호출자까지 보호하는 안전망이다.

### 재스캔 시 값이 같으면 다시 쓰지 않는다

위 재사용 규칙을 적용해도 `writePaperAt`은 여전히 무조건 디스크에 다시 쓰고
있었다. 재스캔 창에 걸리는 논문은 대부분 아무것도 안 바뀌는데도 매번 `.json`+`.md`를
다시 써서, 내용이 같은데 파일 감시자/동기화 플러그인이 매번 깨어나고 `updatedAt`이
매번 갱신돼 "이 논문이 실제로 마지막으로 바뀐 시점"이라는 정보가 사라졌다.

`File.papersEqual(a, b)`로 필드별 직접 비교(순서에 흔들리는 `JSON.stringify` 통짜
비교 대신 — 프로퍼티 삽입 순서가 다른 생성 경로에서 우연히 달라지면 내용이 같아도
다르다고 오판할 수 있다)해서, 출처 병합·임베딩 보존을 마친 뒤에도 기존과 완전히
같으면 **`.json`/`.md` 둘 다 안 쓰고 조기 반환**한다. 인용수 보강, 새 구독의 출처
추가처럼 값이 실제로 바뀌면 정상적으로 다시 쓴다.

### 미들웨어 실패 격리

`run()`의 미들웨어 호출을 `runMiddlewares(type, context)`로 모으고 try/catch로
감쌌다. 외부 개발자가 붙인 미들웨어의 버그 하나가 수집 전체(임베딩·저장·커서 갱신)를
죽이면 확장 지점으로서 너무 위험하다. `console.error`로만 기록하고 `Notice`는 띄우지
않는다 — `CollectAndSave`는 Obsidian을 몰라야 한다는 001 합의를 지키기 위해서다.

### 진행률 로딩 바 — UI/core 분리

`run()` 시그니처는 그대로 두고, 설정 탭에 등록한 진단용 미들웨어로 관측한다.
`Notice` 생성·표시·정리는 전부 `SettingTab.ts`(UI 계층) 안에 있고, `run()`은 그
존재조차 모른다 — `'all'`이 총 개수를, `'forEach'`가 논문마다 진행 카운터를 채우면
UI가 그 필드를 읽어 `Notice.setMessage()`로 `<progress>` 엘리먼트를 갱신한다
(`Notice`가 `DocumentFragment`를 받는다). `progressNotice` 필드가 없을 때(Backfill/
보정처럼 로딩 바를 안 띄운 실행)는 미들웨어가 아무 일도 하지 않는다. 같은 미들웨어가
"몇 편 수집했는지"(수집 0편과 실제 오류를 구분하지 못하던 문제)도 함께 해결한다 —
`run()`이 `Promise<void>`만 반환해 이 값을 자체적으로 알려줄 수 없기 때문이다.

### File.ts 함수 중복 제거

`readPapersByYear`(시각화 phase가 연도 단위로 읽을 자리)와 `readAllPapers`(보정
패스가 전체를 훑을 자리)가 필터링 prefix 한 줄만 다르고 나머지 몸통이 완전히
같았다. `readPapersUnder(prefix)` private 헬퍼로 몸통을 합쳤다(동작 변화 없음).

### API 키 입력을 실제로 연결

설정 탭의 "API 키" 필드는 값을 로컬 상태(`apiKeyDraft`)에만 담고 어디에도 저장하지
않는 죽은 UI였다. 저장은 이미 `FileTestModal`의 범용 Secret 폼(provider 이름을
직접 입력)으로 가능했지만, 개발자 테스트 모달이라 사용자가 여기서 등록해도 안
됐다고 착각하기 쉬운 상태였다.

- `Setting`에 "저장" 버튼을 추가해 `File.readSecret()` → `S2_SECRET_PROVIDER` 항목만
  갈아끼우고 `File.writeSecret()`으로 저장한다. 현재 저장본을 먼저 읽는 이유는
  Secret이 provider→key 맵 전체를 한 파일에 담기 때문 — 그대로 새 `Secret()`을 써서
  저장하면 다른 provider의 키까지 날아간다(구독 UI의 `persistSubscriptions()`가
  `updateTime`을 보존하려고 먼저 읽는 것과 같은 이유).
- 설정 탭을 열 때(`loadSubscriptions()`와 같은 시점) 이미 등록된 키가 있으면
  입력창에 채워서 보여준다 — 안 그러면 등록해놓고도 다시 열 때마다 비어 보여 헷갈린다.
  평문으로 보여주는 판단은 `FileTestModal`의 "Secret 확인하기"가 이미 쓰던 것과
  같다(이 vault 밖으로 안 나가는 로컬 값).
- 저장 실패를 성공으로 잘못 알리지 않도록, `persistApiKey()`는 에러를 삼키지 않고
  그대로 throw해 호출부(버튼 클릭 핸들러)가 성공/실패 Notice를 정확히 나눠 띄운다.

### `main.ts` 커맨드는 "아직 구현되지 않음" 상태를 유지한다

커맨드 팔레트의 두 커맨드(`collect-recent`, `collect-repair`)는 `EventListener.checking()`
→ `TaskManager.runTask()`를 거쳐야 하는데, 이 둘이 아직 스텁이다(`throw`만 함,
담당자 미배정 — 8/1 회의록 역할분담에 없음). 그래서 커맨드는 여전히 "아직 구현되지
않음" Notice만 띄운다. **설정 탭의 수집/보정 버튼이 `plugin.collectflow`를 직접
호출하는 유일한 실동작 경로다.**

## 검증

`test/collectAndSave.test.ts`에 통합 테스트를 추가해 총 **78건**(원래 36건에서
시작). 대역은 네트워크(`requestUrl`)와 Vault 둘뿐이고 `File`·`ArxivAPI`·
`CollectAndSave`는 전부 실제 코드가 돈다 — 커서가 정말 JSON으로 왕복하는지,
`writePaper`가 기존 파일을 읽어 값을 병합/보존하는지는 각 클래스를 흉내 내면
검증되지 않기 때문이다.

주요 검증 영역: 사전 조건(구독 없음/모델 미설치/backfill 구간 누락·NaN이 네트워크
전에 멈추는지), 중복 제거 확장 지점 계약, 임베딩 계약(순차 호출·서킷브레이커
초기화·실패해도 저장), 미들웨어 호출 순서·인자·실패 격리, 커서 전진·첫 실행이
API 선언 재스캔 창(4일)과 같은 폭인지·재스캔 보정·truncated 처리, 저장된
인용수는 재스캔에서 S2에 다시 안 묻는지(모르는 것만 정상적으로 묻는지), 저장본
재사용/보존(B-1/B-2), 재쓰기 스킵, `repair()`의 대상 선별과 디스크 불변성, 새
설치 환경(`Subscriptions.json` 없음)에서의 안전한 폴백, Secret 저장이 다른
provider의 키를 보존하는지.

UI 레이어(`SettingTab`)의 버튼 클릭·Notice 문자열 자체는 이 하네스로 검증하지
않는다(옵시디언 `Setting`/`PluginSettingTab` DOM 스텁 없음 — 기존 판단과 동일).
대신 그 UI가 의존하는 `File.readSecret`/`writeSecret`의 계약만 고정했다.

`npm run build`(tsc + esbuild) / `npm test`(78/78) / `npx eslint src test`(0 errors)
통과. Obsidian 앱을 직접 열어 수동 클릭하는 검증은 하지 않았다.

**임시 테스트 인프라 추가분** (004.md의 삭제 목록에 함께 포함될 것):
`test/helpers/vaultStub.ts`(메모리 Vault 대역), `test/stubs/obsidian.ts`에
`TFile`/`TFolder`/`Notice` 추가.

## 알려진 함정 (재발 방지 기록)

- **tsc/eslint 오탐**: 비동기 콜백(미들웨어)이 나중에 바꾸는 인스턴스 필드를
  `await` 직후 직접 읽으면, `= undefined` 대입 시점의 좁혀진 타입을 정적 분석이
  그대로 밀어붙여 `restrict-template-expressions`가 실제로는 값이 있는데도
  `never`로 오판한다. `private readX(): T | undefined { return this.x; }`처럼
  함수 호출로 감싸 선언된 반환 타입만 보게 하면 피해진다.
- **`File.readSubscriptions()`의 빈 폴백**: `Subscriptions.json`이 없을 때 돌려주는
  기본값은 `apis`/`updateTime`을 명시적으로 채운다(`!` 단언만 믿고 비워두면 컴파일은
  통과해도 런타임에 `undefined`라 호출자가 `.map()` 등에서 터진다 — 새 설치 환경에서
  실제로 재현됐다).
- **읽기 실패 후 저장 금지**: 설정 탭 구독 UI는 `Subscriptions.json`을 못 읽은
  상태에서는 저장을 거부한다(`subscriptionsUnreadable` 플래그). 안 그러면 화면의 빈
  목록이 디스크의 멀쩡한 구독을 덮어쓴다 — 예: 이 코드가 모르는 `apiName`이 저장돼
  있으면 읽기가 throw하는데, 그 상태에서 UI가 저장을 허용하면 기존 구독이 사라진다.
- **문서 vs 코드 드리프트 — 병합 충돌 해소가 조용히 기능을 지울 수 있다**: 이전
  버전의 이 문서는 "시각화 뷰의 '실제 arXiv 수집으로 실행' 버튼이 여전히 `run()`을
  우회한다"는 열린 항목을 갖고 있었다(004 devLog가 그 버튼의 존재를 기록). 그런데
  003/005 병합 중 `VisualizationView.ts` 충돌을 "005 내용으로 전부 덮어쓰기"로
  해소하면서 004가 만든 그 버튼이 소리 없이 사라졌다 — 코드를 다시 확인하기 전까지
  아무도 몰랐다. 병합 충돌을 "한쪽 통째로 채택"으로 해소하면, 채택 안 된 쪽의 작은
  기능이 diff에 안 보이는 채로 없어질 수 있다는 사례로 남긴다.

## 열린 항목 / 다음 담당자 참고

- **EventListener/TaskManager가 스텁**이라 커맨드 팔레트가 동작하지 않는다. 구현
  시 정해야 할 것들:
  1. `EventListener`가 `TaskManager`를 참조할 필드가 없다 — 다이어그램에도
     연결선 없음. `main.ts.init()`에서 필드 주입이 결이 맞아 보인다.
  2. `checking(eventName, ...args)` / `runTask(taskName, ...args)` /
     `Task.func(...args)`의 `unknown[]`을 실제로 쓸지 — 지금 두 Task는 클로저로
     인자를 다 담아버려서 `args`가 필요 없다.
  3. 매칭 안 되는 eventName/taskName일 때 throw vs 무시.
  4. 같은 eventName에 여러 task를 걸 수 있는가(`events`가 배열이라 구조상 가능) —
     001의 "미들웨어/태스크를 얹어 확장" 방향과는 팬아웃(find가 아니라 filter)이
     더 맞아 보인다. 시각화 phase도 이 결정을 물려받으므로 팀 공유 필요.
  5. 팬아웃이면 반환 타입도 `Promise<unknown>`에서 배열로 바뀌어야 한다.
- **S2 배치 조회 중복 — 재스캔(실행 간) 건은 해결, 한 실행 안(구독 간) 건은
  여전히 못 막는다.** `knownCitations`으로 이전 실행에서 이미 안 값은 다시 안
  묻게 됐다(위 참고). 다만 **같은 `run()` 호출 안에서** 서로 다른 구독(API
  인스턴스)이 같은 논문을 각자 잡으면 여전히 중복 조회한다 — `EnrichCitations`가
  `collectWindow` 안에서 API 인스턴스별로 반환 직전에 자동으로 돌기 때문에, 그
  뒤에 붙는 중복 제거 미들웨어(배열을 합친 뒤에야 동작)로는 이미 나간 요청을
  되돌릴 수 없다. 이건 API 밖으로 보강을 빼야 하는 문제라 "API = Paper를 완성하는
  방법"이라는 현재 설계와 충돌해 별도 논의가 필요하다.
- **구독 UI의 확정 디자인**(라디오 등)은 시각화 클래스 이후 별도 작업 — 현재 배선은
  유지한 채 표현만 갈아끼우면 된다.
- **커서 중간 저장은 하지 않는다**(설계 판단) — 저장본 재사용으로 재실행 비용이
  낮아져 중단 복원력 목적이 상당 부분 해소됐고, 시간 커서와 편수의 환산 복잡도
  대비 이득이 작다.
- **수집 취소 기능은 없다** — `run()`에 취소 신호를 받을 자리가 구조적으로 없다.
  별도 논의 필요.
