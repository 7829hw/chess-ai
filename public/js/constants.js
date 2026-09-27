/**
 * Shared, immutable configuration for the chess simulator.
 * Keeping the tunables here avoids magic numbers scattered across modules.
 */

/** Bumped whenever js/ or the engine build changes; used to bust Worker caches. */
export const APP_VERSION = '1.0.0';

export const WHITE = 'w';
export const BLACK = 'b';

/** Explicit, mutually exclusive lifecycle states of the application. */
export const STATE = Object.freeze({
  LOADING: 'LOADING',
  READY: 'READY',
  PLAYER_TURN: 'PLAYER_TURN',
  ENGINE_THINKING: 'ENGINE_THINKING',
  GAME_OVER: 'GAME_OVER',
  /** The user is arranging a custom starting position; no game is running. */
  SETUP: 'SETUP',
  ERROR: 'ERROR',
});

/**
 * Difficulty presets.
 *
 * `Skill Level` (0-20) is Stockfish's own strength handicap: it makes the
 * engine deliberately pick sub-optimal moves. `depth` and `movetime` are
 * additionally passed to `go` so a search can never block the tab for long
 * (Stockfish stops at whichever limit is hit first).
 */
export const DIFFICULTIES = Object.freeze({
  beginner: Object.freeze({ id: 'beginner', label: 'Beginner', skillLevel: 1, depth: 5, movetime: 300 }),
  medium: Object.freeze({ id: 'medium', label: 'Medium', skillLevel: 8, depth: 11, movetime: 800 }),
  hard: Object.freeze({ id: 'hard', label: 'Hard', skillLevel: 20, depth: 16, movetime: 2000 }),
});

export const DEFAULT_DIFFICULTY = 'medium';
export const DEFAULT_USER_COLOR = WHITE;

/** Transposition table size. Small on purpose: WASM memory is not free. */
export const ENGINE_HASH_MB = 16;

/** Extra slack on top of `movetime` before a search is considered hung. */
export const SEARCH_TIMEOUT_MARGIN_MS = 15_000;

/** The WASM binary is ~7 MB, so the first handshake can be slow on mobile. */
export const HANDSHAKE_TIMEOUT_MS = 120_000;

/** Floor on engine reply time, so easy levels do not answer instantly. */
export const MIN_ENGINE_THINK_MS = 350;

/** Pointer travel (px) that turns a tap into a drag. */
export const DRAG_THRESHOLD_PX = 6;

export const FILES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
export const RANKS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);

export const PROMOTION_PIECES = Object.freeze(['q', 'r', 'b', 'n']);

/**
 * Piece artwork is drawn by CSS from the bundled "Noto Sans Symbols 2" subset:
 * the filled glyph (U+265A..U+265F) paints the body and the outline glyph
 * (U+2654..U+2659) is stacked on top for the contour and inner detail.
 * JS only sets `data-color` / `data-type`; see css/style.css.
 */

export const PIECE_NAMES = Object.freeze({
  k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn',
});

export const COLOR_NAMES = Object.freeze({ w: 'White', b: 'Black' });

/** @param {'w'|'b'} color */
export function oppositeColor(color) {
  return color === WHITE ? BLACK : WHITE;
}
