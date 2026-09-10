/**
 * Game orchestration: owns the chess.js rule engine, drives the board view and
 * the Stockfish worker, and is the single authority on the application state
 * machine (LOADING -> READY -> PLAYER_TURN <-> ENGINE_THINKING -> GAME_OVER).
 *
 * Every asynchronous continuation re-checks `#gameId`, so a reply that belongs
 * to an abandoned game is discarded instead of being played on the new board.
 */

import { Chess } from '../lib/chess.js';
import {
  COLOR_NAMES,
  DEFAULT_DIFFICULTY,
  DEFAULT_USER_COLOR,
  DIFFICULTIES,
  MIN_ENGINE_THINK_MS,
  STATE,
  oppositeColor,
} from './constants.js';

const ENGINE_LOAD_ERROR = 'Stockfish engine failed to load.';

export class GameController {
  #chess = new Chess();
  /** @type {import('./engine.js').StockfishEngine} */
  #engine;
  /** @type {import('./board.js').ChessBoard} */
  #board;
  /** @type {{ onUpdate: Function, askPromotion: Function }} */
  #view;

  #state = STATE.LOADING;
  #userColor = DEFAULT_USER_COLOR;
  #difficultyId = DEFAULT_DIFFICULTY;

  /** Incremented on every new game; invalidates all pending async work. */
  #gameId = 0;
  /** True while the promotion dialog owns the input. */
  #awaitingPromotion = false;
  /** @type {{headline: string, detail: string} | null} */
  #result = null;
  /** @type {string|null} */
  #errorMessage = null;

  constructor({ engine, board, view }) {
    this.#engine = engine;
    this.#board = board;
    this.#view = view;
  }

  // --------------------------------------------------------------- public state

  get state() {
    return this.#state;
  }

  get userColor() {
    return this.#userColor;
  }

  get engineColor() {
    return oppositeColor(this.#userColor);
  }

  get difficultyId() {
    return this.#difficultyId;
  }

  get difficulty() {
    return DIFFICULTIES[this.#difficultyId];
  }

  get result() {
    return this.#result;
  }

  get errorMessage() {
    return this.#errorMessage;
  }

  get turn() {
    return this.#chess.turn();
  }

  get isCheck() {
    return this.#chess.isCheck();
  }

  get moveHistory() {
    return this.#chess.history({ verbose: true });
  }

  /** True once at least one move has been played in the current game. */
  get hasStarted() {
    return this.#chess.history().length > 0;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Boots the engine, then starts the opening game. */
  async boot() {
    this.#setState(STATE.LOADING);
    this.#board.setOrientation(this.engineColor);
    this.#syncBoard();

    try {
      await this.#engine.init();
    } catch (error) {
      this.#failEngine(error, ENGINE_LOAD_ERROR);
      return;
    }

    this.#setState(STATE.READY);
    await this.startNewGame({});
  }

  /**
   * Resets everything and, when the user plays Black, immediately lets
   * Stockfish open as White.
   * @param {{userColor?: 'w'|'b', difficultyId?: string}} options
   */
  async startNewGame({ userColor, difficultyId }) {
    if (this.#state === STATE.ERROR) return;

    // Invalidate in-flight work *before* touching any shared state.
    const gameId = ++this.#gameId;
    this.#engine.cancelSearch();
    this.#awaitingPromotion = false;

    if (userColor) this.#userColor = userColor;
    if (difficultyId && DIFFICULTIES[difficultyId]) this.#difficultyId = difficultyId;

    this.#chess.reset();
    this.#result = null;

    // User army on top => Stockfish's colour occupies the bottom half.
    this.#board.setOrientation(this.engineColor);
    this.#board.clearSelection();
    this.#syncBoard();
    this.#setState(STATE.READY);

    console.info(
      '[game] new game #%d, user=%s, difficulty=%s',
      gameId,
      COLOR_NAMES[this.#userColor],
      this.#difficultyId,
    );

    try {
      await this.#engine.newGame({ skillLevel: this.difficulty.skillLevel });
    } catch (error) {
      this.#failEngine(error, ENGINE_LOAD_ERROR);
      return;
    }

    if (gameId !== this.#gameId) {
      console.debug('[game] discarding stale new-game setup #%d', gameId);
      return;
    }

    if (this.#chess.turn() === this.#userColor) {
      this.#setState(STATE.PLAYER_TURN);
    } else {
      await this.#runEngineTurn(gameId);
    }
  }

  /**
   * Difficulty can be changed at any time; the new preset is pushed to the
   * engine just before its next search, never while `go` is running.
   * @param {string} difficultyId
   */
  changeDifficulty(difficultyId) {
    if (!DIFFICULTIES[difficultyId] || difficultyId === this.#difficultyId) return;
    this.#difficultyId = difficultyId;
    console.info('[game] difficulty ->', difficultyId);
    this.#emit();
  }

  // ---------------------------------------------------------------- user moves

  /**
   * Squares the given square's piece may legally move to, or `[]` when the
   * piece is not the user's or it is not the user's turn.
   * @param {string} square
   * @returns {string[]}
   */
  legalTargetsFor(square) {
    if (this.#state !== STATE.PLAYER_TURN || this.#awaitingPromotion) return [];
    if (this.#chess.turn() !== this.#userColor) return [];

    const piece = this.#chess.get(square);
    if (!piece || piece.color !== this.#userColor) return [];

    const moves = this.#chess.moves({ square, verbose: true });
    return [...new Set(moves.map((move) => move.to))];
  }

  /**
   * Applies a user move if it is legal, asking for a promotion piece when the
   * move is ambiguous.
   * @param {string} from
   * @param {string} to
   */
  async attemptUserMove(from, to) {
    if (this.#state !== STATE.PLAYER_TURN || this.#awaitingPromotion) return;
    if (this.#chess.turn() !== this.#userColor) return;

    const candidates = this.#chess
      .moves({ square: from, verbose: true })
      .filter((move) => move.to === to);

    if (candidates.length === 0) {
      console.debug('[game] rejected illegal move %s%s', from, to);
      return;
    }

    const gameId = this.#gameId;
    let promotion;

    if (candidates.length > 1 && candidates.every((move) => move.promotion)) {
      promotion = await this.#requestPromotion(gameId);
      if (promotion === null) return;
      if (gameId !== this.#gameId) return;
    }

    const chosen = promotion
      ? candidates.find((move) => move.promotion === promotion) ?? candidates[0]
      : candidates[0];

    try {
      this.#chess.move({ from, to, promotion: chosen.promotion });
    } catch (error) {
      console.error('[game] chess.js refused move', from, to, error);
      return;
    }

    this.#syncBoard();

    if (this.#evaluateGameEnd()) return;
    await this.#runEngineTurn(gameId);
  }

  /** @returns {Promise<string|null>} chosen piece, or null when cancelled */
  async #requestPromotion(gameId) {
    this.#awaitingPromotion = true;
    this.#emit();
    try {
      const piece = await this.#view.askPromotion(this.#userColor);
      return piece ?? null;
    } finally {
      this.#awaitingPromotion = false;
      if (gameId === this.#gameId) this.#emit();
    }
  }

  // -------------------------------------------------------------- engine moves

  async #runEngineTurn(gameId) {
    if (gameId !== this.#gameId) return;
    if (this.#state === STATE.GAME_OVER || this.#state === STATE.ERROR) return;
    if (this.#chess.turn() !== this.engineColor) return;
    if (this.#chess.isGameOver()) {
      this.#evaluateGameEnd();
      return;
    }

    this.#setState(STATE.ENGINE_THINKING);

    const { depth, movetime, skillLevel } = this.difficulty;
    this.#engine.setSkillLevel(skillLevel);

    const startedAt = performance.now();
    let outcome;

    try {
      outcome = await this.#engine.search({
        moves: this.#uciHistory(),
        depth,
        movetime,
      });
    } catch (error) {
      if (gameId !== this.#gameId) return;
      this.#failEngine(error, 'Stockfish stopped responding. Reload the page to retry.');
      return;
    }

    if (gameId !== this.#gameId) {
      console.debug('[game] dropping bestmove from game #%d', gameId);
      return;
    }
    if (outcome.aborted) return;

    if (!outcome.bestmove) {
      // `bestmove (none)`: the engine has no legal move. Either the game is
      // genuinely finished, or engine and board have drifted apart.
      if (!this.#evaluateGameEnd()) {
        this.#failEngine(
          new Error('bestmove (none) in a live position'),
          'Stockfish returned no move. Reload the page to retry.',
        );
      }
      return;
    }

    await delayRemaining(startedAt, MIN_ENGINE_THINK_MS);
    if (gameId !== this.#gameId) return;

    if (!this.#applyEngineMove(outcome.bestmove)) return;

    this.#syncBoard();
    if (this.#evaluateGameEnd()) return;
    this.#setState(STATE.PLAYER_TURN);
  }

  /** @param {string} uci e.g. "e2e4", "e7e8q" */
  #applyEngineMove(uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4].toLowerCase() : undefined;

    try {
      const move = this.#chess.move({ from, to, promotion });
      console.info('[game] Stockfish plays %s (%s)', move.san, uci);
      return true;
    } catch (error) {
      console.error('[game] illegal engine move', uci, error);
      this.#failEngine(error, `Stockfish suggested an illegal move (${uci}). Reload the page to retry.`);
      return false;
    }
  }

  /** Full game history in UCI long algebraic notation. */
  #uciHistory() {
    return this.#chess
      .history({ verbose: true })
      .map((move) => move.from + move.to + (move.promotion ?? ''));
  }

  // ------------------------------------------------------------------ end state

  /** @returns {boolean} true when the game is over (and state was updated). */
  #evaluateGameEnd() {
    if (!this.#chess.isGameOver()) return false;

    let headline = 'Draw';
    let detail = 'Draw';

    if (this.#chess.isCheckmate()) {
      // The side to move is the one that got mated.
      const matedColor = this.#chess.turn();
      headline = matedColor === this.#userColor ? 'Stockfish wins' : 'You win';
      detail = `Checkmate — ${COLOR_NAMES[matedColor]} is mated`;
    } else if (this.#chess.isStalemate()) {
      detail = 'Stalemate';
    } else if (this.#chess.isInsufficientMaterial()) {
      detail = 'Insufficient material';
    } else if (this.#chess.isThreefoldRepetition()) {
      detail = 'Threefold repetition';
    } else if (this.#chess.isDrawByFiftyMoves()) {
      detail = 'Fifty-move rule';
    }

    this.#result = { headline, detail };
    this.#engine.cancelSearch();
    this.#setState(STATE.GAME_OVER);
    console.info('[game] over: %s (%s)', headline, detail);
    return true;
  }

  #failEngine(error, message) {
    console.error('[game]', message, error);
    this.#errorMessage = message;
    this.#engine.cancelSearch();
    this.#setState(STATE.ERROR);
  }

  // ------------------------------------------------------------------- plumbing

  #syncBoard() {
    this.#board.render(this.#chess.board());

    const last = this.#chess.history({ verbose: true }).at(-1);
    this.#board.setLastMove(last?.from ?? null, last?.to ?? null);
    this.#board.setCheckSquare(this.#chess.isCheck() ? this.#kingSquare(this.#chess.turn()) : null);
  }

  #kingSquare(color) {
    try {
      return this.#chess.findPiece({ type: 'k', color })[0] ?? null;
    } catch {
      return null;
    }
  }

  #setState(state) {
    if (this.#state !== state) {
      console.debug('[game] state %s -> %s', this.#state, state);
      this.#state = state;
    }
    this.#emit();
  }

  #emit() {
    const interactive = this.#state === STATE.PLAYER_TURN && !this.#awaitingPromotion;
    this.#board.setInteractive(interactive);
    this.#view.onUpdate(this);
  }
}

/** Resolves once at least `minMs` have passed since `startedAt`. */
function delayRemaining(startedAt, minMs) {
  const remaining = minMs - (performance.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}
