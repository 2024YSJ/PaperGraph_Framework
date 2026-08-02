# PaperGraph3D 클래스 다이어그램

Class PaperGraph3D {
	+ CollectAndSave collectflow 	// 객체
	+ VisualizationFlow visualflow 	// 객체
	+ EventListener eventListener 	// EventListener
	+ TaskManager taskManager	// Task manager
	+ init()					// 초기화 함수 (File은 static이라 필드로 들고 있지 않고, init()에서 File.init(vault)만 호출)
}

## 수집

Class CollectAndSave {
	+ Subscriptions sub 		// 구독 정보 객체
	+ Embedding embedding		// 임베딩 관련 객체
	+ Middleware middlewares 	// middleware list
	+ setMiddleware() 			// 미들웨어 등록
	+ run()						// 수집 & 저장 작업 수행 backfill과 최근 논문 수집 인자로 구별해서 수행하도록 구현, 내부적으로 if문 사용.
}

Class Subscriptions {
	+ int updateTime			// 갱신 시점	
	+ Secret secret 			// 보안 객체
	+ API apis 					// api list
}

interface API {
	+ SearchQuery querys 		// 검색 정보 list
	+ SearchBase() 				// API 호출 함수
	+ SearchRecentPaper()		// 최근 Nh 논문 수집 함수
	+ Backfill()				// backfill 함수
	...							// 각종 필요한 함수들
}

interface SearchQuery {
	// 검색에 필요한 각종 데이터들
	+ string searchType			// 검색하는 방법
	+ string query 				// 검색 쿼리
	...							// 각종 필요한 함수들
}

Class Paper {
	// 현재 있는 paper 객체에다가
	발행 년도 (-)
	어떤 방법으로 수집된 것인가 (+)
	임베딩 성공 실패 확인 인자 T/F로 교체
	인용수가 확인된 논문인가 (+)
}

Class Embedding {
	// 임베딩에 필요한 데이터 및 함수 위치
}

int run() {
	모든 데이터 수집 -> 미들웨어 all -> loop { 임베딩 -> 미들웨어 forEach -> 데이터 저장}
	// 이런 메인 흐름과 관련된 함수를 run 함수가 아닌 세부 함수에서 호출 하지 말것.
	// 데이터 수집후에 paper list를 반환하지 않고 데이터 수집 함수에서 미들웨어 호출 		<- 하면 안됨
	// 데이터 수집후 paper list를 반환하고 run 함수에서 미들웨어에 인자로 list를 줘서 호출 	<- 좋은 방식
}

## 시각화

Class VisualizationFlow {
	+ PCA pca					// pca 객체
	+ Visualization viusal 		// 시각화 객체
	+ Middleware middlewares 	// middleware list
	+ setMiddleware() 			// 미들웨어 등록
	+ run()						// 수집 & 저장 작업 수행
}

Class PCA {
	// pca에 필요한 데이터와 함수
}

Class Visualization {
	+ GraphData graph
	// 각종 함수들
	+ init()					// 시각화 초반 작업하는 함수.
	+ render() 					// 최종적으로 그래프를 그리는 함수
}

Class GraphData {
	// Graph를 그릴 때 사용되는 데이터
}

int run() {
	json 파일 읽기 -> PCA -> 시각화 일부 작업들 -> 미들웨어 -> 시각화 마무리
	// 이런 메인 흐름과 관련된 함수를 run 함수가 아닌 세부 함수에서 호출 하지 말것.
}

## 공통

interface Middleware {
	+ string type 				// 이 미들웨어가 foreach인지 all인지 visual에 사용되는 것인지
	+ run()						// 실행 시키는 함수 type따라서 주어지는 인자가 다름
	... 						// 추가 가능한 각종 함수와 데이터 하지만 private임
}


Class File {
	// 파일을 읽고 쓰는 작업을 해주는 클래스
	// Read 해야하는 파일 -> Secret.json, Subscriptions.json, paper.json
	// Write 해야하는 파일 -> Secret.json, Subscriptions.json, paper.json, paper.md (각각 논문에 해당하는 json과 md파일)
	// 내부 함수들 static으로 정의해서 객체 선언 없이 사용할 수 있도록.
	// 내부 변수들도 static 상수로 선언해서 객체 선언 없이 사용할 수 있도록.
}


Class EventListener {
	+ events 					// event list
		++ string eventName			// 발동할 이벤트 이름
		++ string TaskName			// 실행할 task 이름
	+ checking()				// 인자에 해당하는 task 실행
	+ setEventListener()		// eventlistener 등록 함수
}

Class TaskManager {
	+ Task tasks				// Task list
	+ runTask()					// Task 실행 함수
	+ setTask()					// Task 등록 함수
}


Class Task {
	+ string taskName			// task 이름
	+ func 						// 사용자가 등록한 함수.
}

## 2026-08-02 합의 사항 (성진, 빈 클래스 생성 작업 중 확정)

- **프레임워크화의 의미**: PaperGraph3D는 멀티플랫폼 분리가 아니라, 개발자가 미들웨어/태스크를
	얹어 기능을 확장할 수 있는 "확장 가능한 옵시디언 플러그인"으로 간다.
- **File**: 저장 형식(Secret.json/Subscriptions.json 실 파일 vs Obsidian data.json)은 여전히
	미정. 그래서 File은 `interface`로 추상화하고, Obsidian 기반 구현체는
	`src/adapter/ObsidianFileAdapter.ts`에 별도로 둔다. 코어 클래스들은 Obsidian API를
	모르는 순수 TS로 작성한다.
	- (2026-08-02 추가) `ObsidianFileAdapter`는 다이어그램의 `Class File` 정의대로
		객체 선언 없이 static 멤버로만 구성했다. `PaperGraph3D`도 더 이상 `files` 인스턴스
		필드를 들고 있지 않고, `init()`에서 `ObsidianFileAdapter.init(vault)`로 vault
		참조만 등록한 뒤 `ObsidianFileAdapter.readSecret()`처럼 바로 호출한다.
- **PaperGraph3D 진입점**: PaperGraph3D 클래스 자체가 Obsidian의 Plugin을 직접 상속한다
	(별도 어댑터로 감싸지 않음). `src/main.ts`가 곧 PaperGraph3D.
- **폴더 구조**: `src/collect/`(수집), `src/visualize/`(시각화), `src/common/`(공통),
	`src/adapter/`(Obsidian 전용 UI/File 구현체).
- **Paper의 (+)/(-) 표기**: (+) = 새 Paper 클래스에 추가하는 필드, (-) = 새 Paper 클래스에서
	빼는 필드 (기존 프로젝트에 이미 있었는지 여부와는 무관한 표기임).
	- ⚠️ `발행 년도 (-)` 표기대로 publicationYear를 새 Paper에서 제외했다. 다만 기존
		PaperGraph3D 프로젝트에서는 이 필드가 그래프 z축/backfill 윈도우/refresh 판단 등에
		널리 쓰였다. **우빈은 Paper 구현 전에 이 제거가 정말 맞는지 팀과 한 번 더 확인할 것.**
	- 새로 추가된 필드: `citationsKnown`(인용수 확인 여부), `collectionMethod`(수집 방법,
		'recent' | 'backfill'), `embeddingSucceeded`(임베딩 성공/실패 T/F — 기존
		embedding/embeddingFailure 조합을 대체).



























