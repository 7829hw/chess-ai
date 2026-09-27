/**
 * Entry point: wires the DOM to the game controller and renders every state
 * change. All DOM knowledge lives here; game.js and engine.js stay free of it.
 */

import {
  COLOR_NAMES,
  DEFAULT_DIFFICULTY,
  DEFAULT_USER_COLOR,
  DIFFICULTIES,
  STATE,
  oppositeColor,
} from './constants.js';
import { ChessBoard } from './board.js';
import { StockfishEngine } from './engine.js';
import { GameController } from './game.js';
import { PromotionDialog } from './promotion.js';
import { PositionEditor } from './setup.js';
import { initThemeSwitcher } from './theme.js';

const ENGINE_STATUS = Object.freeze({
  [STATE.LOADING]: 'Stockfish 엔진 로딩 중...',
  [STATE.READY]: 'Stockfish 준비 완료',
  [STATE.PLAYER_TURN]: 'Stockfish 준비 완료',
  [STATE.ENGINE_THINKING]: 'Stockfish 생각 중...',
  [STATE.GAME_OVER]: 'Stockfish 대기 중',
  [STATE.SETUP]: 'Stockfish 대기 중',
  [STATE.ERROR]: 'Stockfish 엔진을 불러오지 못했습니다.',
});

const BANNER_TONE = Object.freeze({
  [STATE.LOADING]: 'loading',
  [STATE.READY]: 'ready',
  [STATE.PLAYER_TURN]: 'ready',
  [STATE.ENGINE_THINKING]: 'busy',
  [STATE.GAME_OVER]: 'done',
  [STATE.SETUP]: 'done',
  [STATE.ERROR]: 'error',
});

const dom = {
  banner: byId('status-banner'),
  sideGroup: byId('side-group'),
  difficultyGroup: byId('difficulty-group'),
  newGame: byId('new-game'),
  setupOpen: byId('setup-open'),
  gameActions: byId('game-actions'),
  pendingNote: byId('pending-note'),
  board: byId('board'),
  userCard: byId('user-card'),
  engineCard: byId('engine-card'),
  userTag: byId('user-tag'),
  engineTag: byId('engine-tag'),
  turnValue: byId('turn-value'),
  engineValue: byId('engine-value'),
  startValue: byId('start-value'),
  resultValue: byId('result-value'),
  moveList: byId('move-list'),
  moveEmpty: byId('move-empty'),
  promotion: byId('promotion'),
  promotionOptions: byId('promotion-options'),
  promotionCancel: byId('promotion-cancel'),
};

/** Side chosen in the UI; only applied to the board on "New Game". */
let selectedSide = DEFAULT_USER_COLOR;
/** Difficulty chosen in the UI; applied immediately. */
let selectedDifficulty = DEFAULT_DIFFICULTY;
/** Latest `info depth` reported by the running search. */
let searchDepth = null;
const engine = new StockfishEngine({
  onSearchInfo: ({ depth }) => {
    if (depth === undefined || depth === searchDepth) return;
    searchDepth = depth;
    if (controller?.state === STATE.ENGINE_THINKING) renderEngineStatus(controller);
  },
  onFatalError: () => render(controller),
});

const board = new ChessBoard(dom.board, {
  legalTargetsFor: (square) => controller.legalTargetsFor(square),
  onMoveAttempt: (from, to) => {
    controller.attemptUserMove(from, to).catch((error) => {
      console.error('[app] move failed', error);
    });
  },
});

const promotionDialog = new PromotionDialog({
  root: dom.promotion,
  options: dom.promotionOptions,
  cancelButton: dom.promotionCancel,
});

const editor = new PositionEditor({
  board,
  elements: {
    root: byId('setup'),
    palette: byId('setup-palette'),
    turnGroup: byId('setup-turn'),
    castling: byId('setup-castling'),
    standard: byId('setup-standard'),
    clear: byId('setup-clear'),
    fenInput: byId('setup-fen'),
    fenLoad: byId('setup-fen-load'),
    message: byId('setup-message'),
    start: byId('setup-start'),
    cancel: byId('setup-cancel'),
  },
  onStart: (fen) => {
    editor.close();
    startGame(fen);
  },
  onCancel: () => {
    editor.close();
    controller.leaveSetup().catch((error) => console.error('[app] could not resume the game', error));
  },
});

const view = {
  onUpdate: (game) => render(game),
  askPromotion: (color) => promotionDialog.open(color),
};

const controller = new GameController({ engine, board, view });

// ------------------------------------------------------------------- rendering

function render(game) {
  if (!game) return;

  const state = game.state;
  if (state !== STATE.ENGINE_THINKING) searchDepth = null;

  dom.banner.textContent = bannerText(game);
  dom.banner.dataset.tone = BANNER_TONE[state] ?? 'ready';

  // During setup the tags (and board orientation) preview the chosen side.
  const userColor = state === STATE.SETUP ? selectedSide : game.userColor;
  dom.userTag.textContent = `나 · ${COLOR_NAMES[userColor]}`;
  dom.engineTag.textContent = `STOCKFISH · ${COLOR_NAMES[oppositeColor(userColor)]}`;

  dom.turnValue.textContent = state === STATE.GAME_OVER || state === STATE.SETUP
    ? '—'
    : `${COLOR_NAMES[game.turn]}${game.turn === userColor ? ' (나)' : ' (Stockfish)'}`;

  renderEngineStatus(game);

  // The badge on each player card marks whose move it is.
  dom.userCard.dataset.active = String(state === STATE.PLAYER_TURN);
  dom.engineCard.dataset.active = String(state === STATE.ENGINE_THINKING);

  dom.startValue.textContent = game.isCustomStart ? '사용자 지정' : '초기 배치';

  dom.resultValue.textContent = game.result
    ? `${game.result.headline} · ${game.result.detail}`
    : '—';

  dom.newGame.disabled = state === STATE.LOADING;
  dom.setupOpen.disabled = state === STATE.LOADING || state === STATE.ERROR;
  dom.gameActions.hidden = state === STATE.SETUP;
  setPressed(dom.sideGroup, 'side', selectedSide);
  setPressed(dom.difficultyGroup, 'difficulty', selectedDifficulty);

  const sideMismatch = selectedSide !== userColor && state !== STATE.SETUP;
  dom.pendingNote.hidden = !sideMismatch;
  if (sideMismatch) {
    dom.pendingNote.textContent =
      `지금은 ${COLOR_NAMES[userColor]}으로 두고 있습니다. ${COLOR_NAMES[selectedSide]}으로 바꾸려면 "새 게임"을 누르세요.`;
  }

  renderMoveList(game.moveHistory, game.startFen);
}

function bannerText(game) {
  switch (game.state) {
    case STATE.LOADING:
      return ENGINE_STATUS[STATE.LOADING];
    case STATE.ERROR:
      return game.errorMessage ?? ENGINE_STATUS[STATE.ERROR];
    case STATE.READY:
      return 'Stockfish 준비 완료 — 게임 시작 중...';
    case STATE.ENGINE_THINKING:
      return ENGINE_STATUS[STATE.ENGINE_THINKING];
    case STATE.GAME_OVER:
      return game.result ? `${game.result.headline} · ${game.result.detail}` : '게임 종료';
    case STATE.PLAYER_TURN:
      return game.isCheck ? '체크! 내 차례입니다.' : '내 차례입니다.';
    case STATE.SETUP:
      return '보드 세팅 — 기물을 배치한 뒤 시작하세요.';
    default:
      return '';
  }
}

function renderEngineStatus(game) {
  const base = ENGINE_STATUS[game.state] ?? '';
  const suffix = game.state === STATE.ENGINE_THINKING && searchDepth !== null
    ? ` (깊이 ${searchDepth})`
    : '';
  const level = game.state === STATE.PLAYER_TURN || game.state === STATE.GAME_OVER
    ? ` · ${game.difficulty.label}`
    : '';
  dom.engineValue.textContent = `${base}${suffix}${level}`;
}

function renderMoveList(history, startFen) {
  dom.moveEmpty.hidden = history.length > 0;

  // A custom position may start with Black to move and at any move number.
  const [, startTurn, , , , startNumber] = startFen.split(' ');
  const offset = startTurn === 'b' ? 1 : 0;

  const firstNumber = Number(startNumber) || 1;
  const rows = [];
  for (let i = -offset; i < history.length; i += 2) {
    const li = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'move-num';
    number.textContent = `${firstNumber + (i + offset) / 2}.`;
    li.append(number);
    if (i < 0) {
      const gap = document.createElement('span');
      gap.className = 'move-san move-san--gap';
      gap.textContent = '…';
      li.append(gap);
    } else {
      li.append(sanCell(history[i], i === history.length - 1));
    }
    if (history[i + 1]) {
      li.append(sanCell(history[i + 1], i + 1 === history.length - 1));
    }
    rows.push(li);
  }

  dom.moveList.start = firstNumber;
  dom.moveList.replaceChildren(...rows);
  dom.moveList.scrollTop = dom.moveList.scrollHeight;
}

function sanCell(move, isLatest) {
  const span = document.createElement('span');
  span.className = 'move-san';
  span.classList.toggle('move-san--latest', isLatest);
  span.textContent = move.san;
  return span;
}

function setPressed(group, key, value) {
  for (const button of group.querySelectorAll('button')) {
    const active = button.dataset[key] === value;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

// -------------------------------------------------------------------- controls

dom.sideGroup.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-side]');
  if (!button) return;

  selectedSide = button.dataset.side;
  if (editor.isOpen) board.setOrientation(oppositeColor(selectedSide));
  render(controller);

  // Switching sides before the first move is harmless, so apply it at once;
  // mid-game it waits for an explicit "New Game", and during board setup for
  // the setup's own start button.
  if (!controller.hasStarted && controller.state !== STATE.LOADING && !editor.isOpen) {
    startGame();
  }
});

dom.difficultyGroup.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-difficulty]');
  if (!button || !DIFFICULTIES[button.dataset.difficulty]) return;

  selectedDifficulty = button.dataset.difficulty;
  controller.changeDifficulty(selectedDifficulty);
  render(controller);
});

dom.newGame.addEventListener('click', () => startGame());

dom.setupOpen.addEventListener('click', () => {
  promotionDialog.close(null);
  // Seed the editor with the position on the board, so "set up from here" works.
  if (!controller.enterSetup()) return;
  board.setOrientation(oppositeColor(selectedSide));
  editor.open(controller.fen);
});

/** @param {string} [fen] New starting position; omitted replays the current one. */
function startGame(fen) {
  promotionDialog.close(null);
  controller
    .startNewGame({ userColor: selectedSide, difficultyId: selectedDifficulty, fen })
    .catch((error) => console.error('[app] could not start a new game', error));
}

// ----------------------------------------------------------------- bootstrap

initThemeSwitcher(byId('theme-group'));

window.addEventListener('pagehide', () => engine.dispose(), { once: true });

render(controller);
controller.boot().catch((error) => {
  console.error('[app] boot failed', error);
  render(controller);
});

function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el;
}
