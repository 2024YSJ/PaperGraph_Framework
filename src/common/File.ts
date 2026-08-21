import { Notice, TFile, Vault } from 'obsidian';
import { Log } from './Log';
import { Secret } from '../collect/Secret';
import { Subscriptions } from '../collect/Subscriptions';
import { API, ArxivAPI, type SkippedEntryRecord } from '../collect/API';
import { ExtraData, Paper } from '../collect/Paper';
import { SearchQuery } from '../collect/SearchQuery';
import { DEFAULT_SCHEDULE_SETTINGS, ScheduleSettings } from '../collect/ScheduleSettings';
import { isUsablePaperDate } from './DateUtil';

// .json 저장 래퍼. schemaVersion은 향후 대비 상수(현재 분기/마이그레이션엔 안 씀).
// 설계 근거: docs/devLog/002.md.
export interface StoredPaperFile {
	schemaVersion: number;
	paper: Paper; // Paper 필드 그대로 (embedding 포함)
	createdAt: number;
	updatedAt: number;
}

// 파일명 정제용. Windows/macOS/Linux 공통 금지/예약 문자 + 제어문자. ($/{/} 는 유지)
// eslint-disable-next-line no-control-regex -- 파일명에서 제어문자 제거는 의도된 동작
const ILLEGAL_CHARS = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]', 'g');
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_TITLE_LENGTH = 100;

// .md 관리 본문 마커.
const NOTE_BEGIN = '<!-- pg3d:begin -->';
const NOTE_END = '<!-- pg3d:end -->';

// provider별 논문 웹 URL 생성기. 새 provider를 지원하려면 이 목록에 한 줄만 추가하면 되고
// paperUrl 함수 본문은 손대지 않는다(데이터 주도). localId는 sourceId의 ':' 뒤 부분.
const PAPER_URL_BUILDERS: Record<string, (localId: string) => string> = {
	arxiv: (localId) => `https://arxiv.org/abs/${localId}`,
	semanticScholar: (localId) => `https://www.semanticscholar.org/paper/${localId}`,
};

// 파일을 읽고 쓰는 static 클래스 (다이어그램 File 정의, 2026-08-02 회의). 인스턴스 없이
// File.메소드()로 접근하며, vault/플러그인 폴더 참조는 init()으로 한 번만 보관한다.
//   - Secret/Subscriptions: 플러그인 폴더의 JSON. vault.adapter로 접근. Secret은 난독화.
//   - Paper: 콘텐츠 트리(PaperGraph3D/YYYY/MM/DD/)의 .json + .md. 일반 Vault API로 접근.
// 파일명 규칙과 .md 형식은 기존 PaperGraph3D 프로젝트 로직을 이 클래스 private 메서드로
// 흡수한 것이다(기존 vault 파일과 100% 호환).
export class File {
	private static vault: Vault;
	private static pluginDir: string; // <vault.configDir>/plugins/papergraph3d

	private static readonly SCHEMA_VERSION = 4;
	// 난독화용 하드코딩 키(일단). ⚠️ 번들에서 추출 가능 — 실수 노출 방지 수준이지 암호화 아님.
	private static readonly OBFUSCATION_KEY = 'PaperGraph3D::pg3d-obfuscation-v1';

	private static readonly PAPER_ROOT = 'PaperGraph3D';

	// 가장 최근 readSubscriptions() 호출에서 화이트리스트 검증(9번/69번)에 걸려 조건이
	// 걸러졌는지 — 호출자(CollectAndSave.runNow)가 "구독이 이상하면 이번 수집은 하지 않고
	// 경고만 띄운다"를 판단하는 데 쓴다. readSubscriptions 자체는 자가 복구(파일을 정리된
	// 상태로 되돌려 씀)까지만 책임지고, "그래서 이번 수집을 계속할지"는 도메인(수집 로직)의
	// 판단이라 여기 File은 사실만 노출한다. readSubscriptions를 부를 때마다 다시 계산된다.
	static lastReadDroppedInvalidConditions = false;

	// 가장 최근 readAllPapers()/readPapersByYear() 호출에서 규격을 벗어나 건너뛴 파일들
	// (QA 12번/15번/18번). lastReadDroppedInvalidConditions와 같은 방침 — File은 "이런
	// 파일을 무시했다"는 사실만 노출하고, 사용자에게 알릴지 말지는 호출자가 정한다.
	// 경로 목록은 로그용이라 앞쪽 몇 개만 보관한다(코퍼스 전체가 어긋난 경우 대비).
	static lastScanSkipped: { count: number; samples: string[] } = { count: 0, samples: [] };

	private static readonly SKIPPED_SAMPLE_LIMIT = 5;

	// 콘텐츠 트리에서 논문으로 인정하는 유일한 경로 모양:
	// PaperGraph3D/<YYYY>/<MM>/<DD>/<이름>.json (날짜가 없는 논문은 unknown/<이름>.json).
	// startsWith + 확장자만 보던 예전 필터는 깊이를 전혀 안 봐서, 연도 폴더 바로 밑에
	// 넣은 .json(18번)도 논문으로 읽혔다.
	private static readonly PAPER_RELATIVE_PATH = /^(?:(\d{4})\/(\d{2})\/(\d{2})|unknown)\/[^/]+\.json$/;

	static init(vault: Vault, pluginDir: string): void {
		File.vault = vault;
		File.pluginDir = pluginDir;
	}

	// ── Secret / Subscriptions (플러그인 폴더) ──────────────────────────

	static readSecret(): Promise<Secret> {
		return File.readConfig(
			'Secret.json',
			(raw) => Secret.fromJSON(raw as Record<string, string>),
			() => new Secret(),
			(text) => File.deobfuscate(text),
		);
	}

	static writeSecret(secret: Secret): Promise<void> {
		return File.writeConfig('Secret.json', secret.toJSON(), (text) => File.obfuscate(text));
	}

	// 자동 수집 스케줄 설정. Secret처럼 민감한 값이 아니라 평문으로 저장한다(난독화 없음).
	// 저장된 값 중 일부 필드가 없어도(구버전 파일, 수동 편집 등) 죽지 않도록 기본값과
	// 병합한다 — 새 필드를 추가해도 기존 Schedule.json이 그대로 읽힌다.
	static readScheduleSettings(): Promise<ScheduleSettings> {
		return File.readConfig(
			'Schedule.json',
			(raw) =>
				File.sanitizeScheduleSettings({
					...DEFAULT_SCHEDULE_SETTINGS,
					...(raw as Partial<ScheduleSettings>),
				}),
			() => ({ ...DEFAULT_SCHEDULE_SETTINGS }),
		);
	}

	// UI(ScheduleModal, type="time")는 0~23시/0~59분만 입력하게 막지만, Schedule.json은
	// 사용자가 직접 편집할 수 있는 평문 파일이라 그 방어를 우회할 수 있다(실제 재현됨:
	// targetHour=25/targetMinute=-5). 범위를 벗어난 값은 Scheduler의 두 계산(missedToday는
	// 단순 산술이라 "영원히 도달 불가"로, msUntilNextTarget은 Date 정규화로 "다음날 엉뚱한
	// 시각"으로) 서로 다르게 반응해 캐치업이 조용히 고장 난다. 클램핑(25->23)은 사용자가
	// 의도한 것과도 다른 "그럴듯하지만 틀린" 값이 되어 더 헷갈리므로, 무효면 기본값으로
	// 되돌린다 — "이 값은 무효였다"가 명확하다.
	//
	// 필드를 명시적으로 나열해 재구성한다(입력을 그대로 스프레드하지 않음) — 2026-08-14
	// (514ee68) 구간/간격 기반 스케줄러(intervalHours/windowStartHour/windowEndHour)를
	// 정시 기반으로 개편하며 타입에서는 이미 지웠는데, 그 전에 저장된 Schedule.json에는
	// 여전히 이 키들이 남아 있다. 스프레드로 병합하면 그 죽은 키가 계속 실려 다니며 다음
	// 저장 때 다시 파일에 쓰인다 — 여기서 알려진 필드만 골라내 자연스럽게 걸러낸다.
	private static sanitizeScheduleSettings(settings: ScheduleSettings): ScheduleSettings {
		const validHour =
			Number.isInteger(settings.targetHour) && settings.targetHour >= 0 && settings.targetHour <= 23;
		const validMinute =
			Number.isInteger(settings.targetMinute) &&
			settings.targetMinute >= 0 &&
			settings.targetMinute <= 59;
		return {
			enabled: settings.enabled,
			targetHour: validHour ? settings.targetHour : DEFAULT_SCHEDULE_SETTINGS.targetHour,
			targetMinute: validMinute ? settings.targetMinute : DEFAULT_SCHEDULE_SETTINGS.targetMinute,
			lastRunAt: settings.lastRunAt,
			lastLoadRepairAt: settings.lastLoadRepairAt,
		};
	}

	static writeScheduleSettings(settings: ScheduleSettings): Promise<void> {
		return File.writeConfig('Schedule.json', settings);
	}

	// 7번(부분 재조회) — [2] 정책으로 스킵된 항목의 임시 기록. Schedule.json과 같은 방식
	// (평문, 플러그인 폴더). 이 기능이 통째로 제거되면 이 두 함수와 SkippedEntries.json
	// 하나만 지우면 된다 — 다른 config들과 달리 마이그레이션/기본값 병합을 두지 않는다
	// (레코드가 없으면 그냥 빈 배열, 필드가 안 맞으면 그 레코드는 버려도 무방한 임시
	// 데이터라 굳이 옛 형식과 호환시킬 이유가 없다).
	static readSkippedEntries(): Promise<SkippedEntryRecord[]> {
		return File.readConfig(
			'SkippedEntries.json',
			(raw) => (Array.isArray(raw) ? (raw as SkippedEntryRecord[]) : []),
			() => [],
		);
	}

	static writeSkippedEntries(records: SkippedEntryRecord[]): Promise<void> {
		return File.writeConfig('SkippedEntries.json', records);
	}

	// Secret.json도 함께 읽어 복원된 각 API 인스턴스에 실어 보낸다 — 저장된 Subscriptions.json
	// 자체엔 secret이 없다(writeSubscriptions가 의도적으로 제외, 아래 참고). readConfig의
	// revive 콜백은 동기 함수라 그 안에서 await할 수 없으므로, secret은 미리 읽어 클로저로
	// 넘긴다.
	static async readSubscriptions(): Promise<Subscriptions> {
		const secret = await File.readSecret();
		// revive는 동기 함수라 그 안에서 flag를 못 들고 나가므로, 바깥의 let으로 받는다 —
		// 아래 readConfig 호출 이후 이 값을 보고 자가 복구(write-back) 여부를 정한다.
		let droppedAny = false;
		// 이번 호출 결과로 매번 새로 계산한다 — 이전 호출의 값이 남아있으면 안 된다.
		File.lastReadDroppedInvalidConditions = false;
		const subscriptions = await File.readConfig(
			'Subscriptions.json',
			(raw) => {
				// 저장된 apis는 평범한 객체({ apiName, querys, updateTime })라 메서드가 없다.
				// createApi로 apiName에 맞는 구현 클래스를 인스턴스화해 메서드가 살아있는
				// API로 복원한다.
				const data = raw as {
					// 구버전 파일 호환용. 전역 커서 하나만 있던 시절의 필드 — 지금은 안 쓴다
					// (updateTime은 이제 apis[].updateTime, 구독마다 독립). 이 필드가 있는데
					// 밑의 apis[].updateTime이 없으면 마이그레이션 값으로 쓴다: 모든 구독이
					// 예전과 같은 지점부터 이어서 훑게 해, 커서 형식이 바뀌었다고 갑자기
					// 전체를 다시 backfill하지 않는다.
					updateTime?: number;
					apis?: { apiName: string; querys?: SearchQuery[]; updateTime?: number }[];
				};
				const legacyCursor = typeof data.updateTime === 'number' ? data.updateTime : 0;
				const subscriptions = new Subscriptions();
				subscriptions.secret = secret;
				// UI(ApiManagementModal)는 저장 시점에 같은 apiName+조건 조합의 중복을 막지만
				// (hasDuplicateSubscription), Subscriptions.json은 사용자가 직접 편집할 수 있는
				// 평문 파일이라 그 방어를 우회할 수 있다(실제 재현됨) — 완전히 같은 구독이
				// 두 개면 매 수집마다 같은 요청이 영구히 두 번 나간다. 여기, 파일을 실제로
				// 복원하는 유일한 지점에서 걸러내면 어떤 경로로 파일에 들어왔든(수동 편집,
				// 앞으로 생길 다른 저장 경로) 런타임에는 항상 하나로만 존재한다.
				const seen = new Set<string>();
				// sanitizeQuerys(9번/69번 화이트리스트)는 원래 writeSubscriptions에만 있었는데,
				// 그러면 파일을 직접 편집해 잘못된 조건을 넣었을 때 "다음에 뭔가 저장되기
				// 전까지"는 검증 없이 그대로 읽혀 실제 수집(runNow → readSubscriptions)에
				// 쓰였다(실제 재현됨 — write가 한 번 더 일어나기 전까지 4개 조건이 그대로
				// 실행되고, 그제서야 뒤늦게 3개로 줄어들며 Notice가 떴다). 읽는 이 시점에도
				// 같은 검증을 적용해 파일을 읽자마자 걸러지게 한다 — 쓰기 전까지의 창을 없앤다.
				subscriptions.apis = (data.apis ?? [])
					.map((apiData) => {
						const migrated = (apiData.querys ?? []).map((query) => File.migrateSearchType(query));
						const sanitized = File.sanitizeQuerys(apiData.apiName, migrated);
						if (sanitized.length !== migrated.length) {
							droppedAny = true;
						}
						return { ...apiData, querys: sanitized };
					})
					// 유효한 조건이 하나도 안 남았다고 여기서 구독 자체를 통째로 빼면 안 된다 —
					// apiName이 애초에 모르는 값이라 querys를 검증할 기준조차 없는 경우
					// (QUERY_VALIDATORS에 없음)도 이 조건에 걸리는데, 그런 항목은 조용히
					// 사라지는 대신 아래 createApi가 "Unknown apiName"으로 크게 실패해야
					// 한다(팀원이 새 API를 추가한 브랜치에서 저장한 파일을 구버전이 열어
					// 조용히 그 구독을 지워버리는 사고를 막는 안전장치, 기존 테스트로 고정됨).
					// searchType/category 값이 정말 걸러진 경우는 querys가 빈 채로 createApi까지
					// 가고, 실제 수집 시점(buildUrl)에서 "querys is empty"로 드러난다.
					.filter((apiData) => {
						const key = `${apiData.apiName}::${JSON.stringify(apiData.querys)}`;
						if (seen.has(key)) {
							return false;
						}
						seen.add(key);
						return true;
					})
					.map((apiData) => {
						const api = File.createApi(apiData.apiName, apiData.querys, secret);
						api.updateTime =
							typeof apiData.updateTime === 'number' ? apiData.updateTime : legacyCursor;
						return api;
					});
				return subscriptions;
			},
			() => {
				// Subscriptions.json이 아직 없는 첫 실행(새로 설치한 환경) 기본값.
				// 모든 필드를 실제로 채워야 한다 — 비워두면 `!` 단언 때문에 타입은 채워진
				// 것처럼 보이지만 런타임 값은 undefined라, 호출자가 그대로 .map/.forEach하면
				// 그 자리에서 터진다(설정탭이 실제로 이렇게 죽었었다).
				const subscriptions = new Subscriptions();
				subscriptions.secret = secret;
				subscriptions.apis = [];
				return subscriptions;
			},
		);
		if (droppedAny) {
			// 걸러낸 결과를 즉시 파일에 되돌려 쓴다 — 안 그러면 파일은 여전히 잘못된 값을
			// 그대로 갖고 있어서, 이 함수가 다시 불릴 때마다(같은 수집 한 번 안에서도
			// runNow 시작과 커서 갱신용 mutateSubscriptions가 각각 부른다) 매번 다시
			// 걸러진다. writeSubscriptions에도 같은 검증이 있지만, 여기서 넘기는
			// subscriptions는 이미 이 함수가 정리한 값이라 그쪽에서는 아무것도 더 안 걸린다.
			//
			// Notice는 여기서 안 띄운다 — 수집(CollectAndSave.runNow)이 이 플래그를 보고
			// "구독이 이상하면 이번엔 경고만 띄우고 수집 자체를 하지 않는다"로 처리한다
			// (사용자 요청 — 걸러진 채로 조용히 "정상 완료"된 것처럼 보이면 안 됨). 수집이
			// 아닌 다른 경로(설정 탭 등)에서 읽었을 때는 로그로만 남는다.
			Log.warn(
				'subscriptions',
				'일부 구독 조건이 허용되지 않는 형식이라 무시되었습니다 — 파일을 정리된 상태로 되돌려 씀',
			);
			await File.writeSubscriptions(subscriptions);
			File.lastReadDroppedInvalidConditions = true;
		}
		return subscriptions;
	}

	// 이름이 바뀐 searchType을 현재 값으로 옮긴다. 설정탭이 'domain'을 저장하던 시절의
	// Subscriptions.json이 그대로 남아 있으면, 복원된 구독으로 수집할 때 arXiv 쪽에서
	// "Unknown searchType"으로 throw해 해당 구독 전체가 실패한다. 읽는 시점에 한 번
	// 정규화해 두면 저장 파일이 다음 writeSubscriptions에서 자연스럽게 갱신된다.
	private static readonly SEARCH_TYPE_ALIASES: Record<string, string> = {
		domain: 'category',
	};

	// typeof 검사는 프로토타입 체인 방어다. searchType이 'toString' 같은 값이면 맵에서
	// 함수가 잡히는데, truthy라서 그대로 searchType에 대입돼버린다.
	private static migrateSearchType(query: SearchQuery): SearchQuery {
		const renamed = File.SEARCH_TYPE_ALIASES[query.searchType];
		return typeof renamed === 'string' ? { ...query, searchType: renamed } : query;
	}

	// 구독 조건은 API 단위로 최대 3개(002.md 확정)까지, 그 API가 인정하는 searchType
	// (예: arXiv의 keyword/author/category)만, 그리고 그 searchType이 받아들이는 값
	// 모양만 허용한다. searchType은 맞아도 값 자체가 문제인 경우가 있다 — arXiv의
	// category는 값을 따옴표로 감싸지 않고 쿼리에 그대로 꽂히므로(ArxivAPI.formatTerm),
	// "cs.AI" 같은 고정 토큰이 아니라 공백+AND/OR+다른 필드를 넣으면 쿼리 전체를 조작할
	// 수 있다(69번, 실제 재현됨: searchType은 정상인데 값으로 필터를 우회). 이 화이트
	// 리스트는 각 API 구현체가 정한다(ArxivAPI.isValidSearchType/isValidCategoryValue) —
	// File.ts는 apiName으로 어느 구현체의 규칙을 적용할지만 안다.
	private static readonly MAX_QUERYS_PER_SUBSCRIPTION = 3;
	private static readonly QUERY_VALIDATORS: Record<string, (query: SearchQuery) => boolean> = {
		arxiv: (query) =>
			ArxivAPI.isValidSearchType(query.searchType) &&
			(query.searchType !== 'category' || ArxivAPI.isValidCategoryValue(query.query)),
	};

	// ApiManagementModal은 UI에서 keyword/author/category 드롭다운과 3개 상한을 지키게
	// 하지만, 저장 파일(Subscriptions.json)은 사용자가 개발자 도구로 DOM/네트워크 요청을
	// 조작해 그 UI 제약을 우회하고 임의의 필드/개수를 심을 수 있다(9번, 실제 재현됨).
	// 저장이 실제로 일어나는 이 지점에서 다시 걸러내면 어떤 경로로 들어온 값이든(정상
	// UI, 조작된 요청, 앞으로 생길 다른 저장 경로) 파일에는 항상 유효한 조건만 남는다.
	// 알 수 없는 apiName(QUERY_VALIDATORS에 없음)은 검증 기준이 없으므로 그대로
	// 통과시킨다 — 그 apiName 자체가 잘못됐다면 File.createApi(복원 시점)가 이미 막는다.
	private static sanitizeQuerys(apiName: string, querys: SearchQuery[]): SearchQuery[] {
		const isValid = File.QUERY_VALIDATORS[apiName];
		const filtered = isValid ? querys.filter((q) => isValid(q)) : querys;
		return filtered.slice(0, File.MAX_QUERYS_PER_SUBSCRIPTION);
	}

	static writeSubscriptions(subscriptions: Subscriptions): Promise<void> {
		// secret은 별도 Secret.json(난독화)에만 저장한다. Subscriptions.json에 함께 넣으면
		// API 키가 평문으로 중복 저장되므로 제외한다.
		//
		// ⚠️ apis를 그대로 넘기면 안 된다. API 구현체는 Secret 참조나 캐시(lastCoverage 등)를
		// 인스턴스 필드로 들고 있을 수 있고, TypeScript의 private은 컴파일 타임 표시일 뿐이라
		// JSON.stringify가 전부 직렬화한다 — 실제로 ArxivAPI에 secret을 넘기기 시작하자
		// 이 파일에 API 키가 평문으로 찍혔다. 저장할 필드를 여기서 명시적으로 골라내
		// 구현체가 어떤 필드를 갖든 새지 않게 한다(복원에 필요한 건 apiName·querys·updateTime뿐이다).
		//
		// 커서(updateTime)를 구독 하나마다 따로 싣는다 — 전역 커서 한 값이던 시절과 달리,
		// 구독이 배열의 어느 위치로 옮겨져도(추가/삭제/재배열) 그 구독 고유의 진행 상황이
		// 함께 따라간다.
		let droppedAny = false;
		const apis = subscriptions.apis.map((api) => {
			const querys = File.sanitizeQuerys(api.apiName, api.querys);
			if (querys.length !== api.querys.length) {
				droppedAny = true;
			}
			return { apiName: api.apiName, querys, updateTime: api.updateTime };
		});
		if (droppedAny) {
			// 저장은 계속 진행한다(나머지 정상 구독까지 막을 이유는 없다) — 다만 조용히
			// 걸러내면 사용자는 자기 구독이 왜 줄었는지 알 방법이 없다.
			new Notice(
				'PaperGraph3D: 일부 구독 조건이 허용되지 않는 형식이라 저장에서 제외되었습니다 — 구독 관리에서 확인하세요.',
			);
		}
		return File.writeConfig('Subscriptions.json', { apis });
	}

	// Subscriptions.json에 대한 읽기-수정-쓰기를 한 번에 하나씩만 실행한다.
	//
	// updateApiCursors(수집 종료)와 SettingTab.persistSubscriptions(UI 저장)가 둘 다
	// "읽고 -> 고치고 -> 쓴다" 패턴이다. 각자는 자기가 건드리는 필드만 바꾸고 나머지는
	// 그대로 돌려주므로 서로의 변경을 덮지 않을 것 같지만, 두 호출이 정확히 겹치면
	// (둘 다 읽고 → 둘 다 쓰면) 나중에 쓴 쪽이 앞선 변경을 통째로 지운다 — lost-update
	// 창을 줄였을 뿐 원자성은 아니었다. 이 큐로 두 경로를 하나의 타임라인에 줄 세운다.
	private static subscriptionsQueue: Promise<void> = Promise.resolve();

	static mutateSubscriptions(
		mutator: (subscriptions: Subscriptions) => void | Promise<void>,
	): Promise<void> {
		const result = File.subscriptionsQueue.then(async () => {
			const subscriptions = await File.readSubscriptions();
			await mutator(subscriptions);
			await File.writeSubscriptions(subscriptions);
		});
		// 이번 변경이 실패해도 큐는 다음 변경으로 계속 넘어간다 — 한쪽의 실패가 이후
		// 모든 구독 저장을 영원히 막으면 안 된다.
		File.subscriptionsQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// 여러 구독의 수집 커서를 한 번에 갈아 끼운다.
	//
	// apiName만으로는 어느 구독인지 특정할 수 없다 — 같은 apiName을 조건만 다르게
	// 여러 번 등록할 수 있어서(구독 관리 "구독 추가"), querys까지 같이 봐야 한다. 수집이
	// 도는 동안 사용자가 하필 그 구독의 조건 자체를 바꾸면(드문 경우) 매칭이 안 돼 이번
	// 갱신은 스킵된다 — 다음 실행이 예전 커서로 다시 훑을 뿐이라 데이터 유실은 아니다.
	static async updateApiCursors(
		updates: { apiName: string; querys: SearchQuery[]; cursor: number }[],
	): Promise<void> {
		if (updates.length === 0) {
			return;
		}
		await File.mutateSubscriptions((subscriptions) => {
			for (const api of subscriptions.apis) {
				const match = updates.find(
					(update) =>
						update.apiName === api.apiName && File.searchQueriesEqual(update.querys, api.querys),
				);
				if (match) {
					api.updateTime = match.cursor;
				}
			}
		});
	}

	// API 구현체 등록부 — 이 코드베이스가 지원하는 API 목록의 유일한 진실.
	// 새 API 추가 = 여기 한 줄 + import. 구독 UI의 드롭다운(supportedApiNames)과
	// createApi가 같은 목록을 보므로 "UI는 받는데 복원은 못 하는 이름"이 생길 수 없다.
	private static readonly API_FACTORIES: Record<
		string,
		(querys: SearchQuery[], secret?: Secret) => API
	> = {
		arxiv: (querys, secret) => new ArxivAPI(querys, secret),
	};

	// 구독 UI가 API 선택지를 만들 때 쓴다. 이름을 손으로 치게 하면 'arXiv' 같은 오타가
	// 저장은 통과하고 다음 수집(createApi)에서야 터진다 — 목록에서 고르게 해야 한다.
	static supportedApiNames(): string[] {
		return Object.keys(File.API_FACTORIES);
	}

	// apiName에 따라 API 구현 클래스를 인스턴스화한다. Subscriptions.json에서 읽은
	// 평범한 객체({ apiName, querys })를 메서드가 살아있는 API 인스턴스로 복원할 때 쓴다
	// (JSON 복원 시 메서드가 사라지는 문제 해결 — 002.md).
	// secret은 선택 사항 — 없으면 각 API 구현체가 알아서 익명으로 동작한다.
	static createApi(apiName: string, querys: SearchQuery[] = [], secret?: Secret): API {
		const factory = File.API_FACTORIES[apiName];
		if (factory === undefined) {
			throw new Error(`Unknown apiName: ${apiName}`);
		}
		return factory(querys, secret);
	}

	// ── Paper (콘텐츠 트리, .json + .md) ────────────────────────────────

	// 해당 연도 폴더(PaperGraph3D/<year>/) 아래 모든 .json을 읽어 Paper 배열로 반환.
	// 경로가 날짜로 결정되므로 연도만 있으면 sourceId 조회/인덱스 없이 일괄 로드된다.
	static async readPapersByYear(year: number): Promise<Paper[]> {
		return File.readPapersUnder(`${File.PAPER_ROOT}/${year}/`);
	}

	// 콘텐츠 트리 전체(PaperGraph3D/ 아래 모든 연도)의 논문을 읽는다. 보정 패스
	// (CollectAndSave.repair — 실패 플래그가 선 논문을 다시 시도)가 대상을 찾을 때 쓴다.
	static async readAllPapers(): Promise<Paper[]> {
		return File.readPapersUnder(`${File.PAPER_ROOT}/`);
	}

	// (readKnownCitations는 없앴다. 수집 직전에 코퍼스 전체를 읽어 sourceId -> citationCount
	// 맵을 만들던 함수인데, 비용이 코퍼스 크기에 비례해 늘었고 논문마다 readStoredPaper를
	// 또 부르고 있어 같은 파일을 두 번 읽었다. 지금은 CollectAndSave.prefillFromStore가
	// 청크에 속한 논문만 한 번씩 읽어 인용수와 임베딩을 함께 채운다.)

	// readPapersByYear/readAllPapers의 공통 몸통 — 둘 다 "이 prefix 아래 .json을 전부
	// Paper로 읽는다"만 다르게 좁힌 것이라 한 곳에만 둔다. vault.getFiles()가 이미 전체
	// 목록을 주므로 연도를 하나씩 열거할 필요가 없다.
	//
	// 이 함수가 "이 파일은 논문이다"를 정하는 유일한 지점이라, 콘텐츠 트리를 신뢰 경계로
	// 두고 여기서 전부 검사한다(QA 12번/15번/18번 — 손으로 만든 3월 50일 폴더, 미래
	// 날짜 폴더, 연도 폴더 바로 밑 .json이 전부 임베딩·시각화까지 되던 문제):
	//   1) 경로 모양(연/월/일 4단계 또는 unknown)이 맞는가
	//   2) 폴더에서 조합한 날짜가 달력에 있고 미래가 아닌가
	//   3) 폴더 날짜와 파일 안의 publicationDate가 일치하는가 (파일을 옮겨 심는 경우 차단
	//      — 응답 category 불일치 논문을 저장 거부한 8번과 같은 무결성 검사)
	// 걸린 파일은 조용히 빼고 File.lastScanSkipped로만 사실을 남긴다.
	private static async readPapersUnder(prefix: string): Promise<Paper[]> {
		const files = File.vault
			.getFiles()
			.filter((f) => f.path.startsWith(prefix) && f.extension === 'json');
		const papers: Paper[] = [];
		const skipped: string[] = [];
		let skippedCount = 0;
		const skip = (path: string): void => {
			skippedCount += 1;
			if (skipped.length < File.SKIPPED_SAMPLE_LIMIT) {
				skipped.push(path);
			}
		};
		for (const file of files) {
			const folderDate = File.paperPathDate(file.path);
			if (folderDate === null) {
				skip(file.path);
				continue;
			}
			// 손상된 .json 하나가 스캔 전체를 예외로 끝내면 그래프가 통째로 안 뜬다 —
			// 그 파일만 건너뛴다.
			let wrapper: StoredPaperFile;
			try {
				wrapper = JSON.parse(await File.vault.read(file)) as StoredPaperFile;
			} catch {
				skip(file.path);
				continue;
			}
			if (wrapper?.paper === undefined || wrapper.paper === null) {
				skip(file.path);
				continue;
			}
			const paper = Object.assign(new Paper(), wrapper.paper);
			// unknown/ 은 날짜를 모르는 논문의 정상 자리라 대조할 게 없다.
			if (folderDate !== 'unknown' && paper.publicationDate !== folderDate) {
				skip(file.path);
				continue;
			}
			// 구버전 스키마(collectedApi/collectedQuery 단일 값 시절) 파일 대비 폴백.
			paper.collectedApis ??= [];
			paper.collectedQueries ??= [];
			papers.push(paper);
		}
		File.lastScanSkipped = { count: skippedCount, samples: skipped };
		if (skippedCount > 0) {
			Log.warn(
				'papers',
				`콘텐츠 트리 규격에 맞지 않는 파일 ${skippedCount}개를 건너뜀: ${skipped.join(', ')}${skippedCount > skipped.length ? ' 외' : ''}`,
			);
		}
		return papers;
	}

	// 논문 .json의 경로에서 폴더가 나타내는 날짜(YYYY-MM-DD)를 돌려준다. 규격을 벗어나면
	// null, 날짜 없는 정상 저장 자리(unknown/)면 문자열 'unknown'.
	private static paperPathDate(path: string): string | null {
		if (!path.startsWith(`${File.PAPER_ROOT}/`)) {
			return null;
		}
		const relative = path.slice(File.PAPER_ROOT.length + 1);
		const match = File.PAPER_RELATIVE_PATH.exec(relative);
		if (!match) {
			return null;
		}
		const [, year, month, day] = match;
		if (year === undefined) {
			return 'unknown';
		}
		const date = `${year}-${month}-${day}`;
		return isUsablePaperDate(date) ? date : null;
	}

	// .json(진실 원본)과 .md(Obsidian 뷰)를 함께 쓴다. 재작성 시 기존 createdAt / 사용자
	// 자유 본문을 보존한다.
	static async writePaper(paper: Paper): Promise<void> {
		await File.writePaperAt(paper, File.resolvePaperPath(paper));
	}

	// 논문의 .md 노트 경로(콘텐츠 트리 기준). 경로는 publicationDate/title/sourceId로 결정된다.
	// 시각화에서 노드 클릭 시 노트를 여는 등에 쓴다.
	static paperNotePath(paper: Paper): string {
		return `${File.resolvePaperPath(paper)}.md`;
	}

	// 이 Paper가 저장될 자리에 이미 저장돼 있는 논문을 읽는다. 없으면 null. 저장 경로가
	// publicationDate/title/sourceId로 결정되므로, 넘긴 paper의 이 필드들이 실제 저장본과
	// 같아야 같은 파일을 찾는다 — run()이 "이미 임베딩된 논문인가"를 판단할 때 쓴다.
	static async readStoredPaper(paper: Paper): Promise<Paper | null> {
		const jsonPath = `${File.resolvePaperPath(paper)}.json`;
		const text = await File.readVaultText(jsonPath);
		if (text === null) {
			return null;
		}
		const wrapper = JSON.parse(text) as StoredPaperFile;
		return Object.assign(new Paper(), wrapper.paper);
	}

	// 테스트/검증용: 정식 수집 경로(PaperGraph3D/<year>/<month>/<day>) 대신 지정한 폴더
	// 바로 아래에 저장한다. .json+.md 형식과 upsert(생성 또는 갱신) 동작은 writePaper와
	// 동일 — 이 폴더 아래 파일은 정식 수집 데이터와 섞이지 않는다(임베딩 테스트용
	// SettingTab 버튼에서 사용).
	// ⚠️ folder는 반드시 PaperGraph3D/ 밖이어야 한다. 안에 두면 평평하게 쓰는 이 경로가
	// 콘텐츠 트리 규격(<YYYY>/<MM>/<DD>/)을 어겨 readPapersUnder가 건너뛴다.
	static async writeTestPaper(paper: Paper, folder: string): Promise<void> {
		await File.writePaperAt(paper, `${folder}/${File.baseNoteName(paper.title, paper.sourceId)}`);
	}

	// 저장 경로가 title을 포함(resolvePaperPath)하므로, arXiv 개정판 등으로 제목이 바뀌면
	// writePaperAt이 "새 경로에 파일이 있는가"만으로 기존 여부를 판단해 옛 파일을 못 찾고
	// 새 파일을 만든다 — createdAt/임베딩/extra/collectedApis 이력이 통째로 고아가 된다
	// (실제 재현됨). 제목이 바뀌는 유일한 지점(API.Refresh 구현체가 콘텐츠를 재조회하는
	// 경로)에서, 덮어쓰기 직전의 옛 Paper와 새 Paper를 넘기면 옛 경로의 .json/.md를 새
	// 경로로 옮겨 이력이 그대로 이어지게 한다. 두 경로가 같으면(제목이 안 바뀌었으면)
	// 아무 일도 안 한다. 새 경로에 이미 파일이 있으면(드문 충돌) 덮어쓰지 않고 그대로
	// 둔다 — writePaperAt의 기존 동작(그 자리에 새로 만듦)에 맡긴다.
	//
	// ⚠️ 알려진 제약(2026-08-17, docs/devLog/013-refresh.md 후속 참고): 사용자가 파일
	// 탐색기에서 .json/.md 파일명만 직접 바꾸고 내용(title 필드)은 안 건드리면, 이 함수는
	// 그 상황을 감지 못 한다 — API.Refresh 전후로 paper.title이 안 바뀌었으니(콘텐츠는
	// 그대로) "제목이 안 바뀌었다"고 판단해 rename 자체가 안 걸린다. 그 결과 사용자가
	// 옮긴 파일은 고아로 남고 원래(내용 기준) 경로에 새 파일이 생긴다. 일반적으로
	// 고치려면 sourceId -> 실제 경로 인덱스가 필요한데(경로 계산 실패 시 전체 스캔은
	// 대규모 코퍼스에서 비용이 크고, 별도 인덱스 파일은 그 자체가 또 어긋날 수 있는 새
	// 상태다), 이번 수정 범위보다 훨씬 무거워 의도적으로 범위 밖으로 남겨뒀다.
	static async renamePaperFiles(oldPaper: Paper, newPaper: Paper): Promise<void> {
		const oldBase = File.resolvePaperPath(oldPaper);
		const newBase = File.resolvePaperPath(newPaper);
		if (oldBase === newBase) {
			return;
		}
		for (const ext of ['.json', '.md']) {
			const oldPath = `${oldBase}${ext}`;
			const newPath = `${newBase}${ext}`;
			const oldFile = File.vault.getAbstractFileByPath(oldPath);
			const newFileExists = File.vault.getAbstractFileByPath(newPath) !== null;
			if (oldFile instanceof TFile && !newFileExists) {
				await File.vault.rename(oldFile, newPath);
			}
		}
	}

	private static async writePaperAt(paper: Paper, base: string): Promise<void> {
		const jsonPath = `${base}.json`;
		const mdPath = `${base}.md`;

		const existingJson = await File.readVaultText(jsonPath);
		const existing = existingJson ? (JSON.parse(existingJson) as StoredPaperFile) : null;
		const createdAt = existing ? existing.createdAt : Date.now();

		// 같은 sourceId(같은 파일 경로)로 다른 구독이 다시 써도, 먼저 저장된 구독의
		// collectedApis/collectedQueries가 이번 값으로 덮이지 않도록 병합한다. 병합 없이
		// 그대로 덮으면 "이 논문이 어느 구독들에 걸렸는가"라는 정보가 매번 마지막에 쓴
		// 구독 하나로 조용히 줄어든다.
		File.mergeCollectionSources(paper, existing?.paper);

		// 백스톱: run()이 이미 저장본을 확인해 성공한 임베딩은 재사용하지만(가장 흔한 경로),
		// repair()나 앞으로 생길 다른 호출자가 그 확인을 건너뛰고 실패 상태로 다시 저장하면
		// 멀쩡했던 벡터가 빈 값으로 덮인다 — 실제로 재현됨. 들어온 값이 실패인데 기존이
		// 성공이면 기존 임베딩을 지키고, 그 외(기존도 실패/없음)는 003의 (b)대로 그대로 둔다.
		if (!paper.embeddingSucceeded && existing?.paper.embeddingSucceeded) {
			paper.embedding = existing.paper.embedding;
			paper.embeddingModel = existing.paper.embeddingModel;
			paper.embeddingSource = existing.paper.embeddingSource;
			paper.embeddingSucceeded = true;
		}

		// 백스톱: 미들웨어가 채운 extra(요약·클러스터 라벨 등)를 지킨다. API에서 갓 받아온
		// Paper의 extra는 비어 있어서, 그대로 저장하면 전에 붙여둔 요약이 통째로 지워진다.
		// 수집 경로는 CollectAndSave.prefillFromStore가 저장본의 extra를 미리 얹어 이 상황을
		// 만들지 않지만, 저장하는 곳은 그 경로만이 아니다(보정·설정탭 테스트 버튼, 앞으로
		// 생길 호출자). 위 임베딩 백스톱과 같은 이유로 마지막 길목인 여기서 한 번 더 막는다.
		//
		// 키 단위로 합치되 이번에 들어온 값이 이기므로, 미들웨어가 요약을 새로 계산해 덮는
		// 것은 정상 동작한다. 다만 이 규칙 때문에 키를 지우는 것은 불가능하다 — 지워야 한다면
		// 미들웨어가 저장본을 읽어 직접 다시 써야 한다.
		// (extra가 없던 시절 파일은 existing.paper.extra가 undefined인데, Object.assign이
		// 그냥 건너뛰므로 들어온 값만 남아 지금과 같다.)
		paper.extra = Object.assign(new ExtraData(), existing?.paper.extra, paper.extra);

		// 재스캔(4일 보정 창)이 같은 논문을 다시 저장 대상으로 올려도, 위 세 단계(출처
		// 병합·임베딩 보존·extra 보존)를 거친 뒤 실제 값이 기존과 완전히 같으면 디스크에 다시 쓰지
		// 않는다. 무조건 쓰면 (1) 내용이 똑같은데 파일 감시자/동기화가 매번 깨어나고,
		// (2) updatedAt이 매번 지금 시각으로 갱신돼 "이 논문이 실제로 마지막으로 바뀐
		// 시점"이라는 정보 자체가 사라진다. 인용수 보강이나 새 구독의 출처 추가처럼 값이
		// 하나라도 실제로 다르면 정상적으로 다시 쓴다.
		//
		// ⚠️ 이 판단은 .json 값만 본다 — .md가 실제로 디스크에 있는지, 마커 안쪽(초록 자리)이
		// 지금 초록과 같은지는 별개로 확인해야 한다. .json 값이 안 바뀌었다고 .md까지 최신이라는
		// 보장은 없다 — 사용자가 마커 안쪽을 고치거나(초록이 아닌 다른 텍스트로) .md 자체를
		// 지운 경우, 그 상태가 .json이 실제로 바뀔 때까지 무기한 방치된다(실제로 재현됨).
		// .md는 "마커 안쪽은 항상 최신 초록을 반영한다"는 계약이라, 그 계약이 깨져 있으면
		// .json 값과 무관하게 .md만이라도 다시 써야 한다.
		const existingMd = await File.readVaultText(mdPath);
		const userBody = existingMd ? File.parseUserBody(existingMd) : '';
		const expectedMd = File.renderNote(paper, userBody);
		const mdUpToDate = existingMd === expectedMd;

		const jsonUnchanged = existing !== null && File.papersEqual(paper, existing.paper);
		if (jsonUnchanged && mdUpToDate) {
			return;
		}

		if (!jsonUnchanged) {
			const wrapper: StoredPaperFile = {
				schemaVersion: File.SCHEMA_VERSION,
				paper,
				createdAt,
				updatedAt: Date.now(),
			};
			await File.writeVaultText(jsonPath, JSON.stringify(wrapper, null, 2));
		}
		if (!mdUpToDate) {
			await File.writeVaultText(mdPath, expectedMd);
		}
	}

	// paper.collectedApis/collectedQueries에 existingPaper가 이미 가지고 있던 (api, query)
	// 쌍을 합친다(paper를 직접 수정). 두 배열은 같은 인덱스가 한 쌍이라는 불변식을 유지해야
	// 하므로, 항상 이 함수를 통해서만 합친다 — 각자 밀거나 당기면 인덱스가 어긋난다.
	// 중복 판정은 (apiName, searchType, query) 조합 — 같은 구독이 다시 써도 항목이
	// 늘어나지 않는다. 예전 스키마 파일(collectedApis 없음)은 빈 배열로 취급한다.
	private static mergeCollectionSources(paper: Paper, existingPaper: Paper | undefined): void {
		const existingApis = existingPaper?.collectedApis ?? [];
		const existingQueries = existingPaper?.collectedQueries ?? [];
		if (existingApis.length === 0) {
			return;
		}

		const seen = new Set(
			paper.collectedApis.map(
				(api, i) => `${api}:${paper.collectedQueries[i]?.searchType}:${paper.collectedQueries[i]?.query}`,
			),
		);
		for (let i = 0; i < existingApis.length; i += 1) {
			const api = existingApis[i];
			const query = existingQueries[i];
			if (!api || !query) {
				continue;
			}
			const key = `${api}:${query.searchType}:${query.query}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			paper.collectedApis.push(api);
			paper.collectedQueries.push(query);
		}
	}

	// writePaperAt이 "다시 쓸 필요가 있는가"를 판단할 때 쓴다. JSON.stringify로 통째로
	// 비교하지 않는 이유: 두 값의 프로퍼티 삽입 순서가 우연히 달라지면(예: 다른 생성
	// 경로를 거친 Paper) 내용이 같아도 다르다고 오판할 수 있다. 필드별로 직접 비교하면
	// 그 위험이 없다. collectedApis/collectedQueries는 인덱스가 한 쌍이라는 불변식이 있어
	// 순서까지 같아야 진짜로 같은 것이다(정렬 없이 순차 비교).
	private static papersEqual(a: Paper, b: Paper): boolean {
		return (
			a.title === b.title &&
			a.abstract === b.abstract &&
			a.sourceId === b.sourceId &&
			a.publicationDate === b.publicationDate &&
			a.citationCount === b.citationCount &&
			a.citationsKnown === b.citationsKnown &&
			a.embeddingModel === b.embeddingModel &&
			a.embeddingSource === b.embeddingSource &&
			a.embeddingSucceeded === b.embeddingSucceeded &&
			File.arraysEqual(a.authors, b.authors) &&
			File.arraysEqual(a.references, b.references) &&
			File.arraysEqual(a.embedding, b.embedding) &&
			File.arraysEqual(a.collectedApis, b.collectedApis) &&
			File.searchQueriesEqual(a.collectedQueries, b.collectedQueries) &&
			File.extraEqual(a.extra, b.extra)
		);
	}

	// extra는 미들웨어가 필드를 늘려가는 자리라 위처럼 필드를 열거할 수 없다. 그래서 키를
	// 정렬해 맞춘 뒤 값끼리 비교한다 — 필드가 추가된 순서가 달라도 내용이 같으면 같은
	// 것이므로 객체를 통째로 JSON.stringify하지는 않는다(이유는 papersEqual 주석과 같다).
	// 이 비교가 빠지면 미들웨어가 채운 요약·클러스터 라벨이 "변경 없음"으로 판정돼
	// 저장되지 않고 사라진다.
	//
	// 값 타입을 가리지 않는다 — 미들웨어가 문자열(요약), 숫자(클러스터 번호), 배열, 중첩
	// 객체 무엇을 넣든 JSON 표현으로 비교한다(encodeExtra).
	//
	// 인자가 없을 수 있다: extra가 생기기 전에 저장된 파일에는 이 키가 아예 없어서,
	// JSON.parse로 되살린 저장본(papersEqual의 b)은 extra가 undefined다. 빈 객체로 보면
	// "저장본엔 아무것도 없었다"와 뜻이 같아 그대로 맞아떨어진다.
	private static extraEqual(a: ExtraData | undefined, b: ExtraData | undefined): boolean {
		const left = File.encodeExtra(a);
		const right = File.encodeExtra(b);
		return left.length === right.length && left.every((item, i) => item === right[i]);
	}

	// extra를 "저장하면 파일에 실제로 남을 모습"으로 바꾼다 — 키를 정렬한 `"키":값` 목록.
	// 정렬하는 이유는 extraEqual 주석 참고(필드가 추가된 순서에 흔들리지 않게).
	//
	// 값이 undefined이거나 함수면 JSON.stringify가 그 키를 통째로 빼므로 여기서도 뺀다.
	// 남겨두면 저장본과 영원히 달라져 매 저장마다 파일을 다시 쓰게 된다 — 미들웨어가
	// `extra.clusterId = map.get(id)`처럼 썼다가 못 찾으면 바로 이 상황이다.
	//
	// 키도 JSON.stringify로 감싸 인코딩이 겹치지 않게 한다(키에 ':'가 들어가도 안전).
	private static encodeExtra(extra: ExtraData | undefined): string[] {
		const source = (extra ?? {}) as Record<string, unknown>;
		const encoded: string[] = [];
		for (const key of Object.keys(source).sort()) {
			const value = JSON.stringify(source[key]);
			if (value !== undefined) {
				encoded.push(`${JSON.stringify(key)}:${value}`);
			}
		}
		return encoded;
	}

	private static arraysEqual<T>(a: T[], b: T[]): boolean {
		return a.length === b.length && a.every((v, i) => v === b[i]);
	}

	private static searchQueriesEqual(a: SearchQuery[], b: SearchQuery[]): boolean {
		return (
			a.length === b.length &&
			a.every((q, i) => q.searchType === b[i]?.searchType && q.query === b[i]?.query)
		);
	}

	// (apiName, querys) 조합의 신원 키. filterSubscriptions/removeSubscription이 이
	// 키로 "같은 구독인가"를 판정한다(둘 다 여러 후보를 Set으로 한 번에 걸러야 해서 문자열
	// 키가 편하다) — resolveSubscriptionCursor/hasDuplicateSubscription은 후보가 한둘뿐이라
	// 그냥 searchQueriesEqual로 직접 비교한다. 두 비교 방식 모두 "순서까지 같아야 같은
	// 구독"이라는 같은 정의를 따른다는 점만 어긋나지 않게 유지하면 된다.
	private static subscriptionKey(apiName: string, querys: SearchQuery[]): string {
		return JSON.stringify([apiName, querys.map((q) => [q.searchType, q.query])]);
	}

	// 등록된 구독(apis) 중 targets에 지정된 (apiName, querys)와 일치하는 것만 남긴다.
	// Backfill/Recent 실행 시 "이번엔 이 구독들만" 좁히는 타겟팅 기능이 쓴다 — 실제 구독
	// 인스턴스가 아니라 신원(문자열 키)만 넘겨받으므로, 호출자는 File.createApi 없이도
	// 어떤 구독을 원하는지 표현할 수 있다.
	static filterSubscriptions(
		apis: API[],
		targets: { apiName: string; querys: SearchQuery[] }[],
	): API[] {
		const keys = new Set(targets.map((t) => File.subscriptionKey(t.apiName, t.querys)));
		return apis.filter((api) => keys.has(File.subscriptionKey(api.apiName, api.querys)));
	}

	// 등록된 구독(apis) 중 target과 일치하는 것 하나만 제거한 나머지를 돌려준다.
	// ApiManagementModal의 「API 삭제」가 쓴다 — 그 카드 하나만 지워야 하는데, 기존
	// persistSubscriptions()로 처리하면 조건 1개 이상인 다른 모든 draft(그중엔 아직
	// 「저장」을 안 누른 미저장 편집도 있을 수 있다)까지 통째로 커밋해버리는 문제가 있었다.
	static removeSubscription(
		apis: API[],
		target: { apiName: string; querys: SearchQuery[] },
	): API[] {
		const key = File.subscriptionKey(target.apiName, target.querys);
		return apis.filter((api) => File.subscriptionKey(api.apiName, api.querys) !== key);
	}

	// 저장된 구독 중 (apiName, querys)가 정확히 일치하는 항목의 커서를 찾는다. 없으면 0.
	//
	// "조건을 고치는 순간 새 구독으로 본다"는 규칙의 구현 지점이다 — 구독의 신원은
	// UUID 같은 별도 필드가 아니라 (apiName, querys) 그 자체이므로, 저장 시점에 이전
	// 저장본과 내용이 완전히 같은 것만 같은 구독으로 인정해 커서를 이어받는다. 조건을
	// 하나라도 바꾸면 매칭이 실패해 0(새 구독)에서 시작하는데, recent 수집은 커서 유무와
	// 무관하게 recentRescanWindowMs 폭의 롤링 윈도우만 훑으므로(API.ts 참고) 이 손실의
	// 실제 비용은 없다 — 그 대가로 구독 편집 중 동시성 문제(예전 커서 스냅샷 되돌림)가
	// 구조적으로 사라진다.
	static resolveSubscriptionCursor(existingApis: API[], apiName: string, querys: SearchQuery[]): number {
		const match = existingApis.find(
			(a) => a.apiName === apiName && File.searchQueriesEqual(a.querys, querys),
		);
		return match ? match.updateTime : 0;
	}

	// 저장하려는 구독 목록 안에 (apiName, querys)가 정확히 같은 항목이 둘 이상 있는가.
	// 있으면 File.updateApiCursors의 `.find()`가 첫 매치만 골라 커서가 둘 중 하나로만
	// 갱신되는 모호함이 생긴다 — 저장 시점에 막아 애초에 그 상태가 만들어지지 않게 한다.
	static hasDuplicateSubscription(apis: { apiName: string; querys: SearchQuery[] }[]): boolean {
		for (let i = 0; i < apis.length; i += 1) {
			for (let j = i + 1; j < apis.length; j += 1) {
				const a = apis[i];
				const b = apis[j];
				if (a && b && a.apiName === b.apiName && File.searchQueriesEqual(a.querys, b.querys)) {
					return true;
				}
			}
		}
		return false;
	}

	// ── config 공통: encode/decode는 옵션(기본=평문 통과). Secret만 난독화 변환을 넘긴다.

	private static async readConfig<T>(
		name: string,
		revive: (raw: unknown) => T,
		fallback: () => T,
		decode: (text: string) => Promise<string> | string = (t) => t,
	): Promise<T> {
		const path = `${File.pluginDir}/${name}`;
		if (!(await File.vault.adapter.exists(path))) {
			return fallback();
		}
		const text = await decode(await File.vault.adapter.read(path));
		return revive(JSON.parse(text));
	}

	private static async writeConfig(
		name: string,
		data: unknown,
		encode: (text: string) => Promise<string> | string = (t) => t,
	): Promise<void> {
		const text = await encode(JSON.stringify(data, null, 2));
		await File.vault.adapter.write(`${File.pluginDir}/${name}`, text);
	}

	// ── 콘텐츠 트리 텍스트 I/O (.json/.md 공용) ─────────────────────────

	private static async readVaultText(path: string): Promise<string | null> {
		const f = File.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? File.vault.read(f) : null;
	}

	private static async writeVaultText(path: string, text: string): Promise<void> {
		const existing = File.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await File.vault.modify(existing, text);
			return;
		}
		const folder = path.slice(0, path.lastIndexOf('/'));
		if (folder && !File.vault.getAbstractFileByPath(folder)) {
			await File.vault.createFolder(folder).catch(() => {
				/* 이미 있으면 무시 (동시 생성 경쟁 대비) */
			});
		}
		await File.vault.create(path, text);
	}

	// ── 난독화 (하드코딩 키 XOR + base64). 진짜 암호화 아님(002.md). ──────

	private static obfuscate(plain: string): string {
		const key = File.OBFUSCATION_KEY;
		const bytes = new TextEncoder().encode(plain);
		let binary = '';
		for (let i = 0; i < bytes.length; i += 1) {
			binary += String.fromCharCode((bytes[i] as number) ^ key.charCodeAt(i % key.length));
		}
		return btoa(binary);
	}

	private static deobfuscate(cipher: string): string {
		const key = File.OBFUSCATION_KEY;
		const binary = atob(cipher);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i) ^ key.charCodeAt(i % key.length);
		}
		return new TextDecoder().decode(bytes);
	}

	// ── 파일명 규칙 (기존 프로젝트 filename.ts 로직 흡수) ────────────────

	// `.json`/`.md` 쌍이 공유하는 확장자 없는 전체 경로:
	// `PaperGraph3D/<YYYY>/<MM>/<DD>/<정제한 title> (<localId>)`.
	private static resolvePaperPath(paper: Paper): string {
		return `${File.PAPER_ROOT}/${File.publicationDir(paper)}/${File.baseNoteName(paper.title, paper.sourceId)}`;
	}

	// 논문의 연/월/일 폴더. 기존은 publicationYear를 썼으나 새 Paper는 이를 제거해
	// publicationDate(ISO)에서 연도까지 파생한다. 유효한 날짜가 없으면 'unknown'.
	// 모양 정규식만으로는 2026-03-50 같은 값이 통과해 달력에 없는 폴더가 생겼다(12번) —
	// 달력 유효성과 미래 여부까지 본다. 어느 쪽이든 실패하면 'unknown'으로 보낸다.
	private static publicationDir(paper: Paper): string {
		if (isUsablePaperDate(paper.publicationDate)) {
			return `${paper.publicationDate.slice(0, 4)}/${paper.publicationDate.slice(5, 7)}/${paper.publicationDate.slice(8, 10)}`;
		}
		return 'unknown';
	}

	// 제목(NFC 정규화, 금지/제어문자 제거, 공백 정리, 길이 제한) + 괄호 안 provider-local id,
	// 예: 'Attention Is All You Need (2401.12345)'. 제목이 없으면 sourceId 정제로 폴백.
	private static baseNoteName(title: string, sourceId: string): string {
		const cleanTitle = title
			.normalize('NFC')
			.replace(ILLEGAL_CHARS, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, MAX_TITLE_LENGTH)
			.replace(/[ .]+$/g, '');
		if (cleanTitle.length === 0) {
			return File.sanitizeStem(sourceId);
		}
		const localId = sourceId.slice(sourceId.indexOf(':') + 1);
		return File.sanitizeStem(`${cleanTitle} (${localId})`);
	}

	// 금지 문자 -> '_', 뒤쪽 점/공백 정리. 되돌릴 수 없음 — 진짜 키는 콘텐츠의 sourceId.
	private static sanitizeStem(raw: string): string {
		let stem = raw.replace(ILLEGAL_CHARS, '_').replace(/[ .]+$/g, '');
		if (stem.length === 0) {
			stem = '_';
		}
		if (WINDOWS_RESERVED.test(stem)) {
			stem = `_${stem}`;
		}
		return stem;
	}

	// ── .md 렌더링/파싱 (기존 프로젝트 note.ts 로직 흡수) ────────────────

	// 관리 영역(frontmatter + pg3d 마커 본문) 뒤에 사용자 자유 본문을 그대로 이어붙인다.
	private static renderNote(paper: Paper, previousUserBody: string): string {
		return `---\n${File.renderFrontmatter(paper)}\n---\n${NOTE_BEGIN}\n${paper.abstract}\n${NOTE_END}\n${previousUserBody}`;
	}

	// schemaVersion/타임스탬프/임베딩 벡터는 .json에만. references는 읽기 좋게 미러링.
	// 문자열 값은 JSON.stringify로 따옴표 처리한다(= 유효한 YAML 이중따옴표 스칼라라
	// 제목의 ':' 등 특수문자가 있어도 안전).
	private static renderFrontmatter(paper: Paper): string {
		const lines: string[] = [`title: ${JSON.stringify(paper.title)}`];
		if (paper.authors.length === 0) {
			lines.push('authors: []');
		} else {
			lines.push('authors:');
			for (const author of paper.authors) {
				lines.push(`  - ${JSON.stringify(author)}`);
			}
		}
		// 새 Paper는 publicationYear를 제거 → publicationDate(ISO)에서 연도 파생.
		if (isUsablePaperDate(paper.publicationDate)) {
			lines.push(`publicationYear: ${Number(paper.publicationDate.slice(0, 4))}`);
		}
		if (paper.publicationDate) {
			lines.push(`publicationDate: ${JSON.stringify(paper.publicationDate)}`);
		}
		lines.push(`citationCount: ${paper.citationCount}`);
		// 외향 인용 3상태(citationsKnown 기준): 미확인 null / 확인+없음 [] / 확인+있음 목록.
		if (!paper.citationsKnown) {
			lines.push('references: null');
		} else if (paper.references.length === 0) {
			lines.push('references: []');
		} else {
			lines.push('references:');
			for (const reference of paper.references) {
				lines.push(`  - ${JSON.stringify(reference)}`);
			}
		}
		lines.push(`pg3d_sourceId: ${JSON.stringify(paper.sourceId)}`);
		const url = File.paperUrl(paper.sourceId);
		if (url !== undefined) {
			lines.push(`url: ${JSON.stringify(url)}`);
		}
		return lines.join('\n');
	}

	// 표준 웹 URL을 sourceId에서 파생(저장 안 함). provider별 규칙은 PAPER_URL_BUILDERS
	// 레지스트리에서 조회한다 — 알 수 없는 provider면 undefined(frontmatter에서 줄 생략).
	private static paperUrl(sourceId: string): string | undefined {
		const separator = sourceId.indexOf(':');
		if (separator <= 0) {
			return undefined;
		}
		const provider = sourceId.slice(0, separator);
		const localId = sourceId.slice(separator + 1);
		if (localId.length === 0) {
			return undefined;
		}
		const build = PAPER_URL_BUILDERS[provider];
		return build ? build(localId) : undefined;
	}

	// 기존 .md에서 사용자 자유 본문(pg3d 마커 뒤)만 추출해 보존한다. 앞쪽 frontmatter
	// 블록은 내용 파싱 없이 건너뛴다. 우리 마커가 없으면(우리 노트가 아니면) 남은 내용을
	// 그대로 보존한다.
	private static parseUserBody(text: string): string {
		let rest = text;
		if (rest.startsWith('---\n')) {
			const end = rest.indexOf('\n---', 4);
			if (end !== -1) {
				rest = rest.slice(end + 4).replace(/^\n/, '');
			}
		}
		const endMarker = rest.indexOf(NOTE_END);
		if (endMarker !== -1) {
			return rest.slice(endMarker + NOTE_END.length).replace(/^\n/, '');
		}
		return rest;
	}
}
