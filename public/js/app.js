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

const ENGINE_STATUS = Object.freeze({
  [STATE.LOADING]: 'Stockfish 엔진 로딩 중...',
  [STATE.READY]: 'Stockfish 준비 완료',
  [STATE.PLAYER_TURN]: 'Stockfish 준비 완료',
  [STATE.ENGINE_THINKING]: 'Stockfish 생각 중...',
  [STATE.GAME_OVER]: 'Stockfish 대기 중',
  [STATE.ERROR]: 'Stockfish engine failed to load.',
});

const BANNER_TONE = Object.freeze({
  [STATE.LOADING]: 'loading',
  [STATE.READY]: 'ready',
  [STATE.PLAYER_TURN]: 'ready',
  [STATE.ENGINE_THINKING]: 'busy',
  [STATE.GAME_OVER]: 'done',
  [STATE.ERROR]: 'error',
});

const dom = {
  banner: byId('status-banner'),
  sideGroup: byId('side-group'),
  difficultyGroup: byId('difficulty-group'),
  newGame: byId('new-game'),
  pendingNote: byId('pending-note'),
  board: byId('board'),
  userTag: byId('user-tag'),
  engineTag: byId('engine-tag'),
  turnValue: byId('turn-value'),
  engineValue: byId('engine-value'),
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

  const userColor = game.userColor;
  dom.userTag.textContent = `USER · ${COLOR_NAMES[userColor]}`;
  dom.engineTag.textContent = `STOCKFISH · ${COLOR_NAMES[oppositeColor(userColor)]}`;

  dom.turnValue.textContent = state === STATE.GAME_OVER
    ? '—'
    : `${COLOR_NAMES[game.turn]}${game.turn === userColor ? ' (you)' : ' (Stockfish)'}`;

  renderEngineStatus(game);

  dom.resultValue.textContent = game.result
    ? `${game.result.headline} · ${game.result.detail}`
    : '—';

  dom.newGame.disabled = state === STATE.LOADING;
  setPressed(dom.sideGroup, 'side', selectedSide);
  setPressed(dom.difficultyGroup, 'difficulty', selectedDifficulty);

  const sideMismatch = selectedSide !== userColor;
  dom.pendingNote.hidden = !sideMismatch;
  if (sideMismatch) {
    dom.pendingNote.textContent =
      `You are still playing ${COLOR_NAMES[userColor]}. Press "New Game" to switch to ${COLOR_NAMES[selectedSide]}.`;
  }

  renderMoveList(game.moveHistory);
}

function bannerText(game) {
  switch (game.state) {
    case STATE.LOADING:
      return ENGINE_STATUS[STATE.LOADING];
    case STATE.ERROR:
      return game.errorMessage ?? ENGINE_STATUS[STATE.ERROR];
    case STATE.READY:
      return 'Stockfish 준비 완료 — starting game...';
    case STATE.ENGINE_THINKING:
      return ENGINE_STATUS[STATE.ENGINE_THINKING];
    case STATE.GAME_OVER:
      return game.result ? `${game.result.headline} · ${game.result.detail}` : 'Game over';
    case STATE.PLAYER_TURN:
      return game.isCheck ? 'Check! Your move.' : 'Your move.';
    default:
      return '';
  }
}

function renderEngineStatus(game) {
  const base = ENGINE_STATUS[game.state] ?? '';
  const suffix = game.state === STATE.ENGINE_THINKING && searchDepth !== null
    ? ` (depth ${searchDepth})`
    : '';
  const level = game.state === STATE.PLAYER_TURN || game.state === STATE.GAME_OVER
    ? ` · ${game.difficulty.label}`
    : '';
  dom.engineValue.textContent = `${base}${suffix}${level}`;
}

function renderMoveList(history) {
  dom.moveEmpty.hidden = history.length > 0;

  const rows = [];
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    li.append(sanCell(history[i], i === history.length - 1));
    if (history[i + 1]) {
      li.append(sanCell(history[i + 1], i + 1 === history.length - 1));
    }
    rows.push(li);
  }

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
  render(controller);

  // Switching sides before the first move is harmless, so apply it at once;
  // mid-game it waits for an explicit "New Game".
  if (!controller.hasStarted && controller.state !== STATE.LOADING) {
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

function startGame() {
  promotionDialog.close(null);
  controller
    .startNewGame({ userColor: selectedSide, difficultyId: selectedDifficulty })
    .catch((error) => console.error('[app] could not start a new game', error));
}

// ----------------------------------------------------------------- bootstrap

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
