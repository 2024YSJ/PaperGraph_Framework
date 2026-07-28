# 01. 핵심 워크플로우 (7종)

Spec-Driven Development의 뼈대입니다. `specify → plan → tasks → implement` 4단계가 필수 경로이고, 나머지 3종은 그 앞뒤를 감쌉니다.

| 스킬 | 위치 | 필수 |
|---|---|:---:|
| [`/speckit-constitution`](#speckit-constitution) | 프로젝트 최초 1회 | 권장 |
| [`/speckit-specify`](#speckit-specify) | 기능 시작 | ● |
| [`/speckit-plan`](#speckit-plan) | 명세 확정 후 | ● |
| [`/speckit-tasks`](#speckit-tasks) | 설계 확정 후 | ● |
| [`/speckit-implement`](#speckit-implement) | 작업 목록 확정 후 | ● |
| [`/speckit-converge`](#speckit-converge) | 구현 후 점검 | |
| [`/speckit-taskstoissues`](#speckit-taskstoissues) | 작업 분해 후 | |

---

## `/speckit-constitution`

> Create or update the project constitution from interactive or provided principle inputs, ensuring all dependent templates stay in sync.

**역할** — 프로젝트가 지켜야 할 원칙과 거버넌스를 문서로 못 박습니다. 여기 적힌 내용은 이후 모든 단계에서 참조되는 상위 제약이 됩니다. 실제로 `checklist`는 실행 시 `constitution.md`를 읽어 프로젝트 원칙을 반영합니다.

**사용 시점** — 프로젝트 최초 1회. 이후에는 원칙이 바뀔 때만.

**입력** — 프로젝트의 원칙이나 가치 (예: "TDD 필수, 외부 의존성 최소화, Obsidian API 호환성 우선")

**산출물** — `.specify/memory/constitution.md`

**현재 상태** — ⚠️ 아직 템플릿 플레이스홀더(`[PRINCIPLE_1_NAME]` 등) 상태입니다. 다른 스킬을 쓰기 전에 먼저 채우는 것을 권합니다.

**주의** — 원칙을 갱신하면 의존 템플릿들도 함께 동기화됩니다. 뒤늦게 원칙을 크게 바꾸면 이미 만들어둔 `spec.md` / `plan.md`와 충돌할 수 있습니다.

---

## `/speckit-specify`

> Create or update the feature specification from a natural language feature description.

**역할** — 자연어 설명을 구조화된 기능 명세로 변환합니다. **무엇을(What)/왜(Why)** 를 다루며, 구현 방법(How)은 여기서 쓰지 않습니다.

**사용 시점** — 새 기능의 출발점. Discovery 트랙을 거쳤다면 `decide`가 `go` 판정을 낸 직후.

**입력** — 만들고 싶은 기능 설명 (자연어)

**산출물** — `specs/<NNN>-<feature-name>/spec.md`

**연쇄 동작** — `git` 확장의 `before_specify` 훅이 **필수(mandatory)** 로 걸려 있어, 실행 시 `/speckit-git-feature`가 먼저 돌면서 피처 브랜치(`001-feature-name`)와 피처 디렉터리를 생성합니다.

**다음 단계** — 명세가 흐릿하면 `/speckit-clarify`, 명확하면 바로 `/speckit-plan`.

---

## `/speckit-plan`

> Execute the implementation planning workflow using the plan template to generate design artifacts.

**역할** — 명세를 **어떻게(How)** 구현할지 설계합니다. 두 단계로 나뉘어 진행됩니다.

| Phase | 하는 일 | 산출물 |
|---|---|---|
| Phase 0 | 미해결 `NEEDS CLARIFICATION` 항목을 조사로 해소 | `research.md` |
| Phase 1 | 엔티티 추출, 인터페이스 계약 정의, 검증 가이드 작성 | `data-model.md`, `contracts/`, `quickstart.md` |

**사용 시점** — `spec.md`가 확정된 뒤. **`/speckit-clarify`를 쓸 생각이라면 반드시 이 스킬보다 먼저** 실행하세요.

**입력** — (선택) 계획 단계에 줄 가이드 (예: "esbuild 번들 크기 최소화 우선")

**산출물** — `specs/<feature>/plan.md` + 위 표의 파일들

**전제조건** — `research.md` 완료가 Phase 1의 전제입니다. Phase 0에서 해소되지 않은 항목이 남으면 설계가 추측 위에 세워집니다.

**참고** — `contracts/`는 프로젝트에 외부 인터페이스가 있을 때만 생성됩니다. `quickstart.md`는 검증/실행 가이드이며, 구현 세부는 `tasks.md`와 구현 단계의 몫입니다.

---

## `/speckit-tasks`

> Generate an actionable, dependency-ordered tasks.md for the feature based on available design artifacts.

**역할** — 설계 산출물을 **의존성 순서가 매겨진 실행 가능한 작업 목록**으로 분해합니다. 순서가 핵심입니다 — 뒤 작업이 앞 작업의 결과에 의존하도록 정렬됩니다.

**사용 시점** — `plan.md`와 설계 산출물이 나온 뒤.

**입력** — (선택) 작업 생성 제약 (예: "테스트 작업을 구현 작업보다 먼저")

**산출물** — `specs/<feature>/tasks.md`

**다음 단계** — 곧장 `/speckit-implement`로 가도 되지만, 규모가 크면 `/speckit-analyze`로 정합성을 먼저 확인하는 편이 낫습니다.

---

## `/speckit-implement`

> Execute the implementation plan by processing and executing all tasks defined in tasks.md

**역할** — `tasks.md`의 작업을 순서대로 실제로 실행합니다. 코드가 실제로 쓰이는 유일한 단계입니다.

**사용 시점** — `tasks.md`가 확정된 뒤. 앞 단계가 부실하면 여기서 그 부실함이 코드로 굳습니다.

**입력** — (선택) 구현 가이드 또는 작업 필터 (예: "T001~T005만")

**산출물** — 실제 소스 코드 변경 + `tasks.md`의 완료 표시

**주의** — auto-commit이 켜져 있어 실행 전(`before_implement`)과 후(`after_implement`) 각각 커밋이 생성됩니다. 긴 구현은 중간 상태가 커밋에 남습니다.

---

## `/speckit-converge`

> Assess the current codebase against the feature's spec, plan, and tasks, then append any remaining unbuilt work as new tasks to tasks.md so implement can complete it.

**역할** — **현재 코드베이스와 명세 사이의 격차를 메웁니다.** 코드를 spec/plan/tasks와 대조해 아직 안 만들어진 것을 찾아내고, 그것을 새 작업으로 `tasks.md`에 **추가**합니다.

**사용 시점** — 두 가지 상황:
1. `implement` 이후 — 정말 다 됐는지 확인하고 누락분을 회수할 때
2. 기존 코드베이스에 Spec Kit을 뒤늦게 도입했을 때 — 현재 코드와 명세의 차이를 작업으로 환산

**입력** — (선택) 점검 범위

**산출물** — `tasks.md`에 append된 신규 작업

**루프** — `converge` → `implement` → `converge` … 를 잔여 작업이 없을 때까지 반복하는 게 정상 사용법입니다.

---

## `/speckit-taskstoissues`

> Convert existing tasks into actionable, dependency-ordered GitHub issues for the feature based on available design artifacts.

**역할** — `tasks.md`의 작업을 GitHub 이슈로 변환합니다. 의존성 순서가 이슈에도 보존됩니다.

**사용 시점** — `tasks.md` 생성 후, 작업을 팀과 나누거나 GitHub에서 추적하고 싶을 때. 혼자 작업한다면 불필요합니다.

**입력** — (선택) 이슈 필터 또는 라벨

**산출물** — GitHub 이슈 (원격 저장소에 생성)

**전제조건** — GitHub 원격 저장소가 필요합니다. `git` 확장의 `/speckit-git-remote`가 원격 URL을 감지해 넘겨줍니다.

**⚠️ 되돌리기 어려움** — 다른 스킬은 전부 로컬 파일만 건드리지만, 이 스킬은 **외부 서비스에 쓰기**를 합니다. 생성된 이슈는 수동으로 닫아야 합니다. 실행 전에 `tasks.md`를 한 번 검토하세요.
