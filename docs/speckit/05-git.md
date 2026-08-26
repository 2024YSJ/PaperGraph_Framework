# 05. Git 브랜칭 워크플로우 (5종)

> 확장: `git` — *Git Branching Workflow*

다른 확장과 성격이 다릅니다. **직접 부를 일이 거의 없습니다.** 5개 커맨드 대부분은 **훅(hook)** 을 통해 다른 스킬 실행 시 자동으로 끼어듭니다.

설정 파일: `.specify/extensions/git/git-config.yml`

---

## ⚠️ 현재 auto-commit이 전부 켜져 있습니다

기본값은 전부 `false`지만, 이 프로젝트는 **16개 auto-commit 항목을 모두 활성화**했습니다.

```yaml
auto_commit:
  default: true          # ← 전역 기본값
  before_clarify:
    enabled: true        # ← 16개 항목 전부 true
    message: "[Spec Kit] Save progress before clarification"
  ...
```

**결과** — core 워크플로우 스킬을 실행할 때마다 실행 전/후로 `[Spec Kit] ...` 커밋이 자동 생성됩니다.

**되돌리는 법** — 스크립트(`scripts/powershell/auto-commit.ps1`)의 판정 로직은 이렇습니다.

1. `auto_commit.default`를 읽어 전역 기본값 결정
2. 커맨드별 `enabled` 키가 있으면 **그 값이 우선**
3. 설정 파일이 없으면 auto-commit 비활성

따라서 **완전히 끄려면 `default: false`와 16개 `enabled: false`를 모두 되돌려야 합니다.** `default`만 `false`로 바꾸면 개별 `enabled: true`가 살아남아 해당 커맨드는 계속 커밋합니다.

---

## 훅 전체 표 (18개)

| 이벤트 | 실행 커맨드 | 선택적 | 설명 |
|---|---|:---:|---|
| `before_constitution` | `speckit.git.initialize` | ❌ **필수** | constitution 전에 git 저장소 초기화 |
| `before_specify` | `speckit.git.feature` | ❌ **필수** | 명세 작성 전에 피처 브랜치 생성 |
| `before_clarify` | `speckit.git.commit` | ✅ | 명확화 전 변경사항 커밋 |
| `before_plan` | `speckit.git.commit` | ✅ | 계획 전 커밋 |
| `before_tasks` | `speckit.git.commit` | ✅ | 작업 생성 전 커밋 |
| `before_implement` | `speckit.git.commit` | ✅ | 구현 전 커밋 |
| `before_checklist` | `speckit.git.commit` | ✅ | 체크리스트 전 커밋 |
| `before_analyze` | `speckit.git.commit` | ✅ | 분석 전 커밋 |
| `before_taskstoissues` | `speckit.git.commit` | ✅ | 이슈 동기화 전 커밋 |
| `after_constitution` | `speckit.git.commit` | ✅ | constitution 갱신 후 커밋 |
| `after_specify` | `speckit.git.commit` | ✅ | 명세 후 커밋 |
| `after_clarify` | `speckit.git.commit` | ✅ | 명확화 후 커밋 |
| `after_plan` | `speckit.git.commit` | ✅ | 계획 후 커밋 |
| `after_tasks` | `speckit.git.commit` | ✅ | 작업 생성 후 커밋 |
| `after_implement` | `speckit.git.commit` | ✅ | 구현 후 커밋 |
| `after_checklist` | `speckit.git.commit` | ✅ | 체크리스트 후 커밋 |
| `after_analyze` | `speckit.git.commit` | ✅ | 분석 후 커밋 |
| `after_taskstoissues` | `speckit.git.commit` | ✅ | 이슈 동기화 후 커밋 |

**필수 훅 2개(`initialize`, `feature`)는 auto-commit 설정과 무관하게 항상 실행됩니다.** auto-commit을 전부 꺼도 `/speckit-specify`는 여전히 브랜치를 만듭니다.

---

## `/speckit-git-initialize`

> Initialize a Git repository with an initial commit.

**역할** — Git 저장소를 초기화하고 첫 커밋을 만듭니다. 커밋 메시지는 설정 가능합니다 (`init_commit_message`, 기본값 `"[Spec Kit] Initial commit"`).

**사용 시점** — 직접 부를 일 없음. `before_constitution` 훅으로 자동 실행됩니다.

**이 프로젝트에서는** — 이미 git 저장소이므로 사실상 무동작입니다.

---

## `/speckit-git-feature`

> Create a feature branch with sequential or timestamp numbering.

**역할** — 피처 브랜치와 대응하는 `specs/<branch-name>/` 디렉터리를 생성합니다. 브랜치 이름이 곧 피처 디렉터리 이름입니다.

**번호 체계** — `branch_numbering` 설정으로 결정됩니다.

| 값 | 형식 | 예시 |
|---|---|---|
| `sequential` (현재 설정) | `NNN-feature-name` | `001-graph-view` |
| `timestamp` | `YYYYMMDD-HHMMSS-feature-name` | `20260319-143022-graph-view` |

`sequential`은 `specs/` 아래 기존 번호 중 최댓값 + 1을 씁니다.

**사용 시점** — 직접 부를 일 없음. `before_specify` **필수 훅**으로 자동 실행됩니다.

**직접 부르는 경우** — 명세 없이 브랜치만 먼저 따고 싶을 때.

---

## `/speckit-git-validate`

> Validate current branch follows feature branch naming conventions.

**역할** — 현재 브랜치 이름이 피처 브랜치 규칙에 맞는지 검사합니다.

**사용 시점** — 훅에 연결되어 있지 않은 **유일한 커맨드**입니다. 필요할 때 직접 부릅니다.

**언제 유용한가** — 워크플로우 중간에 브랜치가 꼬였는지 확인할 때. 예를 들어 지금 이 프로젝트의 `dev` 브랜치는 피처 브랜치 규칙(`001-...`)에 맞지 않으므로 검증에 걸립니다.

---

## `/speckit-git-remote`

> Detect Git remote URL for GitHub integration.

**역할** — GitHub 연동에 쓸 원격 저장소 URL을 감지합니다.

**사용 시점** — 직접 부를 일 없음. `/speckit-taskstoissues`가 이슈를 만들 때 내부적으로 씁니다.

**직접 부르는 경우** — 이슈 생성이 실패할 때 원격 감지 자체가 문제인지 확인하는 진단 용도.

---

## `/speckit-git-commit`

> Auto-commit changes after a Spec Kit command completes.

**역할** — 변경사항을 커밋합니다. 커맨드별로 활성화 여부와 메시지를 따로 지정할 수 있습니다.

**사용 시점** — 직접 부를 일 없음. 위 표의 훅 16곳에서 호출됩니다.

**메시지 커스터마이징** — `git-config.yml`의 각 항목 `message` 값을 바꾸면 됩니다.

```yaml
after_implement:
  enabled: true
  message: "[Spec Kit] Implementation progress"   # ← 여기를 수정
```

---

## 이 프로젝트에서 주의할 점

**`dev` 브랜치에서 시작하면 브랜치가 갈립니다.** `/speckit-specify`가 `before_specify` 필수 훅으로 `001-...` 피처 브랜치를 새로 만듭니다. 현재 작업 중이던 `dev`가 아닌 새 브랜치로 이동하게 되므로, 의도한 베이스 브랜치 위에서 시작하는지 확인하세요.

**`.claude/`와 `.specify/`가 아직 untracked입니다.** auto-commit이 켜진 상태에서 첫 speckit 커맨드를 돌리면 스테이징 범위에 따라 이 디렉터리 전체가 `[Spec Kit] ...` 메시지로 함께 커밋될 수 있습니다. 커밋 이력을 깔끔하게 유지하려면 미리 직접 커밋하거나 `.gitignore`에 넣어 정리해두세요.

**린트 액션이 모든 브랜치에서 돕니다.** `.github/workflows/lint.yml`이 모든 브랜치의 모든 커밋에 대해 실행되므로, auto-commit이 만드는 중간 상태 커밋도 CI를 트리거합니다. 구현 도중의 미완성 코드가 린트에 걸릴 수 있습니다.
