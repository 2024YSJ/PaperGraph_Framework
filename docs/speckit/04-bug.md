# 04. 버그 분류 워크플로우 (3종)

> 확장: `bug` — *Bug Triage Workflow*

기능 개발 트랙과 **완전히 분리된** 흐름입니다. 버그를 잡을 때는 `specify → plan → tasks → implement`를 돌리지 않고 이 3단계를 씁니다.

각 버그는 `.specify/bugs/<slug>/` 아래 자기 디렉터리를 갖고, 단계마다 마크다운 하나를 남깁니다.

```
.specify/bugs/<slug>/
├── assessment.md   # speckit-bug-assess
├── fix.md          # speckit-bug-fix
└── test.md         # speckit-bug-test
```

```mermaid
flowchart LR
    A["assess<br/>진짜 버그인가?"] --> F["fix<br/>고친다"] --> T["test<br/>정말 고쳐졌나?"]
```

---

## slug 규칙

`slug`는 `.specify/bugs/` 아래 버그별 디렉터리 이름이며, 세 커맨드가 공유하는 **유일한** 손잡이입니다.

- **사용자 지정** — 원하는 형태로 주면 소문자 kebab-case로 정규화 (`login-timeout`, `cve-2026-001`, `oauth-redirect-500`). 정규화 후 그대로 보존되며 타임스탬프나 번호가 자동으로 붙지 않습니다.
- **질문** — slug 없이 `assess`를 부르면 버그 요약에서 유도한 kebab-case 기본값을 제안하며 물어봅니다.
- **자동 생성** — 사람이 답할 수 없을 때 에이전트가 직접 만듭니다. 생성된 slug는 **반드시 고유 디렉터리를 만들어야 하며**, `.specify/bugs/<slug>/`가 이미 있으면 최소한의 구분 접미사(`-2`, `-3`, … 또는 `-20260605` 같은 짧은 날짜)를 붙입니다. **기존 버그 디렉터리는 절대 덮어쓰지 않습니다.**

---

## `/speckit-bug-assess`

> Assess a bug report (pasted text or URL) against the codebase and produce an assessment with possible remediation.

**역할** — 버그 리포트를 읽고 코드베이스와 대조해 세 가지를 판단합니다.

1. 이것이 **진짜 버그인가** (사양대로 동작하는 것을 버그로 오인한 건 아닌가)
2. 의심되는 **코드 경로**가 어디인가
3. 어떻게 **고칠 것인가** (교정안 제안)

**입력** — 붙여넣은 텍스트 또는 URL. 스택 트레이스, 에러 메시지, 재현 절차, 이슈 링크 등.

**산출물** — `.specify/bugs/<slug>/assessment.md`

**사용 시점** — 버그 워크플로우의 시작점. 리포트를 받자마자.

**주의** — 고치기 전에 판단하는 단계입니다. "진짜 버그가 아님"으로 결론 나는 것도 정상적인 결과이며, 그 판단이 문서로 남는 것이 이 단계의 값어치입니다.

---

## `/speckit-bug-fix`

> Apply the remediation from a bug assessment and record what was changed.

**역할** — `assessment.md`에 제안된 교정안을 실제로 적용하고, **무엇을 바꿨는지 정확히 기록**합니다.

**입력** — slug (앞 단계에서 이어짐)

**산출물** — 실제 코드 변경 + `.specify/bugs/<slug>/fix.md`

**전제조건** — `assessment.md`가 있어야 합니다. 평가 없이 바로 고치면 이 워크플로우를 쓰는 의미가 없습니다.

**사용 시점** — 평가 결과가 "진짜 버그이고 교정안이 타당함"일 때.

---

## `/speckit-bug-test`

> Validate that a previously fixed bug is resolved and record the verification report.

**역할** — 재현 절차와 추가된 테스트를 다시 돌려 **정말 고쳐졌는지 검증**하고 결과를 기록합니다.

**입력** — slug

**산출물** — `.specify/bugs/<slug>/test.md`

**전제조건** — `fix.md`가 있어야 합니다.

**사용 시점** — 수정 직후. 이 단계를 건너뛰면 "고쳤다고 믿는 상태"와 "고쳐진 상태"를 구분할 수 없습니다.

---

## 이 프로젝트에서의 활용

Obsidian 플러그인 특성상 버그 재현이 Obsidian 실행 환경에 의존합니다. `test.md`에 재현 환경(Obsidian 버전, 플러그인 버전, OS)을 함께 기록해두면 나중에 회귀를 판별할 때 유용합니다.

`npm run lint`와 GitHub Action 린트가 모든 브랜치의 커밋마다 돌기 때문에, `fix` 단계 이후 린트 통과 여부도 `test.md`의 검증 항목에 포함시키는 것이 좋습니다.
