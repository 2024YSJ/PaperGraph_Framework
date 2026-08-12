# 8월 10일 작업 기록 — 확정 설정 UI 1차 개편

수집(006)·시각화(007·008)가 끝나 실데이터 파이프라인이 다 이어진 뒤, README/AGENTS.md가
계속 "확정 UI는 시각화 이후 별도 작업"이라고 미뤄 왔던 그 작업을 시작한다. 이 문서는
`010-settings-ui` 브랜치에서 진행한 판단과 최종 코드 상태를 정리한다.

## 범위 확정

작업을 시작하기 전에 범위를 먼저 좁혔다: 시각화 뷰(`VisualizationView.ts`)는 이미 008에서
최소한으로 정리돼 있어 이번엔 손대지 않고, **설정 탭(`SettingTab.ts`)만** 대상으로 했다.

- 디버그/테스트 전용 UI는 **완전히 제거**한다 — 숨김 모드로 남기지 않는다.
- 참고할 디자인 레퍼런스는 없다 — Obsidian 네이티브 `Setting`/`Modal` 스타일 그대로 간다.
- 프레임워크 도입 없이 **순수 Obsidian API**만 쓴다(AGENTS.md의 "작은 플러그인 유지" 원칙).

## 디버그/테스트 UI 제거

제거 대상과 판단:

- **파이프라인 테스트 헤딩** — 이미 실기능(수집/보정 버튼)으로 대체된 지 오래인데 이름만
  "테스트"로 남아 있던 상태. 헤딩 자체를 지우고 각 섹션에 맞는 이름을 새로 붙였다.
- **수집 로그(임시 진단용) 섹션** — `Log.ts`가 애초에 "수집이 조용히 끊기는 원인"을 잡기
  위한 임시 진단 도구였는데, 006 devLog의 8월 7일·8일 재점검 기록을 보면 그 원인은 이미
  다 잡혀서 안정화됐다(Backfill 상한, 타임아웃, 청크 저장, 구독별 커서, 보정 브레이커
  대응, 언로드 정지까지 전부 반영됨). UI만 걷어내고 `Log.ts` 자체(콘솔 로깅)는 다른 곳에서도
  계속 쓰이므로 남겨뒀다 — 대신 `fileEnabled` 기본값을 `true`→`false`로 바꿨다. UI 토글이
  없어진 상태에서 기본값이 켜져 있으면 사용자 모르게 vault에 로그 파일이 계속 쌓이기
  때문이다(이 전환 자체는 `Log.ts` 파일 자체 주석에 "지우는 법"으로 이미 안내돼 있던
  경로였다).
- **File 테스트 모달 / 저장(File) Paper 테스트 버튼** — `FileTestModal.ts` 통째로 삭제.
  실사용자에게 필요 없는 개발자용 저장 테스트였다.
- **PCA 플레이스홀더 섹션** — 버튼 없이 "아직 함수가 정의되지 않아 테스트 버튼이 없습니다"
  안내만 있던 자리. PCA는 시각화 파이프라인 내부에서 자동으로 도므로 별도 설정 항목 자체가
  불필요해 통째로 지웠다.
- **임베딩 100개 테스트 버튼** — 모의 논문(mock paper) 생성 코드 전체(단어/문장/제목 템플릿,
  `buildMockPaper` 등)까지 같이 제거. 실제 사용자 흐름에서 쓸 일이 없는 스트레스 테스트였다.

## API 키 / 구독 — 별도 창으로 분리

원래는 설정 탭 안에 "API 키"와 "구독" 섹션이 나란히 있었는데, 두 가지 이유로 별도 모달
(`ApiManagementModal.ts`)로 뺐다.

1. 구독은 다른 항목보다 **훨씬 자주 여닫는** 작업이다 — 조건을 추가/삭제할 때마다 설정 탭을
   열고 스크롤해서 찾아가야 하는 게 번거롭다는 문제.
2. API 키와 구독을 하나의 창에 묶어서, 설정 탭에는 "API / 구독 관리 → 열기" 진입점 버튼
   하나만 남겼다. 순서는 API 키를 위에, 구독을 아래에 두고 `<hr>`로 시각적으로도 두 묶음을
   분리했다.

**API 키 섹션에는 왜 등록이 필요한지 설명을 추가했다** — 이 프로젝트가 "API 연동은 코드로
확장"하는 프레임워크라서, "그럼 키도 코드에 넣으면 되지 않냐"는 질문이 자연스럽게 나올 수
있다. 답은: API 키는 **개인 계정 자원**이라 코드(번들)에 박으면 모든 사용자가 한 키의
요청 한도를 나눠 쓰게 되어 키를 등록하는 의미 자체가 사라진다. 그래서 설정 탭 UI 안에도
이 설명을 그대로 남겨뒀다.

이 창은 리본 아이콘("구독 관리", `rss` 아이콘)과 커맨드 팔레트("구독 관리 열기") 양쪽에서
바로 열 수 있다 — 설정 탭을 거치지 않는 진입점.

## 수집 실행을 컨트롤러로 추출 (`CollectController.ts`)

리본 아이콘에서 수집을 바로 실행할 수 있게 하면서, 진행률 Notice·수집 다이어그노스틱
미들웨어 등록 로직을 `SettingTab`에서 떼어 `CollectController`로 옮겼다. 이유: 설정 탭
버튼과 리본 아이콘 둘 다 수집을 트리거할 수 있어야 하는데, 진행률은 "지금 실행 중인 흐름
하나"를 공유해야 하므로 양쪽이 같은 인스턴스를 거쳐야 한다. `main.ts`의 `init()`에서
`collectflow`가 준비된 직후 `CollectController`를 한 번만 생성하고, 진단 미들웨어 등록도
그 생성자 안에서 한 번만 한다(이전엔 `SettingTab.display()`가 열릴 때마다 idempotent 가드로
막아야 했던 것을 아예 구조적으로 없앴다).

**수집 버튼도 하나로 합쳤다** — 예전엔 "최근 논문"/"Backfill" 버튼이 따로 있었는데, 이제
"수집" 버튼 하나를 누르면 클릭 위치에 작은 메뉴(Obsidian `Menu`)가 떠서 둘 중 하나를
고른다. 리본 아이콘도 동일한 메뉴를 띄운다. 보정(repair)은 그대로 별도 버튼으로 남겼다 —
진행률 개념이 없어 메뉴로 묶을 이유가 없었다.

**임베딩 모델 확인/설치도 한 버튼으로** — 예전엔 "확인"과 "설치" 버튼이 분리돼 있어서
사용자가 확인을 먼저 누르고 설치를 또 눌러야 했다. 지금은 버튼 하나가 자동으로 판단한다:
미설치면 바로 설치, 이미 설치돼 있으면 알림만 띄운다.

## 대기열 진행 정보 — 설계를 한 번 바꿨다 (다음 담당자 참고)

"대기열" 표시에 지금 도는 API·조건·추려진/수집 개수를 보여 달라는 요청이 있었다. 처음엔
`CollectAndSave.run()`에 `onApiStart` 콜백을 새로 추가하는 방식으로 설계했는데(도메인
핵심 메서드 시그니처를 건드림), **반려**됐다 — 이 프로젝트는 "핵심 클래스는 손대지 않고
Middleware/Task로만 확장"하는 게 원칙이기 때문이다.

다시 살펴보니 `Paper`가 이미 `collectedApis`/`collectedQueries` 필드를 갖고 있고, API들이
항상 순차 처리되므로 `'all'`/`'forEach'` 미들웨어가 받는 청크는 항상 단일 API·조건에서
나온다는 걸 확인했다 — 즉 **`CollectAndSave.ts`를 전혀 안 건드리고**, 기존 진단 미들웨어
(`CollectController.registerDiagnostics()`)를 확장하는 것만으로 같은 정보를 얻을 수 있다.

### 구현 (완료)

`CollectController.ts`의 `ProgressFlow`에 `apiName`/`apiConditionsText`/`apiFound`/
`apiDone`을 추가하고, 기존 `'all'` 핸들러가 청크의 첫 논문에서
`collectedApis[0]`/`collectedQueries[0].query`를 읽어 API·조건을 식별한다.
`apiName`만으로는 "같은 API, 다른 조건의 구독 두 개가 연달아 도는" 경우를 구분 못 해서
`${apiName}::${conditionsText}` 합성 키가 바뀔 때만 리셋한다. `'forEach'`는 처리 개수를
누적한다. 큐 멤버십 변화(`onQueueChange`)와 별개로 진행률 변화를 알리는
`onProgressChange` 구독을 추가해, `SettingTab.renderQueueStatus()`가 청크/논문 단위로도
다시 그려지게 했다. 읽기 전용 투영 타입(`CollectApiProgress`)만 밖으로 내보내
`ProgressFlow`의 `Notice`/`started` 같은 UI 전용 필드는 안 새어나가게 했다.

한계로 남긴 것: API의 검색 결과가 0편이면 그 API에 대한 청크가 아예 안 와서 대기열
보조 줄에 전혀 안 보이고 다음 API(또는 종료)로 넘어간 것처럼 보인다 — 미들웨어 시점
데이터만 쓰는 방식의 자연스러운 한계로 감수했다. "API가 보고하는 총 예상 편수"(arXiv의
`totalResults`)도 `onTotal`은 미들웨어 경유가 아니라서 이번 범위에서 뺐다 — 필요하면
별도 논의.

### 후속 — "추려진" 문구가 오해를 부른 문제 (계산 로직이 아니라 문구로 해결)

사용자 리포트: 대기열의 "추려진" 개수가 실제와 안 맞아 보이고 페이지 크기(100편)씩
뛴다. 원인은 "최근 논문 수집"이 색인 지연에 대응하려고 `recentRescanWindowMs`(4일,
`API.ts`)만큼 항상 겹치는 구간을 다시 훑는다는 데 있다 — 이미 저장된 논문도 매번 이
청크에 다시 걸리는데 "추려진"이라는 말은 신규처럼 읽힌다.

처음엔 `CollectFoundMiddleware`가 `File.readStoredPaper()`로 신규/재확인을 실제로
구분해서 세는 방식으로 고쳤으나(`CollectController.ts`/`CollectMiddlewares.ts` 모두
수정), **되돌렸다** — `CollectController.ts`는 손대지 않는 쪽으로 방향을 바꿨다.
최종적으로는 계산 로직은 그대로 두고 `SettingTab.ts`의 표시 문구만 "확인 N편(재스캔
구간 포함) · 처리 M편"으로 바꿔, 실제 신규 여부를 구분하지 않고도 오해를 줄였다.

## 8월 12일 후속 — 대기열 자연어화·구독 순번·페이지 점프 설명, 그리고 sink를 다시 하나로 합친 경위

세 가지 후속 불만을 더 처리했다: (1) 대기열 문구가 여전히 `apiName` 원본 id·영어
`AND`·대시 위주라 개발자 톤이었다, (2) 구독이 여럿일 때 지금 몇 번째인지 안 보였다,
(3) 진행 숫자가 페이지 크기(100편)만큼 뭉쳐서 뛰어 보였다.

**문구 통일 + 조건 구분자**: `CollectController`의 Notice와 `SettingTab`의 대기열 박스가
각자 따로 조립하던 문구 로직을 `CollectMiddlewares.ts`의 `formatSubscriptionProgress()`
하나로 합쳤다. 조건 join 구분자도 `' AND '`(영어 대문자)에서 `'·'`로 바꿨다.

**구독 순번**: `CollectAndSave.collect()`의 `onApiStart`/`onApiDone`이 이미
`(api, index, total)`을 넘기는데, `CollectController`가 `total`을 받지 않고 버리고
있었다. 그 값을 받아 `SubscriptionProgressEntry.index`/`subscriptionCount`에 채워
"(2/3번째 구독)"처럼 표시한다. 구독이 하나뿐인 보통의 실행에는 접두어를 안 붙인다 — 안
그러면 "너무 길다"는 예전 피드백을 반복하게 된다.

**페이지 점프 설명**: "100편씩 뜀" 리포트를 다시 조사했다 — 실제 데이터 유실이 아니라
`ArxivAPI`의 `PAGE_SIZE=100`/`PAGE_DELAY_MS=3000ms`(`API.ts`)로 페이지가 3초 간격으로
도착하는데, "최근 논문 수집"은 재스캔 구간을 매번 다시 훑어 대부분 이미 저장된 논문이라
`embedOrReuse`가 즉시 재사용(사실상 순간 처리)되기 때문이었다. `CollectFoundMiddleware`가
'all' 호출마다(=페이지 하나 도착마다) `pageCount`를 늘려 "N번째 묶음 확인"을 같이
보여주는 것으로 설명 가능하게 했다 — 렌더링을 인위적으로 늦추는 방식(수집 자체를
느리게 만듦)은 채택하지 않았다.

### 자동 수집·명령어 팔레트에서 진행이 아예 안 보이던 문제 (설계를 두 번 바꿨다 — 다음 담당자 참고)

위 세 가지를 확인하던 중, `main.ts`가 스케줄러(자동 수집)와 명령어 팔레트("최근 논문
수집 실행")를 위해 `collectflow.run('recent')`를 진행률 콜백 없이 **직접** 불러온다는 걸
발견했다. `CollectController`를 전혀 거치지 않으니 `activeFlow`가 채워지지 않고, 이
두 경로로 실행하면 대기열 박스에 그 실행의 구독별 진행이 하나도 안 보였다(순번은커녕
진행률 자체가 없었다).

**1차 시도 — `CollectController.runRecentAuto()` + `runCollectFlow`.** 되돌렸다. 자동
수집/명령어 팔레트는 원래 조용히 도는 게 설계 의도였는데(예전에도 성공 Notice가 없었다),
`runCollectFlow`를 그대로 태우면서 이 경로에 없던 Notice 팝업이 새로 생겼다.

**2차 시도 — `CollectController.ts`를 아예 안 건드리는 별도 sink.**
`CollectMiddlewares.ts`에 Notice 없는 `BackgroundCollectProgress` sink를 새로 만들고,
`main.ts`에서 `CollectFoundMiddleware`/`CollectDoneMiddleware`를 그 sink용으로 하나 더
등록했다(같은 미들웨어 클래스가 `sink`를 인자로 받으므로 가능). Notice 문제는 해결됐지만
검토 결과 두 가지 새 문제가 드러나 **되돌렸다**:

- `CollectController.runWithProgress`의 원래 전제 — "지금 실행되는 큐 작업이 항상
  하나이므로, 시작한 흐름이 곧 미들웨어가 갱신할 대상이다" — 가 `activeFlow`(수동 실행)와
  `BackgroundCollectProgress.flow`(자동/명령어 실행)라는 두 개의 "활성 흐름"으로
  쪼개지면서 깨졌다. 지금은 `CollectAndSave`의 큐가 직렬이라 겉으로는 안 겹치지만, 안전이
  구조가 아니라 우연에 기대고 있었다: `main.ts`의
  `.finally(() => backgroundCollectProgress.endRun())`은 `collectflow.run()`이 돌려준
  프라미스에 **나중에** 붙는 콜백인데, `CollectAndSave.enqueue()`는 같은 프라미스에
  **먼저** `this.tail = result.then(...)`을 붙여 다음 대기 작업을 깨운다. Promise 콜백은
  붙인 순서대로 실행되므로, 이론적으로는 자동 실행이 끝나자마자 대기 중이던 수동 실행이
  시작될 때 `endRun()`보다 먼저 `onStart`가 불릴 수 있는 구조였다 — 지금은 `runNow()`
  초반에 `File.readSubscriptions()` 같은 실제 비동기 I/O가 있어 그 사이 `endRun()`이
  먼저 끝나는 것뿐이라, 그 I/O가 나중에 최적화로 사라지면 실제로 터질 수 있는 레이스였다.
- 구독 항목 조립 로직(`apiName`/`conditionsText`/`index`/`subscriptionCount`/`pageCount`
  초기화)이 `CollectController.runWithProgress`와 `BackgroundCollectProgress.beginRun()`
  두 곳에 그대로 중복돼, 나중에 한쪽만 고치면 두 실행 경로의 문구가 조용히 어긋날
  위험이 있었다.

**최종 — `CollectController.ts`로 다시 합쳤다.** `runWithProgress()`에 `silent` 플래그를
추가해 Notice 생성만 건너뛰고, `activeFlow` 갱신(=대기열 박스가 읽는 단일 진실 공급원)은
silent 여부와 무관하게 항상 같은 자리에서 일어나게 했다. 새로 추가한
`runRecentAuto()`가 이 플래그로 조용히 실행한다. `runCollectFlow`(실패를 삼키고 Notice로만
알림)는 쓰지 않는다 — 이 경로는 원래 실패를 그대로 던져 호출자가 처리하는 계약이었다
(Scheduler는 로그만 남기고, 명령어 팔레트는 자기 Notice를 띄운다). `main.ts`의
`collectRecentTask.func`는 이제 `this.collectController.runRecentAuto()` 하나만 부른다.

**판단 기준**: "이 파일은 손대지 않는다"는 제약보다 "활성 흐름은 항상 하나"라는 이
클래스의 핵심 불변조건을 지키는 쪽을 우선했다 — 특정 파일을 피하려고 진실 공급원을
둘로 쪼개면, 당장은 안 터져도 나중에 실행 순서가 조금만 바뀌어도 재현하기 어려운 버그가
될 수 있다는 판단이다.

## 검증

`npm run build` / `npm run lint`(0 errors, 기존과 동일한 경고만) / `npm test`(114 pass, 0
fail) 통과. Obsidian 실기기에 설치해 리본 아이콘·수집 메뉴·API/구독 관리 모달·임베딩
모델 버튼을 직접 눌러 확인했다(8월 10일 1차 개편분). 8월 12일 후속(구독 순번·페이지
점프 설명·자동 실행 경로 통합)은 빌드/린트/테스트로 확인했고, 실기기에서 구독 2개 이상
등록 후 수동 실행·자동 수집·명령어 팔레트 각각으로 재확인하는 건 다음 확인 때 마저
한다.
