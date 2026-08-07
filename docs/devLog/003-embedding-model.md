# 8월 4일 작업 기록 (성진 — 3순위 작업, Embedding Class)

`docs/plan/primary_plan.md`의 3순위 "임베딩 Class 제작"(성진 담당)을 실제로 구현하기 전, 팀 자매 프로젝트 `PaperGraph3D`(`Desktop/Konkuk/3-1_takeoff/_PaperGraph/PaperGraphDev/PaperGraph3D`)의 검증된 임베딩 구현을 조사하고, 이 저장소의 새 `Paper` 필드 구조(embedding/embeddingModel/embeddingSource/embeddingSucceeded, 전부 non-nullable)에 맞게 이식하기 위한 설계를 코드 작성 전에 먼저 확정한다.

## 2026-08-04 확정 사항

### 모델 선택: specter2 8bit 양자화(q8) 버전, 온디바이스 고정

- 임베딩 모델은 **specter2**(`allenai/specter2_base` + proximity adapter, citation-triplet으로 학습된 BERT-base 인코더)의 **8bit 양자화(q8) ONNX 버전**을 온디바이스로 돌린다. 모델은 사용자가 고를 수 있는 옵션이 아니라 고정값이다 — 코퍼스 전체가 하나의 임베딩 공간을 공유해야 시각화(PCA/그래프)에서 논문들을 같이 투영할 수 있고, 모델을 바꾸면 차원/공간이 달라져 사실상 다른 모델이 되기 때문.
- 예전 `PaperGraph3D` 프로젝트에서 이미 이 선택을 검증했고, 실제 vault에 저장된 논문 데이터(`embeddingModel: "local-specter2-proximity-v1-d768"`)도 이 모델로 만들어진 것이었다(002.md 참고).

### 모델 배포: 이 저장소의 새 GitHub Release

- 모델 파일(양자화 ONNX ~108MB + WASM 런타임 ~21MB, 합쳐서 ~130MB급)은 플러그인 본체(`main.js`)에 번들하지 않는다. Obsidian은 릴리스에서 `main.js`/`manifest.json`/`styles.css`만 설치하므로, 이 크기를 번들에 넣으면 매 시작마다 파싱해야 하는 130MB+ 파일이 된다.
- 대신 **이 저장소(`2024YSJ/PaperGraph_Framework`)의 새 GitHub Release**에서 사용자가 설정 탭의 "설치" 버튼을 눌러야만 다운로드한다(자동 다운로드 없음 — `AGENTS.md`의 "로컬/오프라인 우선, 필수적일 때만 네트워크 요청, 사용자에게 무엇이 왜 필요한지 공개" 원칙). 예전 프로젝트(`2024YSJ/PaperGraph3D`)의 릴리스를 재사용하지 않고 소유권을 이 저장소로 옮긴다.
- **태그**: `model-specter2-q8-v1`. 에셋 6개(flat 이름, GitHub Release 에셋은 `/`를 못 씀): `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `model_quantized.onnx`(로컬 저장 경로만 `onnx/` 하위), `ort-wasm-simd-threaded.jsep.wasm`.
- **(2026-08-04 갱신) 실제로 변환·양자화해서 업로드 완료함.** 처음 이 문서를 쓸 때는 "코딩 작업 범위 밖의 수동 작업"으로 남겨뒀지만, 이후 세션에서 Python(torch/transformers/adapters/optimum/onnxruntime)으로 `allenai/specter2_base` + `allenai/specter2`(proximity adapter, load_as="proximity")를 로드·병합해 ONNX로 export하고, `onnxruntime.quantization.quantize_dynamic`(QInt8, per_channel+reduce_range)로 8bit 양자화한 뒤, `config.json`/`tokenizer.json`/`tokenizer_config.json`/`special_tokens_map.json`(전부 `allenai/specter2_base`에서 그대로 가져옴, 변환 불필요)과 함께 실제로 `model-specter2-q8-v1` 태그에 업로드했다. WASM은 프로젝트의 `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm`(package.json이 고정한 버전과 정확히 동일본)을 그대로 사용.
  - 검증: fp32 ONNX ↔ PyTorch 원본 코사인 유사도 1.0000(오차 ~2e-6), int8 양자화 ↔ fp32 코사인 유사도 0.9972, 서로 다른 두 논문이 실제로 다른 벡터를 내는지(0.926, 동일하지 않음)까지 확인. 릴리스 다운로드 URL도 실제로 302→200 정상 응답하는 것 확인함.
  - ⚠️ **모델 변환 파이프라인 자체는 저장소에 스크립트로 커밋돼 있지 않다** — 그때그때 스크래치패드에서 실행하고 지웠다. 나중에 모델을 다시 바꾸거나 재양자화해야 하면 이 문서에 적힌 절차(라이브러리 목록, 로딩 방법, 검증 지표)를 참고해 같은 과정을 새로 짜야 한다. 재현 가능한 스크립트로 저장소에 남겨두는 게 다음 개선 과제.
  - ⚠️ Python 3.14 + Windows 환경에서 스크래치패드처럼 경로가 깊은 곳에 venv를 만들면 `ml_dtypes`/`onnx` 로딩이 `WinError 206`(MAX_PATH 초과)로 실패한다 — 짧은 경로(`C:\...`)에 venv를 만들 것.
- ⚠️ **지금은 릴리스가 올라가 있으므로**, `installModel()`이 실패한다면 "에셋이 안 올라가 있어서"가 아니라 다른 원인(네트워크, Obsidian CSP, wasm 로딩 등)이다 — 아래 "다음 담당자 참고" 갱신본 참고.
- ⚠️ WASM 바이너리는 `package.json`에 고정한 `@huggingface/transformers` 버전과 정확히 짝이 맞아야 한다 — 버전이 바뀌면 WASM도 재검증/재업로드해야 한다.

### 파일 구조: `src/collect/Embedding.ts` 단일 파일

- 예전 프로젝트는 `modelAssets.ts`(다운로드)/`embedding.ts`(베이스라인)/`localTransformer.ts`(ONNX 추론)/`embeddingUpgrade.ts`(오케스트레이션) 4개 파일로 나뉘어 있었지만, 이 저장소는 `src/common/File.ts`가 세운 "한 클래스 + private 헬퍼로 전부 묶기" 컨벤션을 따라 **`Embedding` 하나로 통합**한다.
- 단, `File`과 달리 `Embedding`은 `private static`이 아니라 **인스턴스 클래스**다. vault/pluginDir/캐시된 모델 위치/캐시된 ONNX 세션 같은 실제 런타임 상태를 들고 있어야 하기 때문 — `main.ts`에서 이미 `this.collectflow.embedding = new Embedding()`으로 인스턴스 필드로 다루고 있던 것과도 일치한다.

### `isDesktopOnly: true`로 변경 — 팀 전체에 영향을 주는 결정

- ~130MB WASM+ONNX를 온디바이스로 돌리는 건 메모리 부담이 커서 모바일에 부적합하다고 판단, `manifest.json`의 `isDesktopOnly`를 `false`에서 `true`로 바꾼다. 예전 프로젝트도 같은 이유로 `true`였다.
- ⚠️ **이건 Embedding 하나의 문제가 아니라 플러그인 전체의 결정이다.** `isDesktopOnly: true`가 되면 다예의 PCA/시각화, 신빈의 API, 우빈의 File 기능을 포함해 플러그인 전체가 모바일에서 실행되지 않는다. `AGENTS.md`의 Mobile 섹션("가능하면 iOS/Android도 테스트", "`isDesktopOnly`가 true가 아니면 데스크톱 전용을 가정하지 말 것")이 전제하던 방향과 반대다.
- 이번 3순위 작업 진행을 위해 데스크톱 전용으로 확정하고 진행하지만, **팀 논의에서 다시 뒤집힐 수 있는 결정**이라는 점을 남겨둔다. 이후 모바일 지원이 필요해지면 온디바이스 임베딩을 모바일에서만 선택적으로 끄는 등의 대안을 검토해야 한다.

### `@huggingface/transformers` 의존성 — `dependencies`로 추가 (예전 프로젝트와 다름)

- 예전 프로젝트는 이 패키지를 `optionalDependencies`로 뒀지만, 이 저장소는 **일반 `dependencies`**로 추가한다.
- 이유: `package.json`의 `build` 스크립트(`tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`)에서 `tsc -noEmit`이 항상 선행되는데, Obsidian은 어차피 `main.js`에 전부 번들된 걸 설치하므로 이 패키지는 실질적으로 옵션이 아니라 필수다. `optionalDependencies`로 두면 `npm ci --omit=optional` 같은 환경에서 설치가 스킵돼 `tsc`가 비결정적으로 실패하거나, 임베딩 기능이 빠진 `main.js`가 조용히 만들어질 위험이 있다.
- ⚠️ `AGENTS.md`의 "플러그인을 작게 유지하라, 큰 의존성을 피하라" 원칙에서 의도적으로 벗어나는 선택이다. 번들 크기가 수백KB~1MB 이상 늘어나지만, 온디바이스 임베딩 기능 자체가 이 의존성 없이는 불가능하므로 불가피하다고 판단했다.

### 설치 UI: 진행률은 파일 단위로 상세화, 버튼 구조는 기존 2개(확인/설치) 유지

- `installModel()`의 진행률 콜백을 기존의 단순 `0~1` 숫자에서 **`AssetProgress{fileIndex, fileCount, fileName, bytesWritten}`**로 업그레이드한다. 파일 6개를 순차 다운로드하는데, "몇 번째 파일을 받고 있는지"를 보여주는 게 사용자에게 더 유용하다.
- `SettingTab.ts`의 UI는 기존 "확인"/"설치" 2버튼 구조를 그대로 유지한다(예전 프로젝트의 "설치 상태에 따라 버튼 하나가 바뀌는" 방식으로 통합하지 않기로 함 — 이번 세션에서 논의 후 결정). "확인" 버튼은 `isModelInstalled()` 결과를 Notice로 보여주도록 실동작화하고, "설치" 버튼은 클릭 시 비활성화 후 하나의 지속 Notice에 파일별 진행률을 갱신하며, 완료/실패 후 재활성화한다.
- **(2026-08-04 추가) "테스트 (100개)" 버튼**: 같은 "임베딩 모델" 섹션에 세 번째 버튼으로 추가. 초록 길이가 1~20배로 달라지는 모의 논문 100편(`LENGTH_BUCKETS`의 세 버킷을 전부 밟고, `INFERENCES_PER_SESSION`(64)을 넘겨 세션 재생성까지 exercise하도록 의도적으로 설계)을 만들어 각각 `embed()`를 호출하고, 성공/실패 카운트를 진행률 Notice로 보여준다. 문서는 `embedding_test/` 폴더(Vault 루트, `PaperGraph3D/` 트리 밖)에 `.md`+`.json`(Paper 형식)으로 저장한다 — `File.writePaper`가 쓰는 날짜 기반 경로 대신 임의 폴더에 저장하는 `File.writeTestPaper(paper, folder)`를 새로 추가해서 씀(`readPapersByYear`는 `PaperGraph3D/<year>/`만 보므로 이 테스트 파일은 정식 수집 데이터와 섞이지 않는다).

### Paper 필드 매핑: `EmbeddingResult`가 4필드에 정확히 대응

- `Embedding.embed(title, abstract)`는 `{embedding: number[], embeddingModel: string, embeddingSource: string, embeddingSucceeded: boolean}`을 반환한다. 이는 002.md에서 확정된 `Paper`의 4개 임베딩 필드(`embedding`/`embeddingModel`/`embeddingSource`/`embeddingSucceeded`)와 이름까지 정확히 대응해서, 나중에 `CollectAndSave.run()`이 `Object.assign(paper, await embedding.embed(...))`로 바로 꽂을 수 있게 설계했다.
- 예전 프로젝트는 실패 원인을 `EmbeddingFailure{reason, detail, at}`로 Paper에 저장했지만, 이 저장소의 `Paper`는 `embeddingSucceeded: boolean` 하나뿐이라 그런 진단 필드가 없다(002.md에서 이미 확정, 재논의 안 함). 대신 실패 상세는 Paper에 저장하지 않고 `Notice`로만 사용자에게 알린다 — 논문마다 뜨면 스팸이 되므로, 배치당 최초 실패 시 1회 + 서킷브레이커 트립 시 1회로 제한한다.

### 서킷브레이커: Embedding 내부 소유 + 시간 기반 쿨다운(60초)으로 자동 회복

- 예전 프로젝트는 `CollectAndSave`에 해당하는 수집/재임베딩 "pass"마다 외부에서 새 `attempts` 객체를 만들어 넘겨주는 방식이었다. 이 저장소는 `CollectAndSave.run()`이 아직 스텁이라 그 패턴을 그대로 쓸 수 없다.
- 그래서 `Embedding`이 서킷브레이커 상태(`consecutiveFailures`, `breakerTrippedAt`)를 인스턴스 내부에 소유하고, 연속 3회(`FAILURE_LIMIT`) 실패하면 트립되어 이후 호출은 바로 폴백을 반환한다. 다만 트립 후 `BREAKER_COOLDOWN_MS`(60초)가 지나면 다음 `embed()` 호출에서 자동으로 한 번 더 시도한다. 이렇게 해야 "한 번 문제가 터지면 그 뒤로 영구히(오늘도 내일도) 모든 문서가 폴백만 받는" 상황을 피할 수 있다.
- `run()`이 나중에 구현되면 배치(pass) 시작 시 `resetCircuitBreaker()`를 호출해 즉시 초기화할 수도 있지만, 호출하지 않아도 쿨다운 덕분에 안전하게 동작한다.

### 메모리 관리: "연속 임베딩 시 메모리 부족" 문제를 명시적으로 검토

이번 설계 단계에서 "여러 문서를 연속으로 임베딩하면 메모리가 터져서, 이미 완료된 작업이 메모리를 차지해 이후 문서의 임베딩이 만들어지지 않는 문제가 생길 수 있는가"를 별도로 재검토했다. 결론: **이건 예전 `PaperGraph3D` 프로젝트가 실제로 겪고 원인까지 진단해 고쳐둔 버그**이며, 그 5단계 방어를 그대로 이식하기로 했다.

- **원인**: `WebAssembly.Memory`(WASM 힙)는 커지기만 하고 절대 줄어들지 않는다. `@huggingface/transformers`의 기본 파이프라인은 `padding: true`를 쓰는데 배치 크기 1(논문 한 편)에서는 "그 논문 자신의 길이만큼 패딩"이 되어, 논문마다 새로운 shape이 나온다. ONNX는 새 shape마다 새로 메모리를 할당하므로, 힙이 논문 수에 비례해 단조 증가하다가 100~200편 근처에서 할당 실패(OOM)로 죽는다. 실측 실패 지점이 고정된 논문 수가 아니라 초록 길이 분포에 따라 달랐다는 점이 순수 메모리 문제임을 뒷받침한다.
- **1차 방어 — 고정 길이 버킷 `[128, 256, 512]`**: 모든 입력을 이 3개 shape 중 하나로 강제 패딩(토큰 수를 먼저 잰 뒤 맞는 버킷으로 재토큰화). 코퍼스가 몇 편이든 힙이 겪는 shape은 3가지뿐이라 각 버킷의 첫 논문 이후로는 새 할당이 없는 정상 상태(steady state)에 도달한다. 패딩은 attention mask로 가려지고 CLS 토큰만 풀링하므로 결과 정확도 손해는 없다.
- **2차 방어 — `enableCpuMemArena: false`**: ORT의 메모리 아레나(해제된 블록을 재사용하려고 계속 들고 있는 구조)를 끈다. shape이 고정되면 재사용할 게 마땅히 없는데 이 구조 자체가 무한정 자라고 있었다.
- **3차 방어(가장 직접적인 답) — 세션을 64회 추론마다 강제 재생성**: 1·2차로도 ORT가 일부 상태를 누적하는 걸 완전히 막지는 못하므로, 실패 여부와 무관하게 주기적으로 `InferenceSession`을 버리고 새로 만들어 WASM 할당자에게 메모리를 돌려준다. 예전 프로젝트가 실측한 실패 지점(~88편)보다 낮은 64로 안전 마진을 뒀다. **"이미 완료된 작업이 메모리를 계속 차지해서 이후 문서가 안 되는" 상황에 대한 가장 직접적인 대응이 바로 이것**이다.
- **4차 방어 — 실패 시 새 세션으로 1회만 재시도**: 이미 고갈된 세션으로 재시도해봐야 회복되지 않으므로, 세션을 버리고 새로 만든 뒤 딱 한 번만 다시 시도한다.
- **5차 방어 — 서킷브레이커 + 60초 쿨다운**: 그래도 계속 실패하면(런타임 자체가 죽었을 가능성) 남은 문서마다 매번 세션을 재구성하며 헛돌지 않고 즉시 폴백으로 전환한다. 위에서 정한 쿨다운 덕분에 일정 시간 뒤 자동으로 회복을 재시도한다.
- **최후 보증**: 5단계가 전부 실패해도 `embed()`는 절대 throw하지 않고 baseline 해시 임베딩(FNV-1a 기반, 2048차원, 항상 계산 가능)을 반환한다. 즉 메모리 문제가 아무리 심해도 수집/저장 자체가 멈추거나 이후 문서가 통째로 스킵되는 일은 없다 — 그 문서들은 `embeddingSucceeded: false`로만 표시되고, 나중에 재임베딩(이번 범위 밖, 향후 기능으로 고려)으로 복구할 여지를 남긴다.

## 버그 수정 (2026-08-04, "테스트 (100개)" 버튼 작업 중 발견)

100편 연속 임베딩을 실제로 돌려보면서 발견해 고친 것 2건:

1. **`Embedding.specter2Embedding()`: 재시도 세션 미해제.** 첫 시도가 실패해 새 세션으로 한 번 더 재시도했는데 그 재시도마저 실패하면, 그 "재시도용" 세션이 `this.session`에 캐시된 채로 예외가 그대로 던져졌다. 실패한 세션이 즉시 해제되지 않고, 다음 `embed()` 호출이 또 실패해야만(그 안의 `resetPipeline()`이 실행돼야만) 정리되는 구조 — 무한정 쌓이는 누수는 아니지만 "실패 시 즉시 메모리 반납"이라는 5단계 방어 설계 의도에 어긋났다. 재시도마저 실패하면 그 자리에서 바로 `resetPipeline()`을 호출하도록 수정.
2. **`SettingTab.ts` 테스트 버튼: 문서 이중 저장.** 임베딩 전에 한 번, 후에 한 번 같은 문서를 저장하고 있었다. `.md`는 애초에 임베딩 벡터를 담지 않으므로(frontmatter에 안 들어감) 첫 저장은 무의미했고, 같은 sourceId로 재실행하면 "임베딩 전" 저장이 이전 실행의 정상 임베딩 결과를 일시적으로 빈 값으로 덮어썼다가 두 번째 저장에서야 복구하는 구조라, 그 사이 중단되면(Obsidian 종료 등) 이전에 잘 저장돼 있던 임베딩이 빈 값으로 남을 위험이 있었다. 임베딩 완료 후 한 번만 저장하도록 수정.

두 수정 모두 기존 mock-obsidian 기반 동작 테스트(21개) 재통과 확인 후 커밋(`46996fc`).

## 모델 교체 용이성 평가 (2026-08-04)

"이후 다른 개발자가 이 모델을 쉽게 다른 걸로 바꿀 수 있는가"를 판단해 기록해둔다. **결론: 상수 몇 개만 바꾸는 수준은 아니고, 부분적으로만 쉽다.**

**쉬운 부분:**
- 모델 식별 관련 상수(`RELEASE_OWNER`/`RELEASE_REPO`/`MODEL_RELEASE_TAG`/`MODEL_ID`/`MODEL_FILES`/`SPECTER2_EMBEDDING_MODEL`/`SPECTER2_EMBEDDING_DIM`/`dtype:'q8'`)가 전부 `Embedding.ts` 한 파일 상단에 모여 있다 — 다른 파일을 뒤질 필요는 없다.
- `Paper.embeddingModel`은 자유 문자열이라 어떤 모델 id를 넣든 스키마가 안 깨진다. 세션 관리/버킷팅/재시도/서킷브레이커/baseline 폴백 같은 범용 로직은 모델이 뭐든 그대로 재사용된다 — 이 부분은 이미 모델 비의존적으로 짜여 있다.

**쉽지 않은 부분:**
1. **재임베딩(마이그레이션) 경로가 아예 없다.** 모델을 바꾸면 이미 수집된 논문들의 `embeddingModel`이 새 canonical id와 안 맞게 되는데, 이걸 감지하거나 다시 임베딩해주는 코드가 지금 저장소엔 없다(정확히 이 기능이 이번 대화 초반에 설계까지 했다가 "당장은 specter2 하나로 고정" 결정으로 취소된 부분이다). 상수만 바꿔서 배포하면 기존 코퍼스는 조용히 옛 벡터를 낀 채로 방치된다 — 이게 가장 큰 구조적 공백이다.
2. **입력 포맷/풀링 전략이 SPECTER2 전용으로 하드코딩돼 있다.** `` `${title}[SEP]${abstract}` `` 포맷과 CLS 토큰(첫 768개 값) 풀링은 BERT류 인코더+SPECTER2 학습 방식을 전제한 것 — mean pooling을 쓰거나 다른 입력 템플릿이 필요한 모델로 바꾸면 상수 변경이 아니라 `embedOnce`/`specter2Embedding` 내부 로직을 실제로 고쳐야 한다.
3. **함수/상수 이름 자체가 "specter2"로 박혀 있다** (`specter2Embedding`, `SPECTER2_EMBEDDING_MODEL` 등). 값만 바꾸면 이름과 실제 내용이 어긋나므로, 제대로 하려면 리네임까지 같이 해야 한다 — 작지만 실수하기 쉬운 지점(호출부 여러 곳).
4. **`SPECTER2_EMBEDDING_DIM` assert가 안전장치이자 함정이다.** `embedOnce`가 `hiddenSize !== SPECTER2_EMBEDDING_DIM`이면 throw하므로 차원이 다른 새 모델을 넣고 이 상수를 안 바꾸면 명확한 에러 대신 **매 논문이 조용히 baseline 폴백으로 빠지고 Notice 하나만 뜬다** — 놓치기 쉬운 실패 모드.
5. **모델 변환 파이프라인이 재현 가능한 스크립트로 저장소에 없다.** 위 "모델 배포" 절에 적었듯 이번에 쓴 변환 절차는 스크래치패드에서 실행하고 버렸다 — 다음 모델 교체 때 이 문서를 보고 처음부터 다시 짜야 한다.

**요약**: "어떤 모델을 쓸지" 자체를 바꾸는 건(상수 몇 개 + 로직 일부) 몇 시간짜리 작업이지만, "바꾼 뒤 기존 코퍼스를 정합성 있게 유지하는" 재임베딩 기능이 없다는 게 진짜 병목이다. 나중에 모델을 다시 바꿀 계획이 생기면, 이번에 취소했던 provider 전환+재임베딩 설계(대화 로그에 남아있음)를 다시 꺼내 구현하는 게 순서상 맞다.

### 리팩터링 (2026-08-04): 이름/구조를 모델 비의존적으로 정리

위 "쉽지 않은 부분" 2·3·4번(입력/풀링 하드코딩, specter2가 박힌 이름, 조용한 차원 불일치)을 코드 구조로 완화했다. **런타임 provider 전환 기능은 여전히 만들지 않았다** — specter2 하나만 고정 실행하는 건 그대로고, 이번엔 순수 이름/구조 정리다.

- **이름 변경**: `SPECTER2_EMBEDDING_MODEL`→`LOCAL_MODEL_EMBEDDING_ID`, `SPECTER2_EMBEDDING_DIM`→`LOCAL_MODEL_DIM`, `MODEL_ID`→`LOCAL_MODEL_FOLDER_NAME`, `specter2Embedding()`→`runLocalModel()`. 새 상수 `LOCAL_MODEL_DTYPE`('q8')도 인라인이던 `dtype:'q8'`을 명시적 상수로 뺐다.
- **`buildModelInput(title, abstract)` / `poolEmbedding(hidden)` 분리**: 각각 `[SEP]` 입력 포맷, CLS 풀링 로직을 이름 붙은 private 메서드로 뽑았다. 다른 모델로 교체할 때 정확히 이 두 함수만 보면 된다.
- **차원 불일치 에러 메시지 명확화**: `poolEmbedding()`이 `hiddenSize !== LOCAL_MODEL_DIM`이면 "LOCAL_MODEL_DIM 설정과 실제 모델 출력이 다릅니다. 모델을 교체했다면 이 상수도 함께 갱신해야 합니다"라고 명시한다. 여전히 baseline 폴백 + 서킷브레이커를 거치는 흐름 자체는 그대로다(런타임 장애와 구분되는 문구가 붙었을 뿐).
- **상수 섹션 병합**: 기존 "GitHub Release/에셋 레이아웃"과 "SPECTER2" 두 섹션을 "로컬 모델 설정 — 다른 모델로 교체할 때 이 블록 전체를 같이 갱신할 것" 하나로 합쳤다.
- 리팩터링이라 동작은 안 바꿨다 — 기존 mock-obsidian 동작 테스트 21개가 이름 변경 없이 그대로 재통과(테스트는 `computeBaselineEmbedding`/서킷브레이커 필드/`embed()`만 참조하고 이번에 바뀐 이름은 안 씀).

### 로컬 모델 교체 조건 (2026-08-04)

다른 로컬 모델로 바꾸려는 개발자가 지켜야 하는 조건. 하나라도 안 맞으면 다운로드는 성공해도 로드/추론이 실패해 baseline 폴백으로 조용히 빠질 수 있다.

1. **HF 포맷 필수**: `@huggingface/transformers`의 `AutoTokenizer`/`AutoModel.from_pretrained`로 로드 가능해야 한다 — `config.json`/`tokenizer.json`/`tokenizer_config.json`/`special_tokens_map.json` + ONNX 가중치 파일 세트를 GitHub Release(또는 `releaseAssetUrl`이 가리키는 곳)에 flat 이름으로 올려야 한다.
2. **인코더 전용, `[batch, sequence, hidden]` 출력 가정**: `last_hidden_state`를 반환하는 BERT류 인코더만 지금 구조 그대로 교체 가능하다. 인코더-디코더/디코더 전용 모델은 `runLocalModel`/`embedOnce` 자체를 다시 짜야 한다.
3. **입력 포맷·풀링 전략이 다르면 `buildModelInput()`/`poolEmbedding()`만 고치면 된다** — SPECTER2 전용 가정(`[SEP]` 결합, CLS 풀링)이 이 두 함수에만 들어있다.
4. **`LOCAL_MODEL_DIM`·`LOCAL_MODEL_DTYPE`·`MODEL_FILES`의 양자화 파일명 세트를 함께 갱신해야 한다.** 차원 불일치는 이제 명확한 에러 메시지로 구분되지만, dtype/파일명이 서로 안 맞는 경우(예: `LOCAL_MODEL_DTYPE`은 `'q8'`인데 실제로는 fp16 파일을 올린 경우)는 여전히 일반 실패로만 나타난다 — 이번 리팩터링 범위 밖.
5. **재임베딩 경로는 여전히 없다.** 위 "모델 교체 용이성 평가"에서 이미 지적한 대로, 모델을 바꿔도 기존 코퍼스는 자동으로도 수동으로도 마이그레이션되지 않는다 — 이건 이름/구조 리팩터링으로 해결되는 문제가 아니라 별도 기능(취소된 provider 전환+재임베딩 설계)이 필요하다.

## 2026-08-05 변경: baseline 폴백 제거 — 모델 없으면 임베딩 진행 안 함

기존 설계는 모델이 설치 안 됐거나 추론이 실패하면 해시 기반 baseline(FNV-1a TF, 2048차원,
`local-hashtf-v1-d2048`)으로 조용히 폴백해서 `embed()`가 절대 throw하지 않도록 했다. 사용자
요구로 이 설계를 뒤집었다: **가짜 벡터가 실제 임베딩 공간(SPECTER2, 768차원)과 뒤섞여
저장되는 것 자체를 막아야 하므로, baseline은 코드에서 완전히 제거하고 모델이 없으면
임베딩이 아예 진행되지 않아야 한다.**

- **`Embedding.embed()`는 이제 항상 throw로 실패를 알린다.** 모델 미설치, 서킷브레이커
  쿨다운 중, 추론 실패(재시도까지 실패) 세 경우 모두 baseline을 계산하는 대신 `Error`를
  던진다. `computeBaselineEmbedding()`/`tokenize()`/`fnv1a()`와 `BASELINE_EMBEDDING_DIM`/
  `BASELINE_EMBEDDING_MODEL` 상수는 전부 삭제했다.
- **`EmbeddingResult`는 이제 항상 성공만 표현한다** — `embed()`가 정상 반환하면
  `embeddingSucceeded`는 항상 `true`다(기존에도 `runLocalModel()`은 항상 `true`를 세팅했고,
  `false`는 baseline 경로에서만 나왔다).
- **"임베딩 실패를 Paper에 어떻게 반영할지"는 Embedding 클래스가 아니라 호출자(수집
  플로우) 책임으로 옮겼다.** `Paper.embeddingSucceeded`/`embeddingSource` 필드 자체는
  스키마에서 제거하지 않았다(schemaVersion 변경 없음) — 다만 값을 채우는 주체가 바뀌었을
  뿐이다. 실패 시 호출자는 `embed()`가 던진 에러를 catch해서 (a) 그 논문의 저장을
  건너뛰거나 (b) `embedding=[]`, `embeddingModel=''`, `embeddingSource=''`,
  `embeddingSucceeded=false`로 명시적으로 채워 저장하는 두 선택지 중 골라야 한다. 이건
  `FileTestModal.ts`가 이미 쓰던 "빈 값으로 직접 채우는" 패턴과 같다 — 새로운 개념이
  아니라 Embedding 클래스가 대신 해주던 걸 호출자로 옮긴 것뿐이다.
- **`SettingTab.ts`의 "테스트 (100개)" 버튼에 반영 완료 (선택지 (b) 채택, 2026-08-05
  중간에 (a)→(b)로 정정)**: 처음엔 클릭 전 `isModelInstalled()`로 게이팅하고 개별 실패는
  저장을 건너뛰는(a) 방식으로 구현했으나, 두 가지 이유로 최종적으로 (b)로 바꿨다.
  1. 사전 게이팅을 없애 모델이 없어도 루프를 실제로 돌려 `embed()`가 진짜 throw하고
     그 자리의 `try/catch`가 이를 실제로 catch하는지 눈으로 확인할 수 있게 했다(처음 실패
     시에만 실제 에러 메시지를 Notice로 띄움 — 스팸 방지).
  2. 실패한 논문을 저장 자체에서 빼면(스킵) "이 논문이 임베딩에 실패했다"는 사실이 어디에도
     안 남는다. 대신 `buildMockPaper()`가 미리 채워둔 빈 값(`embedding=[]`,
     `embeddingModel=''`, `embeddingSource=''`, `embeddingSucceeded=false`)을 그대로
     `File.writeTestPaper`로 저장한다 — 가짜 벡터(baseline)는 여전히 만들지 않지만, 실패
     사실 자체는 디스크에 명시적으로 남아 나중에 재임베딩 대상을 찾을 수 있다. 이건
     `FileTestModal.ts`가 이미 쓰던 "빈 값으로 직접 채우는" 패턴과 동일하다.
- **`CollectAndSave.run()`은 여전히 스텁이라 동작 변경은 없지만**, 실제 구현 시에도 이
  원칙(baseline 계산 금지, 위 (a)/(b) 중 선택 — `SettingTab`은 (b) 채택)을 지켜야 한다.
- **재임베딩 경로는 여전히 없다.** `embeddingSucceeded=false` + `embedding=[]`로 저장된
  논문을 감지해 모델이 다시 정상화됐을 때 자동/수동으로 재시도해주는 기능은 아직 없다
  (위 "모델 교체 용이성 평가"에서 지적한 공백과 같은 종류) — 다음 우선순위 후보로 남겨둔다.
- 저장소에 `Embedding` 관련 자동 테스트가 없어(확인함) 이번 변경은 다음으로 확인했다:
  빌드/lint 통과, 그리고 실제 Obsidian 없이 `obsidian` 모듈만 최소 mock(Notice/Vault/
  DataAdapter)으로 갈아끼운 일회성 Node 스크립트로 `src/collect/Embedding.ts`와
  `src/common/File.ts`를 그대로 실행 — 모델 미설치 상태에서 `embed()`가 실제로 throw하고,
  `SettingTab.ts`와 동일한 catch 경로를 거쳐 `embedding=[]`/`embeddingModel=''`/
  `embeddingSource=''`/`embeddingSucceeded=false`가 저장된 JSON에 실제로 기록됨을 확인했다
  (스크립트는 일회성이라 커밋하지 않고 검증 후 삭제). Obsidian 앱을 직접 열어 UI를 수동
  클릭하는 검증은 하지 않았다.

## 2026-08-06 분석: 모델 교체 시 에러 캐치/embeddingSucceeded 견고성 검토

baseline 폴백을 제거한 뒤(위 "2026-08-05 변경"), "이 throw/catch 구조가 로컬 모델을
다른 걸로 바꿔도 여전히 올바르게 동작하는가"를 별도로 점검했다. 결론: **throw/catch
메커니즘 자체(서킷브레이커, `embeddingSucceeded` 세팅)는 완전히 모델 비의존적이라 어떤
모델로 바꿔도 구조가 깨지지 않는다.** 다만 "기술적 실패"만 잡아낼 수 있고 "실행은
성공했지만 메타데이터/의미가 틀린" 경우는 애초에 이 메커니즘의 설계 범위 밖이다 — 이건
이번 점검에서 새로 생긴 문제가 아니라 위 "모델 교체 용이성 평가"/"로컬 모델 교체 조건"이
이미 전제하고 있던 한계다.

### 모델을 바꿔도 여전히 캐치되는 실패들

- **모델 에셋 미설치/일부만 설치** → `ensureModelLocation()`이 `undefined` → `embed()`가
  throw. `MODEL_FILES`/`WASM_FILE` 상수만 새 모델에 맞게 갱신했다면 모델 종류 무관하게
  동작한다.
- **`AutoModel.from_pretrained` 로드 자체 실패**(포맷/dtype 문제) → `createSession()`의
  throw가 `runLocalModel()`의 재시도 로직을 거치지 않고 곧장 `embed()`의 바깥
  `try/catch`로 전파되어 결국 잡힌다 — 재시도를 안 거치는 게 오히려 맞다(결정론적 설정
  오류는 세션을 새로 만들어봐야 다시 실패하므로).
- **hidden 차원이 `LOCAL_MODEL_DIM`과 다름** → `poolEmbedding()`이 명시적 에러로 throw →
  `embedOnce` 1회 재시도 후에도 실패하면 `embed()`까지 전파된다. 단, 이 케이스는 재시도
  때문에 실패한 논문 1편당 세션을 두 번(원래 세션 + 재시도용 새 세션) 만드는 비용이
  든다 — 지속적인 설정 오류라면 3회 연속 실패 후 서킷브레이커가 트립되어 그 이후엔 이
  비용도 사라진다.
- **추론 결과가 NaN/Infinity를 포함** → `Number.isFinite` 체크가 모델 무관하게 걸러낸다.
- 위 어떤 경우든 **`embeddingSucceeded`가 실수로 `true`가 되는 경로는 없다** —
  `runLocalModel()`이 성공적으로 리턴할 때만 하드코딩된 `true`를 반환하고, 그 외에는 전부
  throw이기 때문이다(baseline이 없으므로 "성공도 실패도 아닌 애매한 값"이 애초에 나올 수
  없다).

### 모델을 바꿔도 캐치되지 않는 것 (설계상 원래 못 잡는 범위)

이건 코드가 놓친 버그가 아니라 "런타임 기술적 실패"만 감지하도록 설계된 구조라서 원천적으로
못 잡는다. 모델을 교체하는 담당자가 위 "로컬 모델 교체 조건"을 수동으로 지켜야 하는
이유다.

1. **`LOCAL_MODEL_EMBEDDING_ID`를 새 모델에 맞게 안 바꾼 경우**: 추론 자체는 에러 없이
   성공하므로 `embeddingSucceeded: true`로 정상 저장되지만, `embeddingModel` 필드엔 옛
   모델의 canonical id가 그대로 찍힌다. 코드에 "이 문자열이 실제로 방금 돌린 모델과
   일치하는가"를 검증하는 로직이 없다 — 순수 문자열 상수라 실제 모델 신원과 대조할 방법이
   없다.
2. **입력 포맷/풀링 전략이 다른데 `buildModelInput()`/`poolEmbedding()`을 안 고친 경우**:
   차원이 우연히 같으면(예: 다른 768차원 BERT류) 에러 없이 완주하지만 벡터가 의미적으로
   다른 공간의 것이 된다. `isFinite` 체크는 값이 유한하기만 하면 통과시키므로 이것도 못
   잡는다.
3. **`LOCAL_MODEL_DTYPE`이 실제 업로드된 가중치 양자화 방식과 안 맞는 경우**: 위 "로컬
   모델 교체 조건" 4번에서 이미 지적한 대로 "일반 실패로만 나타난다" — `createSession()`
   로드 단계에서 대체로 뭔가는 throw해 결국 캐치되긴 하지만, 에러 메시지가 원인(dtype
   불일치)을 정확히 짚어주지는 않는다.

### 시사점

baseline 제거 작업의 목표("가짜 벡터가 저장되지 않게 하기")는 모델을 바꿔도 안전하게
유지된다 — 위 1·2번 케이스도 "가짜 벡터"가 아니라 "진짜 벡터인데 메타데이터/의미가 잘못
붙은" 경우라 별개 문제다. 이 잔여 리스크를 코드로 막으려면 별도 장치(예: canonical id를
모델 파일 해시나 `config.json` 내용과 연동해 자동 검증, 혹은 알려진 두 논문 쌍의 유사도를
확인하는 스모크 테스트 등)가 필요한데, 이번 범위 밖이며 향후 개선 과제로 남긴다.

## 2026-08-06 수정: non-finite 체크가 재시도/세션 반납 경로를 안 타던 버그

메모리 관리 점검 중 발견: `runLocalModel()`에서 `embedOnce()`가 반환한 임베딩의
non-finite(NaN/Infinity) 검사가 재시도용 `try/catch` **바깥**에 있었다. 그 결과 이
검사에 걸려 throw될 때는 (a) 이미 `uses`가 증가한 세션이 `resetPipeline()`으로
반납되지 않고 캐시에 그대로 남고, (b) 4차 방어(새 세션으로 1회 재시도)도 적용되지
않았다 — "실패 시 즉시 반납" 원칙(위 "버그 수정 (2026-08-04)" 절에서 이미 한 번
고친 것과 같은 종류) 위반. non-finite 체크를 `embedOnce()` 내부로 옮겨 다른 추론
실패와 동일하게 재시도+세션 반납 경로를 타도록 수정했다(커밋 `342c934`).

검증: 저장소에 committed 테스트가 없어(기존 관례대로) `@huggingface/transformers`를
쓰지 않고 `createSession()`만 교체한 일회성 Node 스크립트로 두 시나리오를 확인—
(1) 첫 시도만 non-finite → 그 세션이 `dispose()`되고 새 세션으로 재시도해 성공,
(2) 두 시도 모두 non-finite → 두 세션 모두 `dispose()`되고 에러가 전파됨. 둘 다
통과 후 스크립트는 삭제(커밋 안 함). 이후 `tsc -noEmit`/`eslint` 통과 확인.

## 동시성 가정: `embed()`는 순차 호출만 안전함 (2026-08-06 점검, 코드 변경 없음)

메모리 관리 점검 중, `Embedding`이 `session`/`consecutiveFailures`/
`breakerTrippedAt`/`modelLocationChecked`·`modelLocation`을 락 없는 인스턴스
상태로 관리한다는 점을 재확인했다. `CollectAndSave.run()`이 아직 스텁이고
현재 유일한 실사용처(`SettingTab.ts`의 "테스트 (100개)" 버튼)도 `for` +
`await`로 순차 호출하므로 지금 당장 문제는 없지만, `run()`을 구현할 때 속도를
위해 `Promise.all` 등으로 병렬 호출하고 싶어질 수 있어 미리 점검해 기록해둔다.

- **레이스 1 (오늘도 재현 가능): `ensureModelLocation()`.** `modelLocationChecked`를
  디스크 확인(`await areAssetsPresent`)보다 먼저 동기적으로 `true`로 세팅한다.
  `embed()`를 동시에 두 번 부르면, 첫 호출이 디스크 확인 중일 때 두 번째 호출은
  `modelLocationChecked === true`만 보고 아직 `undefined`인 `modelLocation`을
  그대로 반환해 "모델 설치 안 됨"으로 오판하고 그 논문 하나를 잘못 실패 처리한다.
  이후 호출부턴 정상화되므로 자기치유되지만, 놓친 논문은 복구되지 않는다.
- **레이스 2 (더 심각할 수 있음): 세션 dispose 중 사용.** 호출 A가 실패해
  `resetPipeline()`으로 세션을 `dispose()`하는 동안, 호출 B가 같은 세션 객체로
  `session.model(inputs)`를 아직 await 중일 수 있다. 진행 중인 추론 아래에서
  세션이 해제되는 상황이라 ORT/WASM이 어떻게 반응할지 보장이 없다.
- **경미한 항목**: `uses` 카운터·서킷브레이커 카운터도 동시 호출 시 임계값을
  살짝 넘기거나 집계 순서가 뒤섞일 수 있지만 자체 회복되는 수준.

**결정**: 위 레이스를 막는 락/큐를 `Embedding` 내부에 추가하지 않기로 했다.
WASM 기반 단일 ONNX 세션은 JS 싱글스레드 위에서 어차피 동시 호출로 처리량이
늘지 않으므로(진짜 병렬 연산 이득이 없음), 지금 필요 없는 복잡도를 미리
추가하는 것보다 **`CollectAndSave.run()`이 논문을 순차(`for...of` + `await`)로만
처리한다는 계약을 문서(이 절 + `Embedding.embed()` 위 주석)로 못 박는 쪽**을
택했다. `run()`을 구현할 담당자는 이 제약을 지켜야 하며, 병렬 처리가 꼭
필요해지면 그때 가서 이 절을 다시 참고해 락/큐 도입을 재검토할 것.

## 다음 담당자 참고

- `CollectAndSave.run()`을 구현할 담당자는 `Embedding.embed(title, abstract)`를 루프 안에서 `try/catch`로 감싸 호출해야 한다 — 성공하면 `Object.assign(paper, result)`로 붙이고, 실패(throw)하면 위 "baseline 폴백 제거" 절의 (a)/(b) 중 하나를 선택해 처리한다(baseline 계산 금지). `resetCircuitBreaker()`는 배치 시작 시 호출하면 좋지만 필수는 아니다(쿨다운이 자동으로 처리).
- **`embed()`는 반드시 순차 호출할 것 — `Promise.all` 등으로 병렬 호출 금지.** 위 "동시성 가정" 절 참고. 논문마다 `for...of` + `await`로 하나씩 처리해야 한다(속도를 위해 병렬화하고 싶어져도 세션 상태 레이스가 있어 안전하지 않다).
- `installModel()`이 실패한다면 **더 이상 "릴리스에 에셋이 안 올라가 있어서"가 아니다** — 실제로 업로드·검증까지 끝났다(위 "모델 배포" 절 참고). 실패한다면 네트워크, Obsidian CSP, wasm 로딩 등 다른 원인을 봐야 한다.
- `isDesktopOnly: true`는 팀 전체 영향 결정이므로, 모바일 지원 논의가 다시 나오면 이 문서를 먼저 참고할 것.
- 모델을 다른 것으로 바꾸고 싶다면 위 "모델 교체 용이성 평가" + "로컬 모델 교체 조건" 절을 먼저 읽을 것 — 손댈 지점은 `buildModelInput()`/`poolEmbedding()`/"로컬 모델 설정" 상수 블록 셋으로 좁혀뒀지만, 재임베딩 경로가 없다는 점은 여전하다.
- 교체 후 "에러 없이 잘 도는데 결과가 이상하다"면 위 "2026-08-06 분석" 절의 "캐치되지 않는 것" 3가지(canonical id 갱신 누락 / 입력·풀링 전략 안 맞음 / dtype 불일치)부터 의심할 것 — 이들은 코드가 감지하지 못하고 `embeddingSucceeded: true`로 조용히 저장된다.
