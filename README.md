# PaperGraph3D

PaperGraph3D는 논문을 수집·임베딩하고 3D 그래프로 시각화하는 Obsidian 플러그인입니다.
단순 플러그인이 아니라, 개발자가 미들웨어(Middleware)와 태스크(Task)를 얹어 수집/시각화
흐름을 확장할 수 있는 **확장 가능한 프레임워크**를 지향합니다.

## 하는 일

- **수집(Collect)**: 등록된 API/구독(Subscriptions) 조건에 따라 최근 논문 또는 과거
  논문(backfill)을 수집하고, 임베딩(Embedding)까지 수행한 뒤 저장합니다.
- **시각화(Visualize)**: 저장된 논문 데이터를 PCA로 차원 축소한 뒤 3D 그래프로 렌더링합니다.
- **확장(Extend)**: 수집/시각화 각 단계에 미들웨어를 등록하거나, `TaskManager`에 커스텀
  태스크를 등록해 파이프라인을 확장할 수 있습니다.

## 프로젝트 구조

```
src/
  collect/    수집 관련 클래스 (CollectAndSave, Subscriptions, Secret, API, SearchQuery, Paper, Embedding)
  visualize/  시각화 관련 클래스 (VisualizationFlow, PCA, Visualization, GraphData)
  common/     공통 클래스 (Middleware, File, EventListener, TaskManager, Task)
  adapter/    Obsidian 전용 UI/구현체 (SettingTab, VisualizationView, ObsidianFileAdapter)
  main.ts     PaperGraph3D 플러그인 진입점 (Obsidian Plugin 직접 상속)
```

전체 클래스 구조와 설계 결정 사항은 [`docs/Structure/PaperGraph3D_Class_Diagram.md`](docs/Structure/PaperGraph3D_Class_Diagram.md)를,
작업 진행 기록은 [`docs/plan/primary_plan.md`](docs/plan/primary_plan.md)를 참고하세요.

## 개발 환경 설정

- NodeJS v18 이상 필요 (`node --version`).
- 이 저장소를 클론합니다.
- `npm i` 로 의존성을 설치합니다.
- `npm run dev` 로 watch 모드 컴파일을 시작합니다 (`src/main.ts` → `main.js`).
- 편의를 위해 이 폴더를 볼트의 `.obsidian/plugins/papergraph3d` 아래에 두고 작업하면
  변경 사항을 바로 Obsidian에서 확인할 수 있습니다.
- 설정 페이지에서 플러그인을 활성화합니다.

## 플러그인 수동 설치

- `main.js`, `styles.css`, `manifest.json` 을 볼트의
  `VaultFolder/.obsidian/plugins/papergraph3d/` 에 복사합니다.

## 코드 품질 (ESLint)

- `npm run lint` 로 ESLint 검사를 실행할 수 있습니다.
- Obsidian 플러그인 전용 규칙(`eslint-plugin-obsidianmd`)이 포함되어 있습니다.

## API 문서

Obsidian 플러그인 API는 https://docs.obsidian.md 를 참고하세요.
