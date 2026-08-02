# 8월 1일 회의록

1. 빈 Class들을 먼저 선언해서 하나씩 채워가기.
2. 무조건 UI와 결합해야 하는 함수. 미리 선언해서 그걸 일단 임시 UI를 만들어서 붙여놓자.
3. 클로드 사용 활용법 찾아오기.

역할분담.

1순위 -> 성진 // 일요일까지 마감
빈 Class 만들기. & UI 결합 함수들 미리 선언해놓기.
임시 UI 만들기

2순위 -> 우빈 // 월요일까지 마감이지만 성진이가 빨리하면 나도 빨리 끝남
Secret Class
Paper Class
SearchQuery Class
File Class

3순위 // 수요일까지 개발
API & SearchQuery Class 제작. -> 신빈
임베딩 Class 제작.	-> 성진
PCA Class 제작.	-> 다예

다음 회의에

---

# 8월 2일 작업 기록 (성진 — 1순위 작업 결과)

## 진행한 작업

- `docs/Structure/PaperGraph3D_Class_Diagram.md` 다이어그램에 있는 클래스/인터페이스
  전체를 빈 껍데기(필드 + 메소드 시그니처)로 생성. 담당이 나뉜 Paper/Secret/SearchQuery
  /File/API/Embedding/PCA도 오늘 껍데기까지는 성진이 만들어둠 (내용 구현은 원래
  역할분담대로 각 담당자 몫).
  - 폴더 구조: `src/collect/`(수집), `src/visualize/`(시각화), `src/common/`(공통:
    Middleware, File, EventListener, TaskManager, Task), `src/adapter/`(Obsidian
    전용 UI/구현체)
  - 생성한 클래스/인터페이스: CollectAndSave, Subscriptions, Secret, API, SearchQuery,
    Paper, Embedding, VisualizationFlow, PCA, Visualization, GraphData, Middleware,
    File, EventListener, TaskManager, Task, PaperGraph3D(`src/main.ts`)
- UI와 반드시 결합해야 하는 함수 선언 + 임시 UI 연결
  - 커맨드: "최근 논문 수집 실행", "Backfill 실행"
  - 리본 아이콘 + 임시 뷰: "시각화 열기"
  - 설정탭: API 키 입력, 구독 추가/삭제(로컬 상태), 임베딩 모델 확인/설치 버튼
  - 실행 로직은 전부 미구현 상태(`throw`)로 남기고, 클릭 시 "아직 구현되지 않음"
    Notice가 뜨도록 함 — UI에서 코어 클래스까지 배선은 끝까지 연결된 상태
- `manifest.json` / `package.json`의 옵시디언 샘플 플러그인 이름(`sample-plugin` 등)을
  `papergraph3d`로 정리
- `C:\Users\sjyoo\Desktop\Konkuk\LogVault`에 빌드 결과물을 복사해 실제 Obsidian에서
  UI 동작 확인 진행 중

## 확정한 판단들 (팀원 확인 필요 시 참고)

1. **프레임워크화의 의미**: 멀티플랫폼 분리가 아니라, 개발자가 미들웨어/태스크를 얹어
   기능을 확장할 수 있는 "확장 가능한 옵시디언 플러그인"으로 간다.
2. **PaperGraph3D 진입점**: PaperGraph3D 클래스가 Obsidian의 Plugin을 직접 상속한다
   (`src/main.ts`가 곧 PaperGraph3D). 별도 어댑터 클래스로 감싸지 않음.
3. **File 클래스**: 저장 형식(Secret.json/Subscriptions.json 같은 실제 파일 vs
   Obsidian data.json)은 아직 미정이라 `interface`로만 추상화. Obsidian 구현체
   (`ObsidianFileAdapter`)는 `src/adapter/`에 별도로 둠.
4. **Paper의 (+)/(-) 표기 해석**: (+) = 새 Paper 클래스에 추가하는 필드, (-) = 새 Paper
   클래스에서 빼는 필드 (기존 프로젝트에 이미 있었는지 여부와는 무관한 표기).
   - ⚠️ "발행 년도 (-)"를 문자 그대로 반영해 `publicationYear`를 뺐음. 기존
     PaperGraph3D 프로젝트에서는 이 필드가 그래프 z축/backfill 윈도우/refresh 판단
     등에 널리 쓰였음. **우빈은 Paper 구현 전에 이 제거가 정말 맞는지 팀과 한 번 더
     확인할 것.**
   - 새로 추가된 필드: `citationsKnown`(인용수 확인 여부), `collectionMethod`
     ('recent' | 'backfill', 수집 방법), `embeddingSucceeded`(임베딩 성공/실패 T/F —
     기존 embedding/embeddingFailure 조합의 대체).
5. **스텁 작성 컨벤션**: 등록/설정 계열 함수(`setTask`, `setMiddleware`,
   `setEventListener` 등)는 실제로 동작하게 구현해서 `init()`이 안전하게 끝나도록
   함. 실행/로직 계열 함수(`run`, `runTask`, `checking`, API 호출, embedding/PCA/
   visualization 관련 함수 등)는 `throw`로 스텁. UI 콜백은 이를 `try/catch`로 감싸
   Notice로 안내.

## 커밋

- `eb09c19` 빈 클래스 구조 및 임시 UI 어댑터 생성
- `32fd056` 설정탭에 임베딩 모델 설치 확인/설치 UI 결합
- (브랜치: `001-empty-class-and-UI-adapter`)

## 다음 담당자 참고

- 위 3~4번 판단은 `docs/Structure/PaperGraph3D_Class_Diagram.md` 하단
  "2026-08-02 합의 사항" 절에도 동일하게 기록해둠.

## 8월 2일 후속 수정 — ObsidianFileAdapter static 전환

다이어그램(`Class File` 정의)에는 원래 "내부 함수/변수를 static으로 정의해서 객체
선언 없이 사용"하도록 명시돼 있었는데, 처음 껍데기를 만들 때는 `ObsidianFileAdapter`를
인스턴스 클래스(`constructor(private vault: Vault)`)로 구현해 다이어그램과 어긋나
있었다. 이를 바로잡아 다이어그램대로 static 클래스로 수정.

- `src/adapter/ObsidianFileAdapter.ts`: 생성자를 제거하고 모든 메소드를 `static`으로
  전환. `vault`는 `private static vault` 필드에 보관하고, `static init(vault)`로
  한 번만 등록한다.
- `src/main.ts`: `PaperGraph3D.files: File` 인스턴스 필드를 제거. `init()`에서
  `this.files = new ObsidianFileAdapter(this.app.vault)` 대신
  `ObsidianFileAdapter.init(this.app.vault)`만 호출.
- `src/common/File.ts`: 인터페이스 자체는 유지(계약 문서화 목적). `implements File`은
  더 이상 쓰지 않음 — static 멤버는 인스턴스 인터페이스로 표현할 수 없기 때문.
- `src/adapter/SettingTab.ts`: TODO 주석의 `this.plugin.files.xxx(...)` 호출 예시를
  `ObsidianFileAdapter.xxx(...)`로 갱신.
- 앞으로 File 관련 로직을 구현/호출할 때는 인스턴스를 만들지 말고 항상
  `ObsidianFileAdapter.메소드명(...)` 형태로 static 접근할 것.

## 8월 2일 후속 수정 2 — README/AGENTS/LICENSE 정리, 시각화 UI 단계 분리

옵시디언 샘플 플러그인 템플릿에서 그대로 남아있던 문서를 프로젝트에 맞게 정리하고,
파이프라인 단계별로 UI를 따로 테스트할 수 있도록 시각화 뷰를 나눴다.

- `README.md`: 샘플 플러그인 템플릿 설명(커뮤니티 목록 등록, 릴리스 절차 등)을 지우고
  PaperGraph3D가 하는 일 / 프로젝트 구조 / 개발 환경 설정으로 재작성.
- `AGENTS.md`: 제목·프로젝트 개요·파일 구조 예시를 실제 구조(`src/collect`,
  `src/visualize`, `src/common`, `src/adapter`)에 맞게 재작성. 보안/성능/manifest
  규칙 등 일반 가이드는 유지.
- `LICENSE`: 저작권자를 `Dynalist Inc.`(옵시디언 샘플 템플릿 표기)에서 `AKZIL`로
  변경. `.specify/`, `.claude/skills/speckit-*`, `docs/speckit/`는 별도 도구인
  Spec Kit(MIT, Copyright GitHub, Inc.)이 차지하고 있어 이 저작권 고지 대상이
  아니라는 점을 하단에 명시.
- `src/main.ts`: `VisualizationFlow.pca`/`.visual`이 `init()`에서 인스턴스화되지
  않던 버그 수정 (`new PCA()`, `new Visualization()` 추가).
- `src/adapter/VisualizationView.ts`: 기존에는 "지금 실행" 버튼 하나로
  `VisualizationFlow.run()`(PCA→초기화→렌더링) 전체만 테스트할 수 있었는데,
  `Visualization.init()` / `Visualization.render()` / 전체 `run()`을 각각 따로
  누를 수 있는 버튼으로 분리. PCA는 다예가 아직 함수를 정의하지 않아 버튼 대신
  안내 문구만 표시(다른 담당자 API를 임의로 만들지 않기 위함).
- 수집(Collect) 쪽은 다이어그램상 `run()` 밖으로 흐름 제어를 빼지 말라는 규칙이
  있고, 이미 recent/backfill 커맨드 + 임베딩 설치 확인/설치 버튼으로 단계가
  나뉘어 있다고 판단해 추가로 손대지 않음.