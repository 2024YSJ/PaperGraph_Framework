import { Notice, requestUrl, type DataAdapter, type Vault } from 'obsidian';

// 온디바이스 로컬 모델(현재 설정: SPECTER2, 8bit 양자화) 임베딩. 설계 근거는
// docs/devLog/003-embedding-model.md 참고 — 모델 파일은 번들에 넣지 않고 GitHub
// Release에서 사용자가 설치 버튼으로만 받는다. 모델이 설치되어 있지 않거나 추론이
// 실패하면 embed()는 항상 throw한다 — 가짜 벡터(해시 기반 baseline)를 계산해 실제
// 임베딩 공간과 섞어 저장하지 않는다(2026-08-05 결정). 실패 시 Paper를 어떻게 채울지
// (저장을 건너뛸지, embedding=[] + embeddingSucceeded=false로 명시적으로 채울지)는
// 호출자(수집 플로우) 책임이다.
//
// 다른 로컬 모델로 교체하려면: 아래 "로컬 모델 설정" 상수 블록 + buildModelInput()
// (입력 포맷) + poolEmbedding()(풀링 전략) 세 곳만 보면 된다. 교체 조건은
// docs/devLog/003-embedding-model.md의 "로컬 모델 교체 조건" 절 참고.

export interface AssetProgress {
	readonly fileIndex: number;
	readonly fileCount: number;
	readonly fileName: string;
	readonly bytesWritten: number;
}

// Paper의 4개 embedding 필드와 이름을 맞춰서, CollectAndSave.run()에서
// Object.assign(paper, await embedding.embed(title, abstract))로 바로 꽂을 수 있게 한다.
export interface EmbeddingResult {
	embedding: number[];
	embeddingModel: string;
	embeddingSource: string;
	embeddingSucceeded: boolean;
}

interface AssetPaths {
	readonly modelsDir: string;
	readonly wasmDir: string;
	readonly modelDir: string;
}

interface LocalModelLocation {
	readonly modelsBaseUrl: string;
	readWasmBinary(): Promise<ArrayBuffer>;
}

// @huggingface/transformers의 공개 타입은 태스크/아키텍처별 제네릭이라 인스턴스화하면
// TS가 표현 못 하는 union이 나온다. 실제로 호출하는 부분만 좁혀서 캐스팅한다.
interface Tensor {
	readonly dims: readonly number[];
	readonly data: ArrayLike<number>;
}

interface Encoded {
	readonly input_ids: Tensor;
	readonly attention_mask: Tensor;
}

interface TokenizeOptions {
	readonly padding: boolean | 'max_length';
	readonly truncation: boolean;
	readonly max_length: number;
}

type Tokenizer = (text: string, options: TokenizeOptions) => Encoded;

interface Model {
	(inputs: Encoded): Promise<{ last_hidden_state: Tensor }>;
	dispose(): Promise<void>;
}

interface AutoFactory<T> {
	from_pretrained(model: string, options?: Record<string, unknown>): Promise<T>;
}

interface Session {
	readonly tokenizer: Tokenizer;
	readonly model: Model;
	/** 이 세션이 처리한 추론 수. INFERENCES_PER_SESSION과 비교해 재생성 여부 결정. */
	uses: number;
}

export class Embedding {
	// ── 상태 ──────────────────────────────────────────────────────────
	private vault!: Vault;
	private pluginDir = '';
	private modelLocation?: LocalModelLocation;
	private modelLocationChecked = false;
	private session?: Session;
	private consecutiveFailures = 0;
	private breakerTrippedAt?: number;

	// ═══ 로컬 모델 설정 — 다른 모델로 교체할 때 이 블록 전체를 같이 갱신할 것 ═══
	// 파일명·차원·dtype·canonical id가 서로 어긋나면 다운로드는 성공해도 로드/추론이
	// 실패해 embed()가 throw한다 (docs/devLog/003-embedding-model.md
	// "로컬 모델 교체 조건" 참고).
	private static readonly RELEASE_OWNER = '2024YSJ';
	private static readonly RELEASE_REPO = 'PaperGraph_Framework';
	private static readonly MODEL_RELEASE_TAG = 'model-specter2-q8-v1';
	private static readonly WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
	private static readonly MODELS_SUBDIR = 'models';
	private static readonly WASM_SUBDIR = 'wasm';
	// transformers.js AutoTokenizer/AutoModel.from_pretrained에 넘기는 로드 식별자
	// (= 로컬 저장 시 모델 폴더명). Paper.embeddingModel에 쓰는 canonical id와는 다른
	// 문자열이다 — 이건 "어디서 로드하는가", canonical id는 "어떤 임베딩 공간인가".
	private static readonly LOCAL_MODEL_FOLDER_NAME = 'specter2-proximity-onnx';
	// GitHub Release의 model_quantized.onnx(8bit 양자화)에 대응. MODEL_FILES의
	// 양자화 가중치 파일명과 반드시 같은 양자화 방식을 가리켜야 한다.
	private static readonly LOCAL_MODEL_DTYPE = 'q8';
	// tokenizer.json은 필수 — transformers.js에 vocab.txt 로더가 없다.
	private static readonly MODEL_FILES = [
		'config.json',
		'tokenizer.json',
		'tokenizer_config.json',
		'special_tokens_map.json',
		'onnx/model_quantized.onnx',
	] as const;
	// Paper.embeddingModel에 저장하는 canonical id — 코퍼스 전체가 공유하는 임베딩
	// 공간의 식별자. 모델을 바꾸면 반드시 함께 바꿔야 한다(안 바꾸면 새 모델 결과가
	// 옛 공간의 벡터인 척 저장된다).
	private static readonly LOCAL_MODEL_EMBEDDING_ID = 'local-specter2-proximity-v1-d768';
	// 기대 hidden 차원. poolEmbedding()이 실제 모델 출력과 이 값을 대조해서, 다르면
	// "런타임 장애"가 아니라 "이 상수를 안 갱신한 설정 실수"라고 알 수 있는 에러를 낸다.
	private static readonly LOCAL_MODEL_DIM = 768;

	// ── 상수: 세션/메모리 관리 — 모델 비의존적 ─────────────────────────────
	private static readonly MAX_SEQUENCE_LENGTH = 512;
	// 고정 길이 버킷 — WASM 힙이 절대 줄어들지 않아 매 논문마다 새 shape을 주면
	// 100~200편 근처에서 OOM 나던 문제의 근본 수정 (003-embedding-model.md 1차 방어).
	private static readonly LENGTH_BUCKETS = [128, 256, 512] as const;
	// 실패 여부와 무관하게 이 횟수마다 세션을 강제로 버리고 새로 만들어 WASM 할당자에게
	// 메모리를 돌려준다 (3차 방어 — "완료된 작업이 메모리를 계속 차지하는" 문제의 핵심 대응).
	private static readonly INFERENCES_PER_SESSION = 64;

	// ── 상수: 서킷브레이커 (5차 방어) — 모델 비의존적 ───────────────────────
	private static readonly FAILURE_LIMIT = 3;
	private static readonly BREAKER_COOLDOWN_MS = 60_000;

	private static readonly OUT_OF_MEMORY_PATTERNS = [
		'out of memory',
		'could not allocate memory',
		'cannot enlarge memory',
		'failed to allocate',
		'memory access out of bounds',
		'array buffer allocation failed',
		'aborted(',
	];

	// ── 초기화 / 경로 ─────────────────────────────────────────────────

	// 동기 + I/O 없음: PaperGraph3D.init()이 동기 함수라 여기서 무거운 작업을 시작하면
	// 안 된다. 모델 위치 확인은 isModelInstalled()/embed() 최초 호출 시점에 지연 계산한다.
	init(vault: Vault, pluginDir: string): void {
		this.vault = vault;
		this.pluginDir = pluginDir;
	}

	private assetPaths(): AssetPaths | undefined {
		if (this.pluginDir.length === 0) {
			return undefined;
		}
		const modelsDir = `${this.pluginDir}/${Embedding.MODELS_SUBDIR}`;
		return {
			modelsDir,
			wasmDir: `${this.pluginDir}/${Embedding.WASM_SUBDIR}`,
			modelDir: `${modelsDir}/${Embedding.LOCAL_MODEL_FOLDER_NAME}`,
		};
	}

	// getResourcePath가 붙이는 캐시 무효화용 쿼리 스트링을 제거한다 — transformers.js가
	// 이 base 뒤에 파일명을 이어붙이므로 쿼리 스트링이 중간에 끼면 안 된다.
	private resourceBaseUrl(dir: string): string {
		const url = this.vault.adapter.getResourcePath(dir);
		const query = url.indexOf('?');
		return query === -1 ? url : url.slice(0, query);
	}

	// 모델 위치를 지연 계산 + 캐시(최초 1회만 디스크 확인). installModel() 성공 시에만
	// 캐시를 무효화한다.
	private async ensureModelLocation(): Promise<LocalModelLocation | undefined> {
		if (this.modelLocationChecked) {
			return this.modelLocation;
		}
		this.modelLocationChecked = true;
		const paths = this.assetPaths();
		if (paths === undefined || !(await this.areAssetsPresent(paths))) {
			this.modelLocation = undefined;
			return undefined;
		}
		this.modelLocation = {
			modelsBaseUrl: this.resourceBaseUrl(paths.modelsDir),
			readWasmBinary: () =>
				this.vault.adapter.readBinary(`${paths.wasmDir}/${Embedding.WASM_FILE}`),
		};
		return this.modelLocation;
	}

	// ── GitHub Release 에셋 ───────────────────────────────────────────

	async isModelInstalled(): Promise<boolean> {
		const paths = this.assetPaths();
		if (paths === undefined) {
			return false;
		}
		return this.areAssetsPresent(paths);
	}

	// 모든 필수 파일이 있어야 true — 반쯤 받은 상태가 "설치됨"으로 보이면 안 된다.
	private async areAssetsPresent(paths: AssetPaths): Promise<boolean> {
		const adapter = this.vault.adapter;
		const required = [
			...Embedding.MODEL_FILES.map((file) => `${paths.modelDir}/${file}`),
			`${paths.wasmDir}/${Embedding.WASM_FILE}`,
		];
		for (const path of required) {
			if (!(await adapter.exists(path))) {
				return false;
			}
		}
		return true;
	}

	async installModel(onProgress?: (progress: AssetProgress) => void): Promise<void> {
		const paths = this.assetPaths();
		if (paths === undefined) {
			throw new Error('플러그인 폴더를 찾을 수 없습니다.');
		}
		const adapter = this.vault.adapter;

		const jobs: { url: string; dest: string; name: string }[] = [
			...Embedding.MODEL_FILES.map((file) => ({
				url: Embedding.releaseAssetUrl(Embedding.basename(file)),
				dest: `${paths.modelDir}/${file}`,
				name: file,
			})),
			{
				url: Embedding.releaseAssetUrl(Embedding.WASM_FILE),
				dest: `${paths.wasmDir}/${Embedding.WASM_FILE}`,
				name: Embedding.WASM_FILE,
			},
		];

		await Embedding.ensureDir(adapter, paths.modelsDir);
		await Embedding.ensureDir(adapter, paths.modelDir);
		await Embedding.ensureDir(adapter, `${paths.modelDir}/onnx`);
		await Embedding.ensureDir(adapter, paths.wasmDir);

		try {
			let index = 0;
			for (const job of jobs) {
				index += 1;
				const bytesWritten = await Embedding.fetchTo(adapter, job.url, job.dest);
				onProgress?.({ fileIndex: index, fileCount: jobs.length, fileName: job.name, bytesWritten });
			}
		} catch (error) {
			// 실패한 채로 남으면 반쯤 받은 파일이 "설치됨"처럼 보일 수 있으니 정리한다.
			await this.removeAssets(paths).catch(() => undefined);
			throw error;
		}

		// 방금 설치했으니 캐시를 버리고 즉시 다시 확인 — 바로 다음 embed() 호출부터
		// 재시작 없이 새 모델을 쓸 수 있게 한다.
		await this.resetPipeline();
		this.modelLocationChecked = false;
		this.modelLocation = undefined;
		await this.ensureModelLocation();
	}

	private async removeAssets(paths: AssetPaths): Promise<void> {
		const adapter = this.vault.adapter;
		for (const dir of [paths.modelsDir, paths.wasmDir]) {
			if (await adapter.exists(dir)) {
				await adapter.rmdir(dir, true);
			}
		}
	}

	private static releaseAssetUrl(assetName: string): string {
		return `https://github.com/${Embedding.RELEASE_OWNER}/${Embedding.RELEASE_REPO}/releases/download/${Embedding.MODEL_RELEASE_TAG}/${assetName}`;
	}

	// GitHub Release 에셋 이름은 flat해야 해서 'onnx/model_quantized.onnx'의 URL은
	// basename만 쓴다. 로컬 저장 경로만 'onnx/' 하위 구조를 유지한다.
	private static basename(file: string): string {
		return file.slice(file.lastIndexOf('/') + 1);
	}

	private static async ensureDir(adapter: DataAdapter, dir: string): Promise<void> {
		if (!(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}
	}

	// requestUrl은 Obsidian 메인 프로세스에서 실행돼 CORS를 우회한다. .part로 받은 뒤
	// rename해야 중간에 실패해도 "설치됨"으로 오인되는 반쯤 받은 파일이 안 남는다.
	private static async fetchTo(adapter: DataAdapter, url: string, dest: string): Promise<number> {
		const response = await requestUrl({ url, method: 'GET', throw: false });
		if (response.status !== 200) {
			throw new Error(`${url} -> HTTP ${response.status}`);
		}
		const bytes = response.arrayBuffer;
		const temp = `${dest}.part`;
		await adapter.writeBinary(temp, bytes);
		if (await adapter.exists(dest)) {
			await adapter.remove(dest);
		}
		await adapter.rename(temp, dest);
		return bytes.byteLength;
	}

	// ── 벡터 유틸 ────────────────────────────────────────────────────────

	private static l2Normalize(vector: number[]): number[] {
		let sumOfSquares = 0;
		for (const value of vector) {
			sumOfSquares += value * value;
		}
		const norm = Math.sqrt(sumOfSquares);
		return norm === 0 ? vector : vector.map((value) => value / norm);
	}

	// ── 로컬 모델 입력/출력 변환 — 모델을 교체하면 이 두 함수만 고치면 된다 ─────

	// SPECTER2 학습 포맷 가정: title + 리터럴 '[SEP]' + abstract. 초록이 없으면
	// title만 쓴다. 다른 아키텍처/학습 포맷의 모델로 교체한다면 이 함수만 고치면 된다
	// (공백으로 이어붙이는 등 학습 형식과 다르게 포맷하면 품질이 떨어진다).
	private buildModelInput(title: string, abstract: string): string {
		return abstract.length > 0 ? `${title}[SEP]${abstract}` : title;
	}

	// CLS(첫 토큰) 풀링 가정 — [batch, sequence, hidden]에서 batch=1이므로 CLS는
	// last_hidden_state 버퍼 앞 LOCAL_MODEL_DIM개. mean-pooling 등 다른 전략의
	// 모델로 교체한다면 이 함수만 고치면 된다.
	private poolEmbedding(hidden: Tensor): number[] {
		const hiddenSize = hidden.dims[2] ?? 0;
		if (hiddenSize !== Embedding.LOCAL_MODEL_DIM) {
			// 차원이 다르면 "런타임 장애"가 아니라 "모델을 교체하고 이 상수를 안 바꾼
			// 설정 실수"일 가능성이 훨씬 크다 — 메시지로 구분되게 한다.
			throw new Error(
				`LOCAL_MODEL_DIM 설정(${Embedding.LOCAL_MODEL_DIM})과 실제 모델 출력(${hiddenSize})이 ` +
					`다릅니다. 모델을 교체했다면 이 상수도 함께 갱신해야 합니다.`,
			);
		}
		const cls = new Array<number>(Embedding.LOCAL_MODEL_DIM);
		for (let i = 0; i < Embedding.LOCAL_MODEL_DIM; i += 1) {
			cls[i] = Number(hidden.data[i] ?? Number.NaN);
		}
		return Embedding.l2Normalize(cls);
	}

	// ── ONNX 세션 관리 + 추론 — 모델 비의존적 ──────────────────────────────

	private async createSession(location: LocalModelLocation): Promise<Session> {
		const transformers = await import('@huggingface/transformers');

		// 로컬 전용 고정 — 에셋이 없으면 여기서 바로 실패해야지, 조용히 네트워크로 새는
		// 일이 있으면 안 된다 (AGENTS.md "로컬/오프라인 우선").
		transformers.env.allowLocalModels = true;
		transformers.env.allowRemoteModels = false;
		transformers.env.localModelPath = location.modelsBaseUrl;

		const wasm = transformers.env.backends.onnx.wasm;
		if (wasm === undefined) {
			throw new Error('onnxruntime WASM backend unavailable');
		}
		// wasmPaths를 비워두면 ORT가 번들에 내장된 글루 코드를 쓴다. 값을 남겨두면
		// 그 경로에서 글루를 동적 import하려 드는데, 이건 Obsidian CSP에 막힌다.
		wasm.wasmPaths = undefined;
		wasm.wasmBinary = await location.readWasmBinary();

		const autoTokenizer = transformers.AutoTokenizer as unknown as AutoFactory<Tokenizer>;
		const autoModel = transformers.AutoModel as unknown as AutoFactory<Model>;

		const tokenizer = await autoTokenizer.from_pretrained(Embedding.LOCAL_MODEL_FOLDER_NAME);
		const model = await autoModel.from_pretrained(Embedding.LOCAL_MODEL_FOLDER_NAME, {
			dtype: Embedding.LOCAL_MODEL_DTYPE,
			session_options: {
				// 고정 shape 3종류뿐이라 재사용할 게 없는데, 이 아레나 자체가 무한정
				// 자라는 구조였으므로 끈다 (003-embedding-model.md 2차 방어).
				enableCpuMemArena: false,
			},
		});

		return { tokenizer, model, uses: 0 };
	}

	private async getSession(location: LocalModelLocation): Promise<Session> {
		if (this.session === undefined) {
			this.session = await this.createSession(location);
		}
		return this.session;
	}

	// 캐시된 세션을 버려 WASM 힙의 할당을 되돌려준다. 세션이 없어도 안전하게 호출 가능.
	private async resetPipeline(): Promise<void> {
		const current = this.session;
		this.session = undefined;
		if (current === undefined) {
			return;
		}
		try {
			await current.model.dispose();
		} catch {
			// 세션이 애초에 못 떴거나 dispose 자체가 실패해도 참조는 이미 끊겼다.
		}
	}

	private static bucketFor(tokenCount: number): number {
		return (
			Embedding.LENGTH_BUCKETS.find((bucket) => tokenCount <= bucket) ??
			Embedding.MAX_SEQUENCE_LENGTH
		);
	}

	private async embedOnce(session: Session, text: string): Promise<number[]> {
		// 실제 토큰 수를 먼저 재고(패딩 없이) 맞는 버킷을 고른 뒤 그 길이로 재토큰화한다.
		// 두 번 토큰화하는 비용은 BERT forward pass에 비하면 무시할 수준이고, 이게
		// shape을 3가지로 고정하는 핵심이다.
		const measured = session.tokenizer(text, {
			padding: false,
			truncation: true,
			max_length: Embedding.MAX_SEQUENCE_LENGTH,
		});
		const tokenCount = measured.input_ids.dims[1] ?? Embedding.MAX_SEQUENCE_LENGTH;

		const inputs = session.tokenizer(text, {
			padding: 'max_length',
			truncation: true,
			max_length: Embedding.bucketFor(tokenCount),
		});

		const { last_hidden_state: hidden } = await session.model(inputs);
		session.uses += 1;

		const embedding = this.poolEmbedding(hidden);
		// 여기서 던져야 runLocalModel()의 재시도/세션 반납 로직을 그대로 탄다 — 이 체크가
		// try 블록 밖에 있으면 이미 uses가 증가한, 문제 있는 세션이 반납 없이 캐시에 남는다.
		if (embedding.some((value) => !Number.isFinite(value))) {
			throw new Error('로컬 모델이 non-finite 임베딩을 반환했습니다.');
		}
		return embedding;
	}

	private async runLocalModel(
		title: string,
		abstract: string,
		location: LocalModelLocation,
	): Promise<EmbeddingResult> {
		const text = this.buildModelInput(title, abstract);

		let session = await this.getSession(location);
		if (session.uses >= Embedding.INFERENCES_PER_SESSION) {
			await this.resetPipeline();
			session = await this.getSession(location);
		}

		let embedding: number[];
		try {
			embedding = await this.embedOnce(session, text);
		} catch {
			// 같은(이미 고갈됐을 수 있는) 세션으로 재시도해봐야 소용없으므로 새로 만들어
			// 딱 한 번만 다시 시도한다.
			await this.resetPipeline();
			const replacement = await this.getSession(location);
			try {
				embedding = await this.embedOnce(replacement, text);
			} catch (retryError) {
				// 재시도마저 실패하면 이 replacement 세션도 망가진 채로 남기지 않는다 —
				// 여기서 정리 안 하면 다음 embed() 호출이 또 실패할 때까지 캐시에 남아
				// WASM 메모리를 붙들고 있게 된다 (버그: 실패 시 즉시 반납 원칙 위반).
				await this.resetPipeline();
				throw retryError;
			}
		}

		return {
			embedding,
			embeddingModel: Embedding.LOCAL_MODEL_EMBEDDING_ID,
			embeddingSource: 'local',
			embeddingSucceeded: true,
		};
	}

	// ── 오류 분류 / 서킷브레이커 ─────────────────────────────────────────

	// OOM은 Emscripten abort, WebAssembly.Memory 성장 실패, ORT 자체 할당자, JS 힙 등
	// 서로 무관한 여러 layer를 거쳐 나타나서 공통 에러 타입이 없다 — 메시지로만 분류한다.
	private static classifyInferenceError(error: unknown): 'out-of-memory' | 'inference-error' {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return Embedding.OUT_OF_MEMORY_PATTERNS.some((pattern) => message.includes(pattern))
			? 'out-of-memory'
			: 'inference-error';
	}

	// run()이 배치(pass) 시작 시 호출하면 즉시 초기화된다. 호출하지 않아도 아래 쿨다운
	// 덕에 embed()는 항상 안전하게 동작한다.
	resetCircuitBreaker(): void {
		this.consecutiveFailures = 0;
		this.breakerTrippedAt = undefined;
	}

	// 트립 상태(연속 3회 실패)이고 쿨다운이 아직 안 지났으면 시도 자체를 막는다(embed()가
	// throw). 쿨다운이 지나면 false를 반환해 한 번의 재시도를 허용 — CollectAndSave.run()이
	// 아직 없어 아무도 resetCircuitBreaker()를 호출해주지 않아도, 이 쿨다운이 없으면 한 번
	// 트립된 뒤로 영구히 실패만 반환하게 된다 (003-embedding-model.md 참고).
	private breakerBlocksAttempt(): boolean {
		if (this.consecutiveFailures < Embedding.FAILURE_LIMIT || this.breakerTrippedAt === undefined) {
			return false;
		}
		return Date.now() - this.breakerTrippedAt < Embedding.BREAKER_COOLDOWN_MS;
	}

	private recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.breakerTrippedAt = undefined;
	}

	private recordFailure(error: unknown): void {
		this.consecutiveFailures += 1;

		// 논문마다 Notice가 뜨면 대량 수집 시 스팸이 되므로, 스트릭의 첫 실패에만 알린다.
		if (this.consecutiveFailures === 1) {
			const reason = Embedding.classifyInferenceError(error);
			new Notice(
				reason === 'out-of-memory'
					? 'PaperGraph3D: 온디바이스 임베딩 모델이 메모리 부족으로 실패했습니다. 해당 논문의 임베딩은 건너뜁니다.'
					: `PaperGraph3D: 온디바이스 임베딩 모델이 실패했습니다 (${error instanceof Error ? error.message : String(error)}). 해당 논문의 임베딩은 건너뜁니다.`,
			);
		}

		if (this.consecutiveFailures >= Embedding.FAILURE_LIMIT) {
			const justTripped = this.breakerTrippedAt === undefined;
			// 쿨다운 후 재시도가 다시 실패한 경우에도 쿨다운 시계를 재시작한다 — 단,
			// 트립 알림은 최초 1회만.
			this.breakerTrippedAt = Date.now();
			if (justTripped) {
				new Notice('PaperGraph3D: 임베딩이 계속 실패해 잠시 중단합니다. 1분 후 자동으로 다시 시도합니다.');
			}
		}
	}

	// ── 논문 단위 오케스트레이션 (공개 API) ─────────────────────────────

	// 실패(모델 미설치/서킷브레이커/추론 오류) 시 항상 throw한다 — 가짜 벡터를 계산해
	// 반환하지 않는다. Paper의 embedding 필드가 non-nullable이라 "임베딩 안 됨" 상태를
	// Paper에 어떻게 반영할지는(저장을 건너뛸지, embedding=[] 등으로 명시적으로 채울지)
	// 호출자(수집 플로우)의 책임이다.
	//
	// ⚠️ 동시 호출 안전하지 않음: session/서킷브레이커/modelLocationChecked 상태가
	// 락 없이 공유된다. 호출자는 반드시 순차(await 완료 후 다음 호출)로만 embed()를
	// 불러야 한다 — 병렬로 부르면 (a) 설치 확인 중인 다른 호출이 아직 안 끝난
	// modelLocation을 보고 "설치 안 됨"으로 오판하거나 (b) 한 호출의 실패로 세션이
	// dispose되는 도중 다른 호출이 같은 세션으로 추론 중일 수 있다(docs/devLog/
	// 003-embedding-model.md "동시성 가정" 참고).
	async embed(title: string, abstract: string): Promise<EmbeddingResult> {
		if (this.breakerBlocksAttempt()) {
			throw new Error(
				'PaperGraph3D: 임베딩이 반복 실패해 잠시 중단된 상태입니다. 1분 후 다시 시도하세요.',
			);
		}

		const location = await this.ensureModelLocation();
		if (location === undefined) {
			// 모델이 아직 설치 안 된, 예상 가능한 상태 — 실패가 아니므로 서킷브레이커에
			// 반영하지 않는다.
			throw new Error('PaperGraph3D: 임베딩 모델이 설치되어 있지 않습니다. 설정 탭에서 먼저 설치하세요.');
		}

		try {
			const result = await this.runLocalModel(title, abstract, location);
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordFailure(error);
			throw error;
		}
	}
}
