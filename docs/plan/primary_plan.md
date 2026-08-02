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

- (2026-08-02 정정) 개발 기록·변경 이력·논의 배경은 이 계획 문서(`primary_plan.md`)에만
  남긴다. `docs/Structure/PaperGraph3D_Class_Diagram.md`는 날짜/이력 없이 현재 클래스
  구조만 다루고, 배경 설명이 필요한 지점은 이 문서로 링크만 건다. (이전에는 두 문서에
  같은 내용을 중복 기록했었음 — 아래처럼 두 문서의 서술이 갈라지는 문제가 있어 정리함.)

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

## 8월 2일 후속 수정 3 — File/ObsidianFileAdapter 분리 폐기

`File`을 `interface`로 두고 `ObsidianFileAdapter`를 별도 구현체로 분리했던 이전 결정을
되돌렸다. static 클래스는 인스턴스 인터페이스를 `implements`할 수 없어서, static 전환
이후 `File` interface는 어디에도 연결되지 않는 죽은 코드가 됐고(참조하는 소비자도 없이
`SettingTab`/`main.ts`가 `ObsidianFileAdapter`를 직접 호출), 애초에 "저장 매체 교체
가능성 때문에 인터페이스로 추상화한다"는 목적 자체가 static 단일 구현체 구조와 상충했다.
저장 매체를 실제로 교체할 계획이 없다고 보고, 인터페이스+구현체 분리 대신 `File` 자체를
구현체로 합쳤다.

- `src/adapter/ObsidianFileAdapter.ts` 삭제.
- `src/common/File.ts`: `interface File`을 삭제하고, `ObsidianFileAdapter`에 있던
  static 멤버(`vault`, `init`, `readSecret`/`writeSecret`/`readSubscriptions`/
  `writeSubscriptions`/`readPaper`/`writePaper`)를 그대로 옮겨 `export class File`로
  만들었다. 메소드 본문은 이전처럼 전부 `throw` 스텁.
- `src/main.ts`, `src/adapter/SettingTab.ts`: `ObsidianFileAdapter` import/호출을 전부
  `File`로 교체 (`File.init(vault)`, `File.writeSecret(...)` 등).
- 부작용: `src/common/`이 더 이상 Obsidian API를 모르는 순수 TS 영역이 아니게 됐다 —
  `File.ts`가 `obsidian`의 `Vault`를 직접 import한다. 다이어그램/AGENTS/README의
  "common은 Obsidian을 모른다" 서술도 이에 맞춰 갱신함.
- `docs/Structure/PaperGraph3D_Class_Diagram.md`의 "2026-08-02 합의 사항" 절, `README.md`,
  `AGENTS.md`의 폴더 구조 설명도 `ObsidianFileAdapter` 삭제에 맞춰 갱신함.

## 8월 2일 후속 수정 4 — File을 PaperStore/SecretStore로 분리

`File`을 하나의 static 클래스로 합친 직후, `Secret`(보안 정보, 저장 매체 미정)과
`Paper`(vault 노트, 저장 매체 사실상 확정)가 같은 클래스의 static 상태(`vault` 필드)를
공유하는 문제가 드러났다:

- `Secret`만 테스트하려 해도 `File.init(vault)`를 만족시켜야 하는데, `obsidian` 패키지는
  타입 선언만 제공해서 실제 `Vault`를 만들 수 없다 — 목(mock)을 억지로 캐스팅해 넣어야 함.
- 한쪽(`Paper`) 저장 로직을 고치다 다른 쪽(`Secret`) 초기화 상태를 실수로 건드릴 위험.
- `Secret`은 팀 논의 결과 vault 파일이 아니라 Obsidian 플러그인 데이터
  (`Plugin.saveData/loadData`) + 암호화로 가는 방향이 유력해졌다 — 이건 `Vault`가 아니라
  `Plugin` 인스턴스가 필요해서 애초에 `Paper`와 API 자체가 다르다.
  - 다만 "plugin 데이터 폴더에 저장한다"는 것 자체는 보안 대책이 아니다. `data.json`도
    vault 안(`.obsidian/plugins/papergraph3d/`)에 있는 평문 파일이라, vault를 git/클라우드로
    동기화하면 그대로 같이 노출된다. 실제로 보호하려면 저장 전 암호화가 필요하고, 암호화
    키를 어디서 가져올지(사용자 패스프레이즈 / OS 자격 증명 저장소 등)는 아직 미정 —
    우빈이 `Secret` 구현 전 팀과 재확인할 것.

- `src/common/File.ts` 삭제.
- `src/adapter/PaperStore.ts` 신설: `Vault` 기반, `readPaper`/`writePaper`만 담당. static.
- `src/adapter/SecretStore.ts` 신설: `Plugin` 기반, `readSecret`/`writeSecret`/
  `readSubscriptions`/`writeSubscriptions` 담당. static. 암호화는 아직 스텁.
- `src/main.ts`: `init()`에서 `PaperStore.init(this.app.vault)` + `SecretStore.init(this)`
  두 줄로 등록 (`this`는 `Plugin`을 상속한 `PaperGraph3D` 자신).
- `src/adapter/SettingTab.ts`: `File.xxx(...)` 호출을 `PaperStore.writePaper(...)` /
  `SecretStore.writeSecret(...)` / `SecretStore.writeSubscriptions(...)`로 교체.
- 부작용(의도한 효과): `PaperStore`/`SecretStore`를 둘 다 `src/adapter/`로 두면서
  `src/common/`이 다시 Obsidian API를 모르는 순수 TS 영역으로 복원됐다 — `File.ts`가
  `common/`에서 유일하게 `obsidian`을 import하던 예외였는데, 그 예외가 없어짐.
- `docs/Structure/PaperGraph3D_Class_Diagram.md`, `README.md`, `AGENTS.md`도 `File` →
  `PaperStore`/`SecretStore` 분리에 맞춰 갱신함.

## 8월 2일 후속 수정 5 — 다이어그램 문서 구조 정리, 개발 기록 이관

`docs/Structure/PaperGraph3D_Class_Diagram.md`에 날짜·담당자가 붙은 "합의 사항"(변경
이력 서술)이 이 계획 문서(`primary_plan.md`)의 "후속 수정" 절들과 중복 기록되고 있었다.
같은 내용이 두 문서에 흩어져 있으면 한쪽만 고치고 다른 쪽을 놓치는 사고가 나기 쉬워서,
역할을 분리했다: **다이어그램 문서 = 현재 클래스 구조만(날짜/이력 없음)**,
**이 계획 문서 = 변경 이력·논의 배경·TODO**.

- 구조 모순 발견: `Class PaperStore`/`Class SecretStore`가 다이어그램의 `## 공통` 절
  아래 남아 있었는데, 실제로는 `src/adapter/`에 있다("폴더 구조" 서술과도 어긋남).
  `## 어댑터 (Obsidian 전용, src/adapter/)` 절을 새로 만들어 그 아래로 옮김.
- 다이어그램의 "2026-08-02 합의 사항" 절을 "설계 참고"로 개명하고, 날짜/담당자 표기와
  변경 이력 서술(예: "File → PaperStore/SecretStore 3차 수정" 문단), 개별 TODO(예:
  "우빈이 발행 년도 제거 여부 재확인")를 모두 제거 — 해당 내용은 이 문서(item 4, 이번
  절)에만 남긴다. 다이어그램에는 현재도 유효한 구조적 사실(프레임워크화 의미, 진입점,
  폴더 구조, Paper (+)/(-) 표기 규칙)만 남겼다.
- "다음 담당자 참고" 절의 "다이어그램에도 동일하게 기록해둠" 문구를 위 정책 설명으로
  교체 — 더 이상 두 문서에 같은 내용을 중복 기록하지 않는다.