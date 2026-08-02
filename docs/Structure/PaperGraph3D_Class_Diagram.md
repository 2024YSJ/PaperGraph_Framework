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



























