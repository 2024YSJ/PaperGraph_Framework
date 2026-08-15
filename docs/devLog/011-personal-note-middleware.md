# 8월 11일 작업 기록 — 개인 노트 노드 추가 미들웨어

`src/visualize/PersonalNoteMiddleware.ts` 신규 추가. vault에 사용자가 직접 쓴 "개인 노트"를
임베딩해 논문 노드와 같은 3D 그래프에 함께 배치하는 `visual` 미들웨어.

## 설계 원칙 — 기존 클래스 무수정

이 기능은 `PCA`/`Visualization`/`GraphData`/`File`이나 다른 시각화 미들웨어를 전혀 고치지
않고, 새 파일 하나(+ `main.ts` 등록 두 줄)로 완결되도록 만들었다. 기존 3개 시각화
미들웨어(`CitationColorMiddleware`, `OpenNoteOnClickMiddleware`, `CitationEdgeMiddleware`,
`src/visualize/VisualMiddlewares.ts`)가 이미 지키던 패턴이기도 하다 — 미들웨어는
`GraphData`가 공개로 노출하는 값만 갖고 동작한다.

이 원칙 때문에 생긴 트레이드오프:

- **프론트매터 제거 로직 중복**: `File.parseUserBody()`와 사실상 동일한 `---\n...\n---`
  스킵 로직을 `PersonalNoteMiddleware.stripFrontmatter()`로 다시 구현했다. `File.ts`를
  고치지 않기 위한 의도된 소규모 중복.
- **캐시 I/O 자체 구현**: `File.ts`에 새 공개 메서드를 추가하는 대신, `vault.create`/
  `vault.modify`/`vault.getAbstractFileByPath` 조합을 이 파일 안에서 직접 쓴다
  (`File.writeVaultText`와 같은 "있으면 modify, 없으면 폴더 만들고 create" 패턴).

## 좌표 배치 — PCA 축 투영이 아니라 이웃 기반 추정

처음에는 "논문 PCA 축(basis)에 노트 임베딩만 투영"하는 방식을 검토했지만, 이러려면
`Visualization.init()`이 계산한 축(`PCABasis`)과 x/y 펼치기 통계(z-score mean/std)를
`GraphData`에 새 필드로 노출해야 해서 위 원칙과 충돌한다. 대신 `GraphData`가 이미 공개로
갖고 있는 값만으로 좌표를 추정한다:

- **x, y**: 노트 임베딩과 코사인 유사도(임베딩이 이미 L2 정규화돼 있어 내적 = 코사인
  유사도)가 높은 논문 노드 상위 K(=8)개의 `fx`/`fy`를 유사도 기반 가중 평균.
- **z**: 이미 그래프에 있는 논문 노드들의 `(paper.publicationDate, fz)` 쌍 중 최솟값/
  최댓값 날짜 노드 둘을 찾아 기울기를 역산하고, 그 직선 위에 노트의 `fz`를 선형
  보간/외삽으로 얹는다. 유효한 날짜가 2개 미만이면 전체 노드 fz 평균으로 폴백한다.

두 방법 모두 논문 노드는 **읽기만** 하고 절대 수정하지 않으므로, 노트를 추가/삭제해도
기존 논문 좌표는 흔들리지 않는다.

## 다른 미들웨어의 존재/순서를 전제하지 않음

이 미들웨어가 만드는 노드의 색(초록, `#43a047`)과 클릭 동작(새 탭에 노트 열기)은 노드
생성 시점에 스스로 완결적으로 정한다 — `CitationColorMiddleware`나
`OpenNoteOnClickMiddleware`가 등록돼 있는지, 어떤 순서로 등록됐는지에 의존하지 않는다.
클릭은 `graph.events.nodeClick`에 별도 핸들러를 등록하고, 클릭된 노드의
`paper.sourceId`가 `note:` 접두사인지로 자기 노드인지 판별한다(GraphNode/Paper 타입을
확장하지 않았으므로 런타임 문자열 접두사가 유일한 판별 수단).

**알려진 한계**: `GraphData`는 여러 미들웨어가 공유하는 가변 상태라, 만약 "모든 노드"를
무조건 재색칠하는 미들웨어(현재는 `CitationColorMiddleware` — citationCount 기준 파랑/주황)가
이 미들웨어보다 *나중에* 등록되면 노트 노드의 초록색이 덮일 수 있다. 이는 이 기능만의
문제가 아니라 GraphData를 공유 가변 상태로 쓰는 기존 프레임워크 전체의 구조적 한계라 별도로
해결하지 않고 여기 기록만 해 둔다.

## 대상 폴더 — 지금은 하드코딩

대상 노트 폴더는 vault 루트의 `PersonalNotes/`로 상수 하드코딩돼 있다
(`PersonalNoteMiddleware.ts`의 `TARGET_FOLDER`). 설정 UI 브랜치와 머지된 뒤 `SettingTab`에
경로를 지정할 수 있는 필드를 추가할 예정 — 그 전까지는 이 이름의 폴더를 만들어야
개인 노트 노드가 나타난다.

## 캐시

`PaperGraph3D/PersonalNotes/`에 노트의 vault 경로를 그대로 미러링한 `.json`으로 임베딩
결과를 캐시한다(`{schemaVersion, notePath, mtime, title, embedding, embeddingModel,
embeddingSource, createdAt, updatedAt}`). 노트의 `mtime`이 캐시와 같으면 재사용, 다르면
재임베딩. 노트가 삭제/이동되면 캐시 파일은 정리하지 않고 그대로 남는다(더 이상 읽히지
않으므로 무해 — 별도 정리 로직은 만들지 않았다).

## 실패 처리

임베딩 모델 미설치, 개별 노트 임베딩 실패는 조용히 건너뛰고 `Log.warn`만 남긴다(시각화
자체는 정상 진행). 빈 노트(프론트매터 제거 후 본문 20자 미만)도 건너뛴다.

## 수동 확인 절차 (자동 테스트 없음)

`visualize/` 아래 다른 코드(PCA/Visualization)와 마찬가지로 자동 테스트는 추가하지 않았다
(App/Vault를 온전히 모사하는 테스트 인프라가 아직 없음 — `test/stubs/obsidian.ts`는
`requestUrl`만 대역한다). 대신 수동으로 확인한다:

1. 테스트 vault의 `PersonalNotes/`에 마크다운 노트 몇 개를 둔다.
2. 임베딩 모델을 설치한 뒤 시각화를 연다.
3. 초록색 노트 노드가 논문 노드들 사이에 나타나는지 확인.
4. 노트가 다루는 주제와 유사한 논문 근처에 배치되는지 육안으로 확인.
5. 노트 노드를 클릭하면 새 탭에 해당 노트가 열리는지 확인.
6. 같은 상태로 시각화를 다시 열었을 때 재임베딩 없이(로그로 확인) 캐시가 재사용되는지 확인.

## 진행한 작업 (구현)

- `src/visualize/PersonalNoteMiddleware.ts` 신규: 위 설계대로 `Middleware`(`type: 'visual'`)
  구현.
- `src/main.ts`: import 추가, `init()`에서 `PersonalNoteMiddleware` 생성·등록.
- **미검증**: 빌드/린트는 지시 시 실행. 실제 Obsidian 안에서의 육안 확인(위 수동 확인
  절차)은 별도로 필요.

## 커밋

- (작성 예정)

## 8월 15일 작업 기록 — 컨트롤 패널 고정 배치·임베딩 진행 표시·알림 위치

`mountControlPanel`이 만드는 우하단 오버레이 패널과, 이 미들웨어가 띄우는 알림들을
다듬었다. 새 클래스나 파일은 추가하지 않고 기존 `PersonalNoteMiddleware.ts`/
`styles.css` 안에서 완결된다.

### 컨트롤 패널 — 크기 고정 + 우하단 앵커

`.papergraph3d-note-panel`을 `top`(고정 폭 없는 `max-width`) 앵커에서 `bottom`/`right`
앵커·고정 `width: 220px`로 바꿨다. 경로를 여러 개 추가해도 패널 자체 크기(폭)는 변하지
않고, 세로로만 늘어나되 `max-height: 60%` + `overflow-y: auto`로 시각화 창을 벗어나지
않게 막는다.

### 임베딩 진행 표시 — `mountProgressIndicator`

노트가 많거나 모델 추론이 느릴 때 "지금 뭐가 진행되고 있는지" 안 보이는 문제가 있었다.
`run()`의 embed 루프 시작 전에 `mountProgressIndicator(graph, noteFiles.length)`를 호출해
`전체 N개 중 M개 진행 중` 텍스트를 `graph.container`에 직접 붙이고, 파일마다 갱신한다.

`mountControlPanel`과 달리 `renderHooks`를 거치지 않고 `run()` 도중 바로 `container`에
붙이는 이유: `Visualization.init()`이 미들웨어 실행 **전**에 이미 `graph.container`를
채워 두므로 이 시점에도 컨테이너가 존재하고(007/008 흐름: 논문 로드 → PCA → init →
미들웨어 → render), `Embedding.embed()`가 세션/서킷브레이커 상태 때문에 반드시 순차
실행이라 각 `await` 사이 브라우저가 그릴 기회를 얻어 진행 표시가 실시간으로 갱신된다.
반대로 `renderHooks`는 `Visualization.render()`가 3d-force-graph 인스턴스를 만든
**이후**에만 실행되므로, 루프 도중에는 아직 호출되지 않는다.

표시는 루프가 끝나면 스스로 `remove()`한다 — 어차피 뒤이어 `render()`가
`container.replaceChildren()`으로 컨테이너를 통째로 비우고 그 자리에 컨트롤 패널을
새로 그리므로, 자연히 진행 표시 → 컨트롤 패널 순서로 같은 우하단 자리를 이어받는 것처럼
보인다. `.papergraph3d-note-progress`는 `.papergraph3d-note-panel`과 같은 좌표(`bottom:
8px; right: 8px`)를 쓴다.

### 알림(Notice) 우상단 이동

Obsidian 기본 `Notice`는 앱 공용 `notice-container`(우하단 스택)에 쌓인다. 이 미들웨어의
알림 4곳(모델 미설치 안내, 표시 설정 저장 실패, 노드 N개 추가됨, 폴더 적용 실패) 전부
`PersonalNoteMiddleware.notify()`를 거치도록 바꿨다 — `new Notice(...)` 뒤 `noticeEl`에
`.papergraph3d-note-notice` 클래스를 붙이고, 그 클래스에 `position: fixed !important`로
`top`/`right`를 지정해 공용 컨테이너의 flex 배치를 벗어나 뷰포트 우상단에 독립적으로
앵커한다(부모가 fixed 배치를 위한 별도 containing block을 만들지 않는 한, fixed 자식은
부모의 레이아웃과 무관하게 뷰포트 기준으로 위치한다).

`noticeEl`은 Notice API에서 `@deprecated`(1.8.7+는 `messageEl`/`containerEl` 권장) 표시가
있지만, `manifest.json`의 `minAppVersion`이 1.7.2라 더 넓은 호환을 위해 의도적으로 이걸
썼다(eslint `no-deprecated` 경고 1건은 확인 후 허용).

### 미검증

빌드/린트만 확인했고, 실제 Obsidian 안에서 패널 고정폭·진행 표시 실시간 갱신·알림 위치
육안 확인은 별도로 필요.
