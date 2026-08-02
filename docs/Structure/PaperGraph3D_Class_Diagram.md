# PaperGraph3D 클래스 다이어그램

Class PaperGraph3D {
	+ CollectAndSave collectflow 	// 객체
	+ VisualizationFlow visualflow 	// 객체
	+ EventListener eventListener 	// EventListener
	+ TaskManager taskManager	// Task manager
	+ init()					// 초기화 함수 (PaperStore/SecretStore는 static이라 필드로 들고 있지 않고, init()에서 PaperStore.init(vault)/SecretStore.init(this)만 호출)
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

## 어댑터 (Obsidian 전용, src/adapter/)

Class PaperStore {
	// paper.json + paper.md(vault 노트)를 읽고 쓰는 클래스. 저장 매체는 Vault로 확정.
	// Read -> paper.json / Write -> paper.json, paper.md (각각 논문에 해당하는 json과 md파일)
	// 내부 함수/변수들 static으로 정의해서 객체 선언 없이 사용할 수 있도록.
}

Class SecretStore {
	// Secret.json/Subscriptions.json에 해당하는 보안 정보를 읽고 쓰는 클래스. Vault 파일이
	// 아니라 Obsidian 플러그인 데이터(Plugin.saveData/loadData)에 암호화해서 저장한다.
	// Read/Write -> Secret, Subscriptions
	// 내부 함수/변수들 static으로 정의해서 객체 선언 없이 사용할 수 있도록.
	// 암호화 키 출처는 미정 (docs/plan/primary_plan.md 참고).
}

## 설계 참고

이 문서는 클래스/인터페이스의 현재 구조만 다룬다. 왜 이렇게 바뀌었는지에 대한 변경
이력·논의 배경은 [`docs/plan/primary_plan.md`](../plan/primary_plan.md)에 기록한다.

- **프레임워크화의 의미**: PaperGraph3D는 멀티플랫폼 분리가 아니라, 개발자가 미들웨어/태스크를
	얹어 기능을 확장할 수 있는 "확장 가능한 옵시디언 플러그인"이다.
- **PaperGraph3D 진입점**: PaperGraph3D 클래스 자체가 Obsidian의 Plugin을 직접 상속한다
	(별도 어댑터로 감싸지 않음). `src/main.ts`가 곧 PaperGraph3D.
- **폴더 구조**: `src/collect/`(수집), `src/visualize/`(시각화), `src/common/`(공통,
	Obsidian API를 모르는 순수 TS), `src/adapter/`(Obsidian 전용: SettingTab,
	VisualizationView, PaperStore, SecretStore).
- **Paper의 (+)/(-) 표기**: (+) = 새 Paper 클래스에 추가하는 필드, (-) = 새 Paper 클래스에서
	빼는 필드 (기존 프로젝트에 이미 있었는지 여부와는 무관한 표기임). 발행 년도(-)는
	제외됐고, `citationsKnown`/`collectionMethod`/`embeddingSucceeded`(+)가 추가됐다.



























