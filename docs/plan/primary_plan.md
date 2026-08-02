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