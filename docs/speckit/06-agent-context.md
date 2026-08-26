# 06. 에이전트 컨텍스트 (1종)

> 확장: `agent-context` — *Coding Agent Context*

코딩 에이전트의 컨텍스트/지침 파일(`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `GEMINI.md` …)에서 **Spec Kit이 관리하는 구간만** 갱신합니다.

---

## `/speckit-agent-context-update`

> Refresh the managed Spec Kit section in coding agent context file(s).

**역할** — 컨텍스트 파일 안의 마커 구간을 현재 플랜 경로로 갱신합니다.

**관리 범위는 마커 사이로 한정됩니다.**

```markdown
# 내가 쓴 내용 — 건드리지 않음

<!-- SPECKIT START -->
(이 구간만 Spec Kit이 덮어씀)
<!-- SPECKIT END -->

# 내가 쓴 다른 내용 — 건드리지 않음
```

**사용 시점** — 두 가지 경로:
1. **자동** — `after_specify`, `after_plan` 훅으로 실행됩니다 (훅 2개)
2. **수동** — 컨텍스트 파일이 최신 플랜과 어긋났다고 느낄 때 직접 실행

**산출물** — `CLAUDE.md`의 마커 구간 (이 프로젝트 설정 기준)

---

## 이 프로젝트의 설정

설정 파일: `.specify/extensions/agent-context/agent-context-config.yml`

```yaml
context_file: ""          # 비어 있음 → 자동 시드
context_files: []
context_markers:
  start: "<!-- SPECKIT START -->"
  end: "<!-- SPECKIT END -->"
```

`context_file`이 비어 있으면, 스크립트가 **이 확장 자신의** `agent-context-defaults.json`에서 활성 인테그레이션 키(`.specify/init-options.json`의 `integration: claude`)를 찾아 값을 채웁니다. Specify CLI는 이 조회에 관여하지 않습니다.

**결과: `claude` → `CLAUDE.md`**

즉 이 프로젝트에서는 **`CLAUDE.md`가 관리 대상이고, 기존 `AGENTS.md`는 건드리지 않습니다.** `CLAUDE.md`는 아직 없으며, 이 스킬이 처음 실행될 때 생성됩니다.

### AGENTS.md도 함께 관리하려면

두 파일의 Spec Kit 구간을 동기화하고 싶다면 `context_files`를 씁니다. 이 목록이 비어 있지 않으면 `context_file`보다 **우선**합니다.

```yaml
context_files:
  - AGENTS.md
  - CLAUDE.md
```

제약: 절대 경로, 백슬래시 구분자, `..` 경로 세그먼트는 거부됩니다. 프로젝트 상대 경로만 허용됩니다.

### 마커를 바꾸려면

`context_markers.start` / `.end`를 수정하면 번들 스크립트가 그 값을 따릅니다. **이미 파일에 기존 마커로 쓰인 구간이 있다면 함께 바꿔야** 합니다 — 그러지 않으면 옛 구간이 고아가 되고 새 구간이 따로 생깁니다.

---

## 왜 확장으로 분리돼 있나

모든 사용자가 Spec Kit이 자기 에이전트 컨텍스트 파일에 쓰기를 원하지는 않습니다. 그래서 이 동작만 별도 **opt-in** 확장으로 떼어냈습니다.

- **`specify init`은 이것을 설치하지 않습니다.** (이 프로젝트는 나중에 `specify extension add agent-context`로 명시적으로 추가함)
- 확장이 없거나 비활성이면 **Spec Kit은 컨텍스트 파일을 절대 만들거나 수정하지 않습니다.**

일시적으로 끄고 싶다면:

```powershell
specify extension disable agent-context   # 끄기
specify extension enable agent-context    # 다시 켜기
```

---

## ⚠️ 요구사항: Python 3 + PyYAML

번들 업데이트 스크립트는 YAML 파싱과 upsert 처리를 위해 **Python 3와 PyYAML**을 필요로 합니다. (PowerShell에서 `ConvertFrom-Yaml`을 쓸 수 있으면 그쪽을 사용합니다.)

PyYAML은 `specify` CLI와 함께 설치되므로 보통은 같은 `python3` 인터프리터로 접근 가능합니다. 다음 오류가 나면 시스템 `python3`가 Spec Kit 설치에 쓰인 것과 다르다는 뜻입니다.

> *"PyYAML is required … not available in the current Python environment"*

해결:

```powershell
pip install pyyaml
# 또는 Spec Kit이 쓰는 인터프리터를 직접 지정
& "<speckit-python 경로>" -m pip install pyyaml
```

이 프로젝트는 `pyenv-win` shim(`python.bat`)을 통해 Python이 잡히므로, 훅 실행 시 이 오류가 나올 가능성이 있습니다. 그때는 위 명령으로 해결하세요.
