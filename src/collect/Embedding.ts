import { Notice, requestUrl, type DataAdapter, type Vault } from 'obsidian';

// 온디바이스 SPECTER2(8bit 양자화) 임베딩. 설계 근거는 docs/devLog/003-embedding-model.md
// 참고 — 모델 파일은 번들에 넣지 않고 GitHub Release에서 사용자가 설치 버튼으로만
// 받는다. 설치 전/실패 시에는 항상 해시 기반 베이스라인으로 폴백해서 embed()는 절대
// throw하지 않는다 (Paper의 embedding 계열 필드가 전부 non-nullable이기 때문).

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

	// ── 상수: GitHub Release / 에셋 레이아웃 ───────────────────────────────
	// 모델 변환·양자화·업로드는 코딩 작업 범위 밖의 수동 작업이다 (003-embedding-model.md).
	private static readonly RELEASE_OWNER = '2024YSJ';
	private static readonly RELEASE_REPO = 'PaperGraph_Framework';
	private static readonly MODEL_RELEASE_TAG = 'model-specter2-q8-v1';
	private static readonly WASM_FILE = 'ort-wasm-simd-threaded.jsep.wasm';
	private static readonly MODELS_SUBDIR = 'models';
	private static readonly WASM_SUBDIR = 'wasm';
	private static readonly MODEL_ID = 'specter2-proximity-onnx';
	// tokenizer.json은 필수 — transformers.js에 vocab.txt 로더가 없다.
	private static readonly MODEL_FILES = [
		'config.json',
		'tokenizer.json',
		'tokenizer_config.json',
		'special_tokens_map.json',
		'onnx/model_quantized.onnx',
	] as const;

	// ── 상수: 베이스라인 (해시 TF, 항상 계산 가능한 폴백) ───────────────────
	private static readonly BASELINE_EMBEDDING_DIM = 2048;
	private static readonly BASELINE_EMBEDDING_MODEL = 'local-hashtf-v1-d2048';

	// ── 상수: SPECTER2 ─────────────────────────────────────────────────
	private static readonly SPECTER2_EMBEDDING_MODEL = 'local-specter2-proximity-v1-d768';
	private static readonly SPECTER2_EMBEDDING_DIM = 768;
	private static readonly MAX_SEQUENCE_LENGTH = 512;
	// 고정 길이 버킷 — WASM 힙이 절대 줄어들지 않아 매 논문마다 새 shape을 주면
	// 100~200편 근처에서 OOM 나던 문제의 근본 수정 (003-embedding-model.md 1차 방어).
	private static readonly LENGTH_BUCKETS = [128, 256, 512] as const;
	// 실패 여부와 무관하게 이 횟수마다 세션을 강제로 버리고 새로 만들어 WASM 할당자에게
	// 메모리를 돌려준다 (3차 방어 — "완료된 작업이 메모리를 계속 차지하는" 문제의 핵심 대응).
	private static readonly INFERENCES_PER_SESSION = 64;

	// ── 상수: 서킷브레이커 (5차 방어) ───────────────────────────────────
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
			modelDir: `${modelsDir}/${Embedding.MODEL_ID}`,
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

	// ── 베이스라인 해시 TF 임베딩 (폴백, 항상 계산 가능) ───────────────────

	private computeBaselineEmbedding(title: string, abstract: string): EmbeddingResult {
		const text = abstract.length > 0 ? `${title} ${abstract}` : title;
		const tokens = Embedding.tokenize(text);

		const termFrequencies = new Map<string, number>();
		for (const token of tokens) {
			termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
		}

		const vector = new Float64Array(Embedding.BASELINE_EMBEDDING_DIM);
		for (const [token, count] of termFrequencies) {
			const hash = Embedding.fnv1a(token);
			const bucket = hash % Embedding.BASELINE_EMBEDDING_DIM;
			// 해시 비트 하나로 부호를 정해서, 충돌한 토큰들이 서로 상쇄되는 쪽으로 유도한다.
			const sign = ((hash >>> 16) & 1) === 0 ? 1 : -1;
			vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
		}

		return {
			embedding: Embedding.l2Normalize(Array.from(vector)),
			embeddingModel: Embedding.BASELINE_EMBEDDING_MODEL,
			embeddingSource: 'local',
			embeddingSucceeded: false,
		};
	}

	private static tokenize(text: string): string[] {
		return text
			.normalize('NFKC')
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 0);
	}

	private static fnv1a(token: string): number {
		let hash = 0x811c9dc5;
		for (let i = 0; i < token.length; i += 1) {
			hash ^= token.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	}

	private static l2Normalize(vector: number[]): number[] {
		let sumOfSquares = 0;
		for (const value of vector) {
			sumOfSquares += value * value;
		}
		const norm = Math.sqrt(sumOfSquares);
		return norm === 0 ? vector : vector.map((value) => value / norm);
	}

	// ── ONNX 세션 관리 + SPECTER2 추론 ─────────────────────────────────

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

		const tokenizer = await autoTokenizer.from_pretrained(Embedding.MODEL_ID);
		const model = await autoModel.from_pretrained(Embedding.MODEL_ID, {
			// GitHub Release의 model_quantized.onnx(8bit 양자화)에 대응.
			dtype: 'q8',
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

		// [batch, sequence, hidden], batch=1이므로 CLS 토큰은 버퍼 앞 SPECTER2_EMBEDDING_DIM개.
		const hiddenSize = hidden.dims[2] ?? 0;
		if (hiddenSize !== Embedding.SPECTER2_EMBEDDING_DIM) {
			throw new Error(
				`SPECTER2 produced a ${hiddenSize}-d hidden state, expected ${Embedding.SPECTER2_EMBEDDING_DIM}`,
			);
		}

		const cls = new Array<number>(Embedding.SPECTER2_EMBEDDING_DIM);
		for (let i = 0; i < Embedding.SPECTER2_EMBEDDING_DIM; i += 1) {
			cls[i] = Number(hidden.data[i] ?? Number.NaN);
		}
		return Embedding.l2Normalize(cls);
	}

	private async specter2Embedding(
		title: string,
		abstract: string,
		location: LocalModelLocation,
	): Promise<EmbeddingResult> {
		// SPECTER2가 학습된 입력 형식: title, 리터럴 '[SEP]', abstract. 초록이 없으면
		// title만 쓴다 (공백으로 이어붙이면 학습 형식과 달라져 품질이 떨어진다).
		const text = abstract.length > 0 ? `${title}[SEP]${abstract}` : title;

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

		if (embedding.some((value) => !Number.isFinite(value))) {
			throw new Error('SPECTER2 produced a non-finite embedding');
		}

		return {
			embedding,
			embeddingModel: Embedding.SPECTER2_EMBEDDING_MODEL,
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

	// 트립 상태(연속 3회 실패)이고 쿨다운이 아직 안 지났으면 시도 자체를 막는다. 쿨다운이
	// 지나면 false를 반환해 한 번의 재시도를 허용 — CollectAndSave.run()이 아직 없어
	// 아무도 resetCircuitBreaker()를 호출해주지 않아도, 이 쿨다운이 없으면 한 번 트립된
	// 뒤로 영구히 폴백만 반환하게 된다 (003-embedding-model.md 참고).
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
					? 'PaperGraph3D: 온디바이스 임베딩 모델이 메모리 부족으로 실패했습니다. 나머지 논문은 임시 임베딩으로 저장됩니다.'
					: `PaperGraph3D: 온디바이스 임베딩 모델이 실패했습니다 (${error instanceof Error ? error.message : String(error)}). 나머지 논문은 임시 임베딩으로 저장됩니다.`,
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

	// 절대 throw하지 않는다 — Paper의 embedding 필드가 non-nullable이라 "임베딩 안 됨"
	// 상태를 표현할 방법이 없다. 항상 사용 가능한 벡터(성공 시 SPECTER2, 그 외엔 해시
	// 폴백)를 반환하고 embeddingSucceeded로만 구분한다.
	async embed(title: string, abstract: string): Promise<EmbeddingResult> {
		if (this.breakerBlocksAttempt()) {
			return this.computeBaselineEmbedding(title, abstract);
		}

		const location = await this.ensureModelLocation();
		if (location === undefined) {
			// 모델이 아직 설치 안 된, 예상 가능한 상태 — 실패가 아니므로 서킷브레이커에
			// 반영하지 않는다.
			return this.computeBaselineEmbedding(title, abstract);
		}

		try {
			const result = await this.specter2Embedding(title, abstract, location);
			this.recordSuccess();
			return result;
		} catch (error) {
			this.recordFailure(error);
			return this.computeBaselineEmbedding(title, abstract);
		}
	}
}
