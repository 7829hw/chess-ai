/**
 * Drives game.js / board.js / promotion.js / engine.js inside the real browser
 * but with a scripted engine, so chess rules, the state machine and the race
 * guards can be exercised deterministically.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://chess';
const OUT = process.env.OUT || '/work/out';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  // Stop the real app from booting; we build our own wiring below.
  await page.route('**/js/app.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* disabled in test */' }));

  await page.goto(BASE, { waitUntil: 'load' });

  const results = await page.evaluate(async () => {
    const { ChessBoard } = await import('/js/board.js');
    const { GameController } = await import('/js/game.js');
    const { PromotionDialog } = await import('/js/promotion.js');
    const { StockfishEngine } = await import('/js/engine.js');
    const { STATE } = await import('/js/constants.js');
    const { normalizePosition, DEFAULT_POSITION } = await import('/js/position.js');
    const { PositionEditor } = await import('/js/setup.js');

    const out = [];
    const check = (name, pass, detail = '') => out.push({ name, pass: Boolean(pass), detail: String(detail) });
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

    // ---------------------------------------------------------- scripted engine
    function makeFakeEngine() {
      const api = {
        log: [],
        queue: [],          // UCI moves the "engine" will answer with
        latency: 0,
        forceStaleReply: false,
        newGameCalls: 0,
        skillLevels: [],
        cancels: 0,
        seq: 0,
        setSkillLevel(level) { api.skillLevels.push(level); return true; },
        async newGame(opts) { api.newGameCalls += 1; api.log.push('newgame:' + opts.skillLevel); },
        cancelSearch() { api.cancels += 1; },
        fens: [],
        async search({ fen = null, moves }) {
          api.fens.push(fen);
          api.log.push('search:' + moves.join(' '));
          const best = api.queue.shift() ?? null;
          if (api.latency) await tick(api.latency);
          return { seq: ++api.seq, bestmove: best, aborted: false };
        },
      };
      return api;
    }

    function makeHarness() {
      const root = document.getElementById('board');
      root.replaceChildren();
      const engine = makeFakeEngine();
      const promptedColors = [];
      let promotionAnswer = 'q';

      const board = new ChessBoard(root, {
        legalTargetsFor: (sq) => controller.legalTargetsFor(sq),
        onMoveAttempt: (from, to) => controller.attemptUserMove(from, to),
      });
      const view = {
        updates: 0,
        onUpdate() { view.updates += 1; },
        askPromotion(color) { promptedColors.push(color); return Promise.resolve(promotionAnswer); },
      };
      const controller = new GameController({ engine, board, view });
      return {
        engine, board, view, controller, root, promptedColors,
        setPromotionAnswer: (v) => { promotionAnswer = v; },
      };
    }

    /** Plays alternating user/engine moves; engine replies come from `engineMoves`. */
    async function playOut(h, userMoves, engineMoves) {
      h.engine.queue = [...engineMoves];
      for (const uci of userMoves) {
        await h.controller.attemptUserMove(uci.slice(0, 2), uci.slice(2, 4));
        await tick(0);
      }
    }

    const sans = (h) => h.controller.moveHistory.map((m) => m.san);
    const domSquares = (h) => [...h.root.querySelectorAll('.square')].map((e) => e.dataset.square);

    // ============================================== 1. orientation, both sides
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      check('user=White -> engine colour on the bottom', h.board.bottomColor === 'b', h.board.bottomColor);
      const sq = domSquares(h);
      check('user=White -> first rendered square is h1', sq[0] === 'h1', sq[0]);
      check('user=White -> last rendered square is a8', sq[63] === 'a8', sq[63]);

      await h.controller.startNewGame({ userColor: 'b' });
      check('user=Black -> engine colour on the bottom', h.board.bottomColor === 'w', h.board.bottomColor);
      const sq2 = domSquares(h);
      check('user=Black -> first rendered square is a8', sq2[0] === 'a8', sq2[0]);
      check('user=Black -> last rendered square is h1', sq2[63] === 'h1', sq2[63]);
    }

    // ==================================== 2. Black user: engine opens as White
    {
      const h = makeHarness();
      h.engine.queue = ['d2d4'];
      await h.controller.startNewGame({ userColor: 'b' });
      await tick(5);
      check('engine opens when the user is Black', sans(h).join(',') === 'd4', sans(h).join(','));
      check('state returns to PLAYER_TURN', h.controller.state === STATE.PLAYER_TURN, h.controller.state);
      check('ucinewgame issued once per game', h.engine.newGameCalls === 1, h.engine.newGameCalls);
    }

    // ============================================================ 3. castling
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h, ['e2e4', 'g1f3', 'f1c4', 'e1g1'], ['a7a6', 'b7b6', 'c7c6', 'h7h6']);
      check('castling produces O-O', sans(h).includes('O-O'), sans(h).join(' '));
      check('king landed on g1', h.root.querySelector('[data-square="g1"]').dataset.piece === 'wk');
      check('rook landed on f1', h.root.querySelector('[data-square="f1"]').dataset.piece === 'wr');
    }

    // ========================================================== 4. en passant
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h, ['e2e4', 'e4e5', 'e5d6'], ['a7a6', 'd7d5', 'h7h6']);
      const ep = h.controller.moveHistory.find((m) => m.san === 'exd6');
      check('en passant capture accepted', Boolean(ep), sans(h).join(' '));
      check('en passant flagged by chess.js', ep && ep.isEnPassant(), ep && ep.flags);
      check('captured pawn removed from d5',
        h.root.querySelector('[data-square="d5"]').dataset.piece === undefined,
        h.root.querySelector('[data-square="d5"]').dataset.piece);
    }

    // ================================================ 5. promotion + chooser
    {
      const h = makeHarness();
      h.setPromotionAnswer('n');
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h,
        ['g2g4', 'g4h5', 'h5g6', 'g6g7', 'g7h8'],
        ['h7h5', 'g7g6', 'a7a6', 'a6a5', 'a5a4']);
      check('promotion dialog was asked exactly once', h.promptedColors.length === 1, h.promptedColors.join(','));
      check('dialog asked for the user colour', h.promptedColors[0] === 'w', h.promptedColors[0]);
      check('chosen piece applied (gxh8=N)', sans(h).includes('gxh8=N'), sans(h).join(' '));
      check('knight now stands on h8',
        h.root.querySelector('[data-square="h8"]').dataset.piece === 'wn',
        h.root.querySelector('[data-square="h8"]').dataset.piece);
    }

    // =============================================== 6. checkmate: user wins
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h, ['e2e4', 'f1c4', 'd1h5', 'h5f7'], ['e7e5', 'b8c6', 'g8f6']);
      check('state is GAME_OVER', h.controller.state === STATE.GAME_OVER, h.controller.state);
      check('headline is "You win"', h.controller.result?.headline === '나의 승리', JSON.stringify(h.controller.result));
      check('detail mentions Checkmate', /체크메이트/.test(h.controller.result?.detail ?? ''), h.controller.result?.detail);
      check('board is locked after mate', h.root.classList.contains('board--locked'));

      // No further moves may be accepted, and the engine must not be asked again.
      const before = sans(h).length;
      const searchesBefore = h.engine.log.filter((l) => l.startsWith('search')).length;
      await h.controller.attemptUserMove('e4', 'e5');
      await tick(5);
      check('no moves accepted after game over', sans(h).length === before, sans(h).length);
      check('engine not queried after game over',
        h.engine.log.filter((l) => l.startsWith('search')).length === searchesBefore);
      check('no legal targets offered after game over',
        h.controller.legalTargetsFor('c4').length === 0);
    }

    // ========================================== 7. checkmate: Stockfish wins
    {
      const h = makeHarness();
      h.engine.queue = ['e2e4', 'f1c4', 'd1h5', 'h5f7'];
      await h.controller.startNewGame({ userColor: 'b' });
      await tick(5);
      for (const uci of ['e7e5', 'b8c6', 'g8f6']) {
        await h.controller.attemptUserMove(uci.slice(0, 2), uci.slice(2, 4));
        await tick(5);
      }
      check('Stockfish mate detected', h.controller.state === STATE.GAME_OVER, h.controller.state);
      check('headline is "Stockfish wins"', h.controller.result?.headline === 'Stockfish 승리',
        JSON.stringify(h.controller.result));
    }

    // =========================================================== 8. stalemate
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h,
        ['e2e3', 'd1h5', 'h5a5', 'a5c7', 'h2h4', 'c7d7', 'd7b7', 'b7b8', 'b8c8', 'c8e6'],
        ['a7a5', 'a8a6', 'h7h5', 'a6h6', 'f7f6', 'e8f7', 'd8d3', 'd3h7', 'f7g6']);
      check('stalemate ends the game', h.controller.state === STATE.GAME_OVER, h.controller.state);
      check('stalemate scored as a draw', h.controller.result?.headline === '무승부',
        JSON.stringify(h.controller.result));
      check('stalemate named in the detail', h.controller.result?.detail === '스테일메이트',
        h.controller.result?.detail);
    }

    // ================================================ 9. threefold repetition
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await playOut(h, ['g1f3', 'f3g1', 'g1f3', 'f3g1'], ['g8f6', 'f6g8', 'g8f6', 'f6g8']);
      check('threefold repetition ends the game', h.controller.state === STATE.GAME_OVER, h.controller.state);
      check('threefold reported as a draw', h.controller.result?.headline === '무승부',
        JSON.stringify(h.controller.result));
      check('threefold named in the detail', h.controller.result?.detail === '3회 동형 반복',
        h.controller.result?.detail);
    }

    // ==================================== 10. illegal user moves are rejected
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      await h.controller.attemptUserMove('e2', 'e5');       // pawn cannot jump 3
      await h.controller.attemptUserMove('a1', 'a5');       // rook blocked by pawn
      await h.controller.attemptUserMove('e7', 'e5');       // not the user's piece
      await tick(5);
      check('illegal moves ignored', sans(h).length === 0, sans(h).join(' '));
      check('no targets for an opponent piece', h.controller.legalTargetsFor('e7').length === 0);
      check('targets offered for own piece', h.controller.legalTargetsFor('g1').sort().join(',') === 'f3,h3',
        h.controller.legalTargetsFor('g1').join(','));
    }

    // ============ 11. race: a bestmove from an abandoned game is discarded
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      h.engine.latency = 120;
      h.engine.queue = ['e7e5'];

      const userMove = h.controller.attemptUserMove('e2', 'e4');
      await tick(10);
      check('engine is thinking', h.controller.state === STATE.ENGINE_THINKING, h.controller.state);

      // A user move must be refused while the engine thinks.
      await h.controller.attemptUserMove('d2', 'd4');
      check('user cannot move while the engine thinks',
        sans(h).join(',') === 'e4', sans(h).join(','));
      check('board locked while the engine thinks', h.root.classList.contains('board--locked'));

      // Abandon the game mid-search; the late reply must not be played.
      await h.controller.startNewGame({ userColor: 'w' });
      await userMove;
      await tick(200);
      check('stale bestmove discarded after New Game', sans(h).length === 0, sans(h).join(','));
      check('fresh board after New Game',
        h.root.querySelector('[data-square="e2"]').dataset.piece === 'wp'
        && h.root.querySelector('[data-square="e4"]').dataset.piece === undefined);
      check('state is PLAYER_TURN after restart', h.controller.state === STATE.PLAYER_TURN, h.controller.state);
      h.engine.latency = 0;
    }

    // ============================= 12. difficulty preset reaches the engine
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w', difficultyId: 'beginner' });
      check('beginner skill level sent on ucinewgame', h.engine.log.includes('newgame:1'), h.engine.log.join('|'));
      h.controller.changeDifficulty('hard');
      h.engine.queue = ['e7e5'];
      await h.controller.attemptUserMove('e2', 'e4');
      await tick(5);
      check('difficulty change pushed before the next search',
        h.engine.skillLevels.at(-1) === 20, h.engine.skillLevels.join(','));
    }

    // ================================= 13. bestmove (none) in a live position
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      h.engine.queue = [];               // search resolves with bestmove: null
      await h.controller.attemptUserMove('e2', 'e4');
      await tick(10);
      check('bestmove (none) in a live game raises ERROR', h.controller.state === STATE.ERROR, h.controller.state);
      check('error message surfaced to the UI',
        /수를 내지 못했습니다/.test(h.controller.errorMessage ?? ''), h.controller.errorMessage);
      check('board locked in ERROR state', h.root.classList.contains('board--locked'));
    }

    // ============================== 14. illegal engine move raises an error
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      h.engine.queue = ['a7a1'];
      await h.controller.attemptUserMove('e2', 'e4');
      await tick(10);
      check('illegal engine move raises ERROR', h.controller.state === STATE.ERROR, h.controller.state);
      check('illegal engine move reported', /잘못된 수/.test(h.controller.errorMessage ?? ''),
        h.controller.errorMessage);
    }

    // ==================================== 15. check detection & king marker
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      h.engine.queue = ['f7f5'];
      await h.controller.attemptUserMove('e2', 'e4');   // 1. e4 f5
      await tick(5);

      // 2. Qh5+ : hold the engine mid-search so the check state is observable.
      h.engine.latency = 150;
      h.engine.queue = ['g7g6'];
      const answering = h.controller.attemptUserMove('d1', 'h5');
      await tick(20);

      check('check delivered', /Qh5\+/.test(h.controller.moveHistory.at(-1).san),
        h.controller.moveHistory.at(-1).san);
      check('controller reports check', h.controller.isCheck === true);
      const marked = [...h.root.querySelectorAll('.square--check')].map((e) => e.dataset.square);
      check('check marker sits on the black king (e8)', marked.join(',') === 'e8', marked.join(','));

      await answering;
      await tick(200);
      h.engine.latency = 0;
      check('engine answered the check legally',
        h.controller.moveHistory.at(-1).san === 'g6', h.controller.moveHistory.at(-1).san);
      check('game continues after the check is answered',
        h.controller.state === STATE.PLAYER_TURN, h.controller.state);
      check('check cleared once answered', h.controller.isCheck === false);
      check('check marker removed', h.root.querySelectorAll('.square--check').length === 0);
    }

    // ============================ 16. real promotion dialog (DOM behaviour)
    {
      const dialog = new PromotionDialog({
        root: document.getElementById('promotion'),
        options: document.getElementById('promotion-options'),
        cancelButton: document.getElementById('promotion-cancel'),
      });

      const pending = dialog.open('w');
      check('dialog becomes visible', document.getElementById('promotion').hidden === false);
      check('dialog offers four pieces',
        document.querySelectorAll('#promotion-options button[data-piece]').length === 4);
      check('dialog renders pieces in the promoting colour',
        [...document.querySelectorAll('#promotion-options .piece')].every((e) => e.dataset.color === 'w'));
      check('dialog reports open state', dialog.isOpen === true);

      document.querySelector('#promotion-options button[data-piece="r"]').click();
      const picked = await pending;
      check('dialog resolves with the clicked piece', picked === 'r', picked);
      check('dialog hidden after choosing', document.getElementById('promotion').hidden === true);

      const cancelled = dialog.open('b');
      document.getElementById('promotion-cancel').click();
      check('cancel resolves with null', (await cancelled) === null);

      const escaped = dialog.open('b');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      check('Escape resolves with null', (await escaped) === null);
    }

    // ================================ 18. custom position validation
    {
      const ok = (fen) => normalizePosition(fen);
      check('standard position accepted', ok(DEFAULT_POSITION).ok && ok(DEFAULT_POSITION).fen === DEFAULT_POSITION);
      check('short FEN padded', ok('4k3/8/8/8/8/8/4P3/4K3 w').fen === '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
        JSON.stringify(ok('4k3/8/8/8/8/8/4P3/4K3 w')));
      check('missing king rejected', !ok('8/8/8/8/8/8/4P3/4K3 w - - 0 1').ok);
      check('two white kings rejected', !ok('4k3/8/8/8/8/8/8/3KK3 w - - 0 1').ok);
      check('pawn on back rank rejected', !ok('4k2P/8/8/8/8/8/8/4K3 w - - 0 1').ok);
      const inCheck = ok('4k3/8/8/8/8/8/4R3/3K4 w - - 0 1');
      check('check on the side not to move rejected', !inCheck.ok && /흑이 체크 상태/.test(inCheck.error),
        inCheck.error);
      check('check on the side to move accepted', ok('4k3/4R3/8/8/8/8/8/4K3 b - - 0 1').ok);
      check('checkmate position rejected', !ok('4k3/4Q3/4K3/8/8/8/8/8 b - - 0 1').ok);
      check('stalemate position rejected', !ok('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').ok);
      check('bare kings rejected', !ok('4k3/8/8/8/8/8/8/4K3 w - - 0 1').ok);
      check('impossible castling rights stripped',
        ok('r3k3/8/8/8/8/8/8/4K2R w KQkq - 0 1').fen === 'r3k3/8/8/8/8/8/8/4K2R w Kq - 0 1',
        ok('r3k3/8/8/8/8/8/8/4K2R w KQkq - 0 1').fen);
      check('nine pawns rejected', !ok('4k3/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1').ok);
      check('garbage rejected', !ok('hello world').ok);
    }

    // ============================== 19. game from a custom position
    {
      const fen = '4k3/8/8/8/8/8/4P3/4K2R b K - 0 30';
      const h = makeHarness();
      h.engine.queue = ['e8d7'];
      await h.controller.startNewGame({ userColor: 'w', fen });
      await tick(5);
      check('custom start: Black to move -> engine moves first', sans(h).join(',') === 'Kd7', sans(h).join(','));
      check('custom start: engine told the FEN', h.engine.fens[0] === fen, h.engine.fens[0]);
      check('custom start flagged', h.controller.isCustomStart === true);
      check('custom start: board shows the rook on h1',
        h.root.querySelector('[data-square="h1"]').dataset.piece === 'wr');
      check('custom start: castling still legal', h.controller.legalTargetsFor('e1').includes('g1'),
        h.controller.legalTargetsFor('e1').join(','));

      await playOut(h, ['e2e4'], ['d7c6']);
      await tick(5);
      check('custom start: history continues from the FEN', h.engine.log.includes('search:e8d7 e2e4'),
        h.engine.log.at(-1));

      // New Game replays the same custom position.
      h.engine.queue = ['e8f7'];
      await h.controller.startNewGame({});
      await tick(5);
      check('New Game keeps the custom start', h.controller.startFen === fen && sans(h).join(',') === 'Kf7',
        h.controller.startFen + ' ' + sans(h).join(','));

      let threw = false;
      try { await h.controller.startNewGame({ fen: '8/8/8/8/8/8/8/8 w - - 0 1' }); } catch { threw = true; }
      check('invalid custom FEN throws', threw);
      check('invalid FEN leaves the previous game intact', sans(h).join(',') === 'Kf7', sans(h).join(','));

      await h.controller.startNewGame({ fen: DEFAULT_POSITION });
      check('standard start restored', h.controller.isCustomStart === false);
      check('standard start searches from startpos', h.engine.fens.every((f, i) => i < 3 || f === null));
    }

    // =================================== 20. setup pauses and resumes a game
    {
      const h = makeHarness();
      h.engine.queue = ['e7e5'];
      await h.controller.startNewGame({ userColor: 'w' });
      h.engine.latency = 50;
      const pending = h.controller.attemptUserMove('e2', 'e4');
      await tick(5);
      check('engine thinking before setup', h.controller.state === STATE.ENGINE_THINKING, h.controller.state);
      check('enterSetup succeeds', h.controller.enterSetup() === true);
      check('state is SETUP', h.controller.state === STATE.SETUP, h.controller.state);
      await pending;
      await tick(60);
      check('reply that arrives during setup is dropped', sans(h).join(',') === 'e4', sans(h).join(','));
      check('board locked for play during setup', h.root.classList.contains('board--locked'));

      h.engine.queue = ['c7c5'];
      h.engine.latency = 0;
      await h.controller.leaveSetup();
      await tick(5);
      check('cancelling setup resumes the engine turn', sans(h).join(',') === 'e4,c5', sans(h).join(','));
      check('state back to PLAYER_TURN', h.controller.state === STATE.PLAYER_TURN, h.controller.state);
    }

    // ================================= 21. position editor (DOM behaviour)
    {
      const h = makeHarness();
      await h.controller.startNewGame({ userColor: 'w' });
      const host = document.createElement('div');
      host.innerHTML = `
        <div id="t-root"><div id="t-palette"></div>
        <div id="t-turn"><button data-turn="w"></button><button data-turn="b"></button></div>
        <div id="t-castling"></div><button id="t-standard"></button><button id="t-clear"></button>
        <input id="t-fen"><button id="t-load"></button><p id="t-msg"></p>
        <button id="t-start"></button><button id="t-cancel"></button></div>`;
      document.body.append(host);
      const q = (id) => host.querySelector('#' + id);
      let started = null;
      const editor = new PositionEditor({
        board: h.board,
        elements: {
          root: q('t-root'), palette: q('t-palette'), turnGroup: q('t-turn'), castling: q('t-castling'),
          standard: q('t-standard'), clear: q('t-clear'), fenInput: q('t-fen'), fenLoad: q('t-load'),
          message: q('t-msg'), start: q('t-start'), cancel: q('t-cancel'),
        },
        onStart: (fen) => { started = fen; },
        onCancel: () => {},
      });
      h.controller.enterSetup();
      editor.open(h.controller.fen);

      const tap = (square, button = 0) => {
        const el = h.root.querySelector(`[data-square="${square}"]`);
        const init = { bubbles: true, button, pointerType: 'mouse', pointerId: 1 };
        el.dispatchEvent(new PointerEvent('pointerdown', init));
        el.dispatchEvent(new PointerEvent('pointerup', init));
      };
      const pick = (tool) => q('t-palette').querySelector(`[data-tool="${tool}"]`).click();

      check('editor seeded with the game position', q('t-fen').value === DEFAULT_POSITION, q('t-fen').value);
      check('palette has 12 pieces + eraser', q('t-palette').querySelectorAll('button').length === 13);

      q('t-clear').click();
      check('clear empties the board', h.root.querySelectorAll('.square[data-piece]').length === 0);
      check('empty board cannot start', q('t-start').disabled === true, q('t-msg').textContent);

      pick('wk'); tap('e1');
      pick('bk'); tap('e8');
      pick('wq'); tap('d1');
      check('placed pieces render on the board',
        h.root.querySelector('[data-square="d1"]').dataset.piece === 'wq'
        && h.root.querySelector('[data-square="e8"]').dataset.piece === 'bk');
      check('FEN field follows the edits', q('t-fen').value === '4k3/8/8/8/8/8/8/3QK3 w - - 0 1', q('t-fen').value);
      check('legal setup can start', q('t-start').disabled === false, q('t-msg').textContent);

      pick('wk'); tap('a1');
      check('placing a second king moves it', !h.root.querySelector('[data-square="e1"]').dataset.piece
        && h.root.querySelector('[data-square="a1"]').dataset.piece === 'wk');

      tap('d1', 2);
      check('right click erases', !h.root.querySelector('[data-square="d1"]').dataset.piece);

      pick('wp'); tap('c8');
      check('pawn on the last rank refused', !h.root.querySelector('[data-square="c8"]').dataset.piece);

      pick('wr'); tap('h1'); pick('wk'); tap('e1');
      const ks = q('t-castling').querySelector('[data-right="K"]');
      const qs = q('t-castling').querySelector('[data-right="Q"]');
      check('castling offered only when king and rook are home', !ks.disabled && qs.disabled);
      ks.click();
      q('t-turn').querySelector('[data-turn="b"]').click();
      check('turn + castling reflected in FEN', q('t-fen').value === '4k3/8/8/8/8/8/8/4K2R b K - 0 1', q('t-fen').value);

      q('t-fen').value = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
      q('t-load').click();
      check('FEN load updates the board', h.root.querySelector('[data-square="d1"]').dataset.piece === 'wr');
      q('t-start').click();
      check('start hands over the validated FEN', started === '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', started);

      editor.close();
      check('closing leaves edit mode', !h.root.classList.contains('board--editing'));
      host.remove();
    }

    // =========================== 17. engine.js UCI protocol (stubbed Worker)
    {
      const realWorker = window.Worker;
      const instances = [];

      class StubWorker {
        constructor(url) {
          this.url = url;
          this.sent = [];
          this.autoBest = 'e2e4';
          this.terminated = false;
          instances.push(this);
        }
        postMessage(cmd) {
          this.sent.push(cmd);
          // Always reply asynchronously, like a real worker thread.
          setTimeout(() => this.#reply(cmd), 0);
        }
        terminate() { this.terminated = true; }
        #emit(text) { this.onmessage?.({ data: text }); }
        #reply(cmd) {
          if (cmd === 'uci') this.#emit('id name StubFish\nuciok');
          else if (cmd === 'isready') this.#emit('readyok');
          else if (cmd.startsWith('go')) {
            this.#emit('info depth 7 score cp 24 pv e2e4');
            if (this.autoBest !== null) this.#emit('bestmove ' + this.autoBest + ' ponder e7e5');
          }
        }
      }

      window.Worker = StubWorker;
      try {
        const infos = [];
        const eng = new StockfishEngine({ onSearchInfo: (i) => infos.push(i) });

        // Concurrent init() calls must not spawn a second worker.
        await Promise.all([eng.init(), eng.init(), eng.init()]);
        check('init() is idempotent: exactly one Worker', instances.length === 1, instances.length);
        check('engine reports ready', eng.isReady === true);

        const w = instances[0];
        check('worker URL carries a cache-busting version', /\?v=/.test(w.url), w.url);
        check('worker URL pins the wasm path in its hash',
          decodeURIComponent(w.url.split('#')[1] || '').endsWith('stockfish-18-lite-single.wasm'),
          w.url.split('#')[1]);
        check('handshake sent uci then isready',
          w.sent[0] === 'uci' && w.sent.includes('isready'), w.sent.slice(0, 6).join(' | '));
        check('Threads pinned to 1 for the single-threaded build',
          w.sent.includes('setoption name Threads value 1'));
        check('Hash option configured', w.sent.some((c) => /^setoption name Hash value \d+$/.test(c)));

        await eng.newGame({ skillLevel: 8 });
        check('ucinewgame sent', w.sent.includes('ucinewgame'));
        check('skill level sent', w.sent.includes('setoption name Skill Level value 8'));

        const r1 = await eng.search({ moves: [], depth: 6, movetime: 100 });
        check('search returns the bestmove', r1.bestmove === 'e2e4', JSON.stringify(r1));
        check('startpos used with an empty history', w.sent.includes('position startpos'));
        check('go carries both depth and movetime',
          w.sent.some((c) => c === 'go depth 6 movetime 100'), w.sent.at(-1));
        check('info lines parsed for the UI', infos.some((i) => i.depth === 7), JSON.stringify(infos[0] ?? {}));

        const r2 = await eng.search({ moves: ['e2e4', 'e7e5'], depth: 6, movetime: 100 });
        check('move history forwarded as position startpos moves ...',
          w.sent.includes('position startpos moves e2e4 e7e5'), JSON.stringify(r2.bestmove));

        const customFen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
        await eng.search({ fen: customFen, moves: [], depth: 6, movetime: 100 });
        check('custom start sent as position fen', w.sent.includes(`position fen ${customFen}`), w.sent.at(-2));
        await eng.search({ fen: customFen, moves: ['e2e4'], depth: 6, movetime: 100 });
        check('custom start + history sent as position fen ... moves',
          w.sent.includes(`position fen ${customFen} moves e2e4`), w.sent.at(-2));

        // bestmove (none)
        w.autoBest = '(none)';
        const r3 = await eng.search({ moves: [], depth: 6, movetime: 100 });
        check('bestmove (none) becomes null', r3.bestmove === null, JSON.stringify(r3));

        // Cancellation: the reply that arrives afterwards must be dropped.
        w.autoBest = null;                       // no automatic answer
        const slow = eng.search({ moves: [], depth: 6, movetime: 100 });
        eng.cancelSearch();
        const r4 = await slow;
        check('cancelled search resolves as aborted', r4.aborted === true && r4.bestmove === null,
          JSON.stringify(r4));
        check('stop sent on cancellation', w.sent.includes('stop'));

        // The late bestmove for the cancelled search must not resurface.
        let leaked = false;
        eng.search({ moves: [], depth: 6, movetime: 100 }).then((r) => { leaked = r.bestmove === 'h2h4'; });
        eng.cancelSearch();
        w.onmessage({ data: 'bestmove h2h4' });
        await tick(10);
        check('stale bestmove never reaches the caller', leaked === false);

        eng.dispose();
        check('dispose terminates the worker', w.terminated === true);
        check('quit sent before terminate', w.sent.includes('quit'));

        let refused = false;
        try { await eng.init(); } catch { refused = true; }
        check('init() after dispose is refused', refused === true);
      } finally {
        window.Worker = realWorker;
      }
    }

    return out;
  });

  // Screenshot the real promotion dialog for a visual check.
  await page.evaluate(async () => {
    const { PromotionDialog } = await import('/js/promotion.js');
    const d = new PromotionDialog({
      root: document.getElementById('promotion'),
      options: document.getElementById('promotion-options'),
      cancelButton: document.getElementById('promotion-cancel'),
    });
    d.open('w');
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-promotion.png` });

  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  -- ' + r.detail : ''}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
