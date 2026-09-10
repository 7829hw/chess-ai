# Chess vs Stockfish

브라우저 안에서만 동작하는 정적 체스 시뮬레이터입니다.
Stockfish 18을 **WebAssembly + Web Worker**로 실행하므로 백엔드, 엔진 API,
WebSocket 서버가 전혀 없습니다. Nginx는 정적 파일 서빙만 담당합니다.

핵심 UI 규칙은 일반적인 체스 UI와 반대입니다.

> **사용자의 진영은 항상 화면 위쪽, Stockfish의 진영은 항상 화면 아래쪽입니다.**
> White를 선택하면 White가 위쪽, Black을 선택하면 Black이 위쪽에 표시됩니다.

---

## 실행 방법

필요한 것은 Docker뿐입니다. 프로젝트 루트에서:

```bash
docker compose up --build
```

접속 URL:

```
http://localhost:8080
```

컨테이너를 백그라운드로 띄우거나 정리할 때:

```bash
docker compose up --build -d     # 백그라운드 실행
docker compose logs -f chess     # 로그 확인
docker compose down              # 정리
```

포트를 바꾸려면 `docker-compose.yml`의 `ports`를 `"9090:80"` 처럼 수정하세요.

Docker 없이 확인하고 싶다면 정적 서버 아무거나로도 동작합니다. 단
`file://` 로는 동작하지 않습니다(ES module, Web Worker, WASM 모두 HTTP origin이
필요합니다). 이때는 `.wasm`의 MIME type이 `application/wasm`으로 나가는지
직접 확인해야 합니다.

```bash
cd public && python3 -m http.server 8080
```

---

## 프로젝트 구조

```
chess-ai/
├── docker-compose.yml               # chess 서비스 1개, 8080 -> 80
├── Dockerfile                       # nginx:1.29-alpine + 정적 파일 + 사전 gzip
├── nginx.conf                       # /etc/nginx/conf.d/default.conf 로 복사됨
├── .dockerignore
├── README.md
├── tests/                           # 선택 사항: 브라우저 테스트 (아래 참고)
│   ├── logic.js
│   ├── integration.js
│   └── run.sh
└── public/                          # 이 디렉터리가 그대로 웹 루트
    ├── index.html
    ├── favicon.svg
    ├── css/
    │   └── style.css
    ├── js/
    │   ├── constants.js             # 상태 enum, 난이도 프리셋, 매직 넘버 모음
    │   ├── engine.js                # Stockfish Worker + UCI 통신 (DOM 의존 없음)
    │   ├── board.js                 # 8x8 렌더링, 클릭/드래그 입력 (규칙 판단 없음)
    │   ├── game.js                  # 상태 머신 + chess.js 규칙 + 진행 흐름
    │   ├── promotion.js             # 프로모션 선택 모달
    │   └── app.js                   # DOM 바인딩과 부트스트랩
    ├── lib/
    │   ├── chess.js                 # chess.js 1.4.0 (ESM 빌드)
    │   ├── chess.js.map
    │   └── chess.LICENSE.txt
    ├── fonts/
    │   ├── noto-sans-symbols-2-chess.woff2      # 체스 글리프 12자만 서브셋 (2.8 KB)
    │   └── noto-sans-symbols-2.LICENSE.txt
    └── stockfish/
        ├── stockfish-18-lite-single.js          # Worker 스크립트 (21 KB)
        ├── stockfish-18-lite-single.wasm        # 엔진 바이너리 (7.3 MB)
        └── COPYING.txt                          # GPL-3.0 전문
```

### 레이어 분리

| 파일 | 아는 것 | 모르는 것 |
|---|---|---|
| `engine.js` | UCI 문자열, Worker 수명주기 | 체스 규칙, DOM |
| `board.js` | DOM, 포인터 입력, orientation | 체스 규칙, 엔진 |
| `game.js` | 규칙(chess.js), 상태 머신 | DOM 셀렉터 |
| `app.js` | DOM 셀렉터, 표시 문자열 | 규칙, UCI |

`board.js`는 합법성을 스스로 판단하지 않고 주입된
`legalTargetsFor(square)` 콜백에 물어봅니다. 덕분에 규칙 판단은
`game.js` → chess.js 한 곳에만 존재합니다.

---

## Stockfish WASM 구조

사용 빌드: [`stockfish.js`](https://github.com/nmrugg/stockfish.js) 18.0.8의
**`stockfish-18-lite-single`** — 즉 **단일 스레드(single-threaded), lite(NNUE 내장)** 빌드입니다.

```
main thread                          Web Worker
-----------                          ----------
engine.js
  new Worker(".../stockfish-18-lite-single.js?v=1.0.0#<wasm URL>")
  postMessage("uci")            -->  UCI 명령 큐
                                <--  "uciok"
  postMessage("isready")        -->
                                <--  "readyok"
  postMessage("ucinewgame")     -->
  postMessage("setoption ...")  -->
  postMessage("position startpos moves e2e4 e7e5")
  postMessage("go depth 11 movetime 800")
                                <--  "info depth 9 score cp 31 ..."
                                <--  "bestmove g1f3 ponder b8c6"
```

### 왜 단일 스레드 빌드인가 (COOP/COEP를 넣지 않은 이유)

멀티스레드 Stockfish WASM은 `SharedArrayBuffer`를 쓰기 때문에
cross-origin isolation이 필수이고, 그러면 다음 헤더가 필요합니다.

```nginx
add_header Cross-Origin-Opener-Policy   same-origin  always;
add_header Cross-Origin-Embedder-Policy require-corp always;
```

`require-corp`는 **모든** 하위 리소스가 CORP 헤더를 갖도록 요구하므로,
iframe 임베드나 외부 리소스 추가 시 조용히 깨지기 쉽습니다.
이 프로젝트는 그 복잡도를 감수할 이유가 없어서 `SharedArrayBuffer`를
전혀 쓰지 않는 단일 스레드 빌드를 선택했고, **두 헤더는 적용하지 않았습니다.**
`nginx.conf`에 주석으로 남겨 두었으니 멀티스레드 빌드로 교체할 때 활성화하세요.

단일 스레드라도 `Skill Level`과 depth/movetime 상한 안에서는 체감 차이가 없습니다.

### WASM 경로가 어긋나지 않게 하는 방법

`stockfish-18-lite-single.js`는 Worker 안에서 자기 위치를 기준으로
`.js` → `.wasm` 을 유추합니다. 이 방식은 쿼리 스트링이나 sub-path 호스팅에서
헷갈릴 수 있으므로, `engine.js`는 **wasm 절대 URL을 Worker URL의 fragment로
직접 넘겨** 모호함을 없앱니다.

```js
const WORKER_SCRIPT_URL = new URL('../stockfish/stockfish-18-lite-single.js', import.meta.url);
const WORKER_WASM_URL   = new URL('../stockfish/stockfish-18-lite-single.wasm', import.meta.url);
// -> ".../stockfish-18-lite-single.js?v=1.0.0#<encoded wasm URL>"
```

경로가 `import.meta.url` 기준이므로 앱을 `/chess/` 같은 sub-path에 올려도
그대로 동작합니다. `?v=<APP_VERSION>`은 Worker 스크립트의 캐시 무효화용이며
`constants.js`의 `APP_VERSION`을 올리면 갱신됩니다.

---

## White/Black orientation 처리 방법

보드는 "**어떤 색이 아래쪽인가**" 하나만 입력으로 받습니다.

```js
// game.js
this.#board.setOrientation(this.engineColor);   // = oppositeColor(userColor)
```

사용자가 위쪽이어야 하므로 아래쪽에는 항상 **Stockfish의 색**이 옵니다.
`board.js`는 그 값으로 64칸의 DOM 순서를 다시 정렬합니다.

| 사용자 | 아래쪽 색 | 위→아래 rank | 좌→우 file | 화면 위쪽 |
|---|---|---|---|---|
| White | Black | `1 → 8` | `h → a` | White (사용자) |
| Black | White | `8 → 1` | `a → h` | Black (사용자) |

즉 사용자가 White일 때 보드는 통상 시점에서 180° 회전한 상태입니다
(rank가 증가하는 방향으로 내려가고 file은 역순). 좌표 라벨도 같은 배열에서
계산하므로 항상 일치합니다.

`New Game`을 누를 때마다 orientation이 다시 계산되고, 게임 도중 진영 버튼을
누르면 "New Game을 눌러야 적용된다"는 안내가 표시됩니다. 아직 한 수도 두지
않았다면 즉시 새 게임으로 적용됩니다.

---

## 난이도 조절 방법

`constants.js`의 프리셋 한 곳에서 관리합니다.

| 난이도 | `Skill Level` | `go depth` | `go movetime` |
|---|---|---|---|
| Beginner | 1 | 5 | 300 ms |
| **Medium (기본값)** | **8** | **11** | **800 ms** |
| Hard | 20 | 16 | 2000 ms |

* `Skill Level`(0–20)은 Stockfish가 **일부러 최선 수를 피하도록** 하는 공식 옵션이라
  단순히 시간을 줄이는 것보다 자연스럽게 약해집니다.
* `depth`와 `movetime`을 **함께** 넘겨 어느 쪽이든 먼저 도달하면 탐색이 끝나므로,
  최악의 경우에도 브라우저가 몇 초 이상 붙잡히지 않습니다.
* `Threads`는 1로 고정(단일 스레드 빌드), `Hash`는 16 MB로 낮게 잡아 WASM 메모리를 절약합니다.
* 난이도 변경은 게임 중에도 가능하며, 탐색 중에 옵션을 밀어넣지 않고
  **다음 탐색 직전에** 반영합니다.

---

## 사용한 JS 라이브러리

| 라이브러리 | 버전 | 라이선스 | 용도 |
|---|---|---|---|
| [chess.js](https://github.com/jhlywa/chess.js) | 1.4.0 (ESM) | BSD-2-Clause | 합법 수 생성, 체크/메이트/스테일메이트/캐슬링/앙파상/프로모션/반복수 판정, SAN·FEN |
| [stockfish.js](https://github.com/nmrugg/stockfish.js) | 18.0.8 (`lite-single`) | **GPL-3.0** | 체스 엔진 (WASM) |
| [Noto Sans Symbols 2](https://github.com/notofonts/symbols) | 서브셋 | SIL OFL 1.1 | 체스 기물 글리프 (U+2654–U+265F) |

보드 UI 라이브러리는 쓰지 않았습니다. orientation 반전 요구사항을 정확히
제어하기 위해 `board.js`에 직접 구현했습니다. **CDN 의존성은 0개**이며
모든 런타임 파일이 저장소와 이미지 안에 포함되어 있습니다.

### 기물 렌더링

기물은 이미지가 아니라 **번들된 폰트 글리프 2겹**으로 그립니다.

```css
.piece::before { content: var(--glyph-solid);   color: var(--piece-fill); }  /* 채워진 몸통 */
.piece::after  { content: var(--glyph-outline); color: var(--piece-edge); }  /* 윤곽 + 내부 디테일 */
```

`U+265A–U+265F`(채워진 글리프)와 `U+2654–U+2659`(윤곽 글리프)는 같은 외곽선을
공유하므로 정확히 겹칩니다. 시스템 심볼 폰트에 의존하면 플랫폼마다 기물 모양이
달라지므로, 해당 12자만 남긴 **2.8 KB 서브셋 폰트를 self-host** 하고
`font-display: block`으로 대체 글리프가 순간 노출되는 것도 막았습니다.

### Stockfish 라이선스 참고사항

Stockfish는 **GPL-3.0**입니다. 이 저장소는 컴파일된 `stockfish-18-lite-single.wasm`을
재배포하므로 다음을 지켜야 합니다.

* 라이선스 전문을 함께 배포합니다 → `public/stockfish/COPYING.txt`
* 이 앱을 **배포**한다면(사내/외부 서비스 포함) GPL-3.0에 따라
  엔진 소스 취득 경로를 제공해야 합니다:
  <https://github.com/official-stockfish/Stockfish> 및
  <https://github.com/nmrugg/stockfish.js>
* 엔진과 링크되는 방식·범위에 따라 파생 저작물 판단이 달라질 수 있으므로,
  상업적 배포 시에는 라이선스를 직접 검토하시기 바랍니다.

chess.js(BSD-2-Clause)와 폰트(OFL-1.1)의 라이선스 원문도
`public/lib/`와 `public/fonts/`에 포함되어 있습니다.

---

## Nginx 설정

`nginx.conf`의 핵심만 정리하면:

* **`application/wasm`** — `.wasm`에 대해 `types { }` + `default_type`으로
  location 범위에서만 MIME을 강제합니다. `server` 레벨에 `types` 블록을 쓰면
  상속된 `mime.types` 전체가 덮여 JS/CSS가 깨지기 때문에 이 방식이 안전합니다.
  (`WebAssembly.instantiateStreaming()`은 MIME이 틀리면 실패합니다.)
* **`text/javascript`** — ES module과 Worker 스크립트 모두 이 타입으로 서빙합니다.
* **캐시 정책** — HTML/JS/CSS는 `no-cache`(항상 재검증)로 두어
  **재빌드 후 브라우저 캐시에 남은 옛 Worker가 살아나는 문제**를 막고,
  파일명이 버전을 담은 `.wasm`과 폰트는 `immutable`로 1년 캐시합니다.
* **압축** — 이미지 빌드 시 `gzip -9`로 미리 압축해 두고 `gzip_static on`으로
  서빙합니다. 7.3 MB → 5.6 MB이며, 매 요청마다 7 MB를 다시 압축하지 않습니다.
  이미 압축 포맷인 `.woff2`는 압축을 끕니다.
* **COOP/COEP** — 적용하지 않았습니다(위 "왜 단일 스레드 빌드인가" 참고).
* `/healthz` 는 compose healthcheck용 200 응답입니다.

---

## 상태 관리와 안정성

`game.js`는 명시적인 상태 머신으로 동작합니다.

```
LOADING ──> READY ──> PLAYER_TURN <──> ENGINE_THINKING ──> GAME_OVER
   │                                                          
   └──────────────────> ERROR <───────────────────────────────
```

의도적으로 방어한 항목:

| 위험 | 대응 |
|---|---|
| Worker 중복 생성 | `init()`이 같은 Promise를 재사용. 동시 호출 3번에도 Worker는 1개 |
| 이전 게임의 `bestmove`가 새 게임에 적용 | `gameId` 증가로 무효화 + 엔진 쪽 `searchSeq` 이중 검사 |
| 엔진 사고 중 사용자 입력 | `PLAYER_TURN`이 아니면 `legalTargetsFor()`가 빈 배열, 보드도 `board--locked` |
| 게임 종료 후 추가 수 | `GAME_OVER`에서 입력·탐색 모두 차단, 종료 시 `cancelSearch()` |
| 진영 변경 후 orientation 오류 | orientation은 `New Game`마다 `engineColor`로 재계산 |
| WASM 경로 오류 | wasm 절대 URL을 Worker fragment로 명시 전달 |
| Worker 내부 상대 경로 오해석 | 위와 동일. `import.meta.url` 기준이라 sub-path에도 안전 |
| 브라우저 캐시의 옛 Worker | JS는 `no-cache` + Worker URL에 `?v=APP_VERSION` |
| `bestmove (none)` 누락 | `null`로 정규화. 실제 종료면 종료 처리, 아니면 `ERROR` |
| 초기화 전 `go` | `search()`가 ready 이전 호출을 거부 |
| 응답 없는 탐색 | `movetime + 15s` 타임아웃 후 `stop` + 에러 표시 |
| 명령/응답 경쟁 | 응답 대기자를 **먼저** 등록한 뒤 명령을 씀 |

Worker 로딩이 실패하면 상태 배너에 `Stockfish engine failed to load.` 가
표시되고 보드는 잠깁니다. 콘솔에는 `[engine]`, `[game]` 접두어로
UCI 송수신과 상태 전이가 남습니다.

---

## 테스트 (선택 사항)

`tests/`에는 실제 브라우저에서 도는 두 개의 스위트가 있습니다.
호스트에는 Docker만 있으면 되고, Playwright는 공식 이미지 안에서 실행됩니다.

```bash
docker compose up --build -d
./tests/run.sh
```

* `tests/logic.js` — 스크립트된 가짜 엔진으로 규칙과 경쟁 조건을 검증합니다.
  캐슬링, 앙파상, 프로모션 선택, 체크메이트(양쪽), 스테일메이트, 3회 반복,
  종료 후 입력 차단, 새 게임 후 stale `bestmove` 폐기, `bestmove (none)`,
  그리고 가짜 Worker로 UCI 핸드셰이크까지 확인합니다. (86 assertions)
* `tests/integration.js` — 실제 Stockfish WASM을 로드해 orientation(양쪽),
  클릭·드래그 이동, 엔진 응수, 난이도 전환, Worker 단일 생성,
  390 px 뷰포트 오버플로를 확인하고 `tests/out/`에 스크린샷을 남깁니다. (30 assertions)

이 폴더는 런타임에 관여하지 않으며 `.dockerignore`로 이미지에서 제외됩니다.
필요 없으면 삭제해도 앱은 그대로 동작합니다.

---

## 알려진 브라우저 제한사항

* **WebAssembly SIMD 필요** — 이 Stockfish 빌드는 WASM SIMD를 사용합니다.
  Chrome/Edge 91+, Firefox 89+, Safari 16.4+ 이상이 필요하고,
  iOS는 16.4 미만에서 동작하지 않습니다.
* **ES modules / `import.meta`** — 트랜스파일하지 않으므로 레거시 Edge와 IE는 지원하지 않습니다.
* **최초 로딩 트래픽** — 엔진 바이너리가 gzip 후 약 5.6 MB입니다. 첫 방문에는
  모바일 회선에서 수 초가 걸릴 수 있으며, 그동안 `New Game`은 비활성화되고
  "Stockfish 엔진 로딩 중..."이 표시됩니다. 이후에는 1년 캐시로 즉시 로드됩니다.
* **모바일 성능** — 단일 스레드 WASM이라 `Hard`(depth 16 / 2 s)는 구형 단말에서
  `movetime` 상한에 먼저 걸립니다. 실력이 조금 낮아질 뿐 정상 동작합니다.
* **저전력 모드 / 백그라운드 탭** — 탭이 백그라운드로 가면 브라우저가 타이머를
  스로틀링해 엔진 응답이 늦어질 수 있습니다.
* **드래그** — HTML5 drag-and-drop이 아니라 Pointer Events로 구현했기 때문에
  터치에서도 동작합니다. 보드에는 `touch-action: none`이 적용되어 기물을
  끌 때 페이지가 스크롤되지 않습니다.

---

## 문제 해결

**화면이 "Stockfish 엔진 로딩 중..."에서 멈춤**
DevTools → Network에서 `stockfish-18-lite-single.wasm`을 확인하세요.
`Content-Type`이 `application/wasm`이 아니면 Nginx 설정이 반영되지 않은 것입니다.

```bash
curl -sI http://localhost:8080/stockfish/stockfish-18-lite-single.wasm | grep -i content-type
# content-type: application/wasm
```

**`Stockfish engine failed to load.` 표시**
콘솔의 `[engine]` 로그를 확인하세요. 대개 다음 중 하나입니다.
* `.wasm`이 404 → 이미지 안에 파일이 없음. `docker compose build --no-cache` 로 재빌드
* MIME이 `application/octet-stream` → `nginx.conf`가 `conf.d/default.conf`로 복사되지 않음
* 브라우저가 WASM SIMD 미지원 → 위 "알려진 브라우저 제한사항" 참고

```bash
docker compose exec chess ls -l /usr/share/nginx/html/stockfish/
docker compose exec chess nginx -t
```

**기물이 예전 모양(시스템 글리프)으로 보임**
`/fonts/noto-sans-symbols-2-chess.woff2`가 200으로 내려오는지, MIME이
`font/woff2`인지 확인하세요.

**옛 코드가 계속 실행됨**
JS는 `no-cache`지만 프록시나 서비스워커가 끼어 있으면 남을 수 있습니다.
`constants.js`의 `APP_VERSION`을 올리면 Worker URL이 바뀌어 확실히 갱신됩니다.
그리고 hard reload(Ctrl+Shift+R)를 사용하세요.

**엔진이 너무 느림 / 브라우저가 버벅임**
`Beginner`로 낮추거나 `constants.js`의 `DIFFICULTIES`에서 `movetime`을 줄이세요.

**포트 8080이 이미 사용 중**
`docker-compose.yml`의 `ports`를 `"9090:80"` 등으로 바꾸고 다시 `docker compose up`.

**보드 방향이 이상해 보임**
의도된 동작입니다. 이 앱은 **사용자 진영이 항상 위쪽**입니다.
White를 선택하면 통상 시점의 180° 회전 상태가 정상입니다.
