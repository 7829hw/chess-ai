/**
 * Position editor.
 *
 * Lets the user arrange any starting position on the real board: pick a piece
 * (or the eraser) from the palette, then tap squares. Side to move, castling
 * rights and a FEN field complete the setup. The editor keeps its own piece
 * map and only hands a validated FEN to `onStart`; rule checks live in
 * position.js.
 */

import { COLOR_NAMES, FILES, PIECE_NAMES, WHITE, BLACK } from './constants.js';
import { DEFAULT_POSITION, normalizePosition } from './position.js';

const PALETTE_TYPES = Object.freeze(['k', 'q', 'r', 'b', 'n', 'p']);
const ERASER = 'x';
const EMPTY_POSITION = '8/8/8/8/8/8/8/8 w - - 0 1';

/** Castling right -> label and the squares that make it possible. */
const CASTLING = Object.freeze([
  { right: 'K', label: '백 O-O', color: WHITE, king: 'e1', rook: 'h1' },
  { right: 'Q', label: '백 O-O-O', color: WHITE, king: 'e1', rook: 'a1' },
  { right: 'k', label: '흑 O-O', color: BLACK, king: 'e8', rook: 'h8' },
  { right: 'q', label: '흑 O-O-O', color: BLACK, king: 'e8', rook: 'a8' },
]);

export class PositionEditor {
  #dom;
  /** @type {import('./board.js').ChessBoard} */
  #board;
  #onStart;
  #onCancel;

  /** @type {Map<string, {type: string, color: 'w'|'b'}>} */
  #pieces = new Map();
  #turn = WHITE;
  /** Rights the user wants; only those the placement allows are emitted. */
  #castling = new Set();
  /** Selected palette entry: colour + type (e.g. "wq") or ERASER. */
  #tool = 'wq';
  #open = false;
  /** Result of validating the current setup. */
  #check = { ok: false, error: '' };

  /**
   * @param {object} options
   * @param {import('./board.js').ChessBoard} options.board
   * @param {Record<string, HTMLElement>} options.elements
   * @param {(fen: string) => void} options.onStart
   * @param {() => void} options.onCancel
   */
  constructor({ board, elements, onStart, onCancel }) {
    this.#board = board;
    this.#dom = elements;
    this.#onStart = onStart;
    this.#onCancel = onCancel;

    this.#buildPalette();
    this.#buildCastling();
    this.#bindControls();
  }

  get isOpen() {
    return this.#open;
  }

  /** @param {string} fen Position to start editing from. */
  open(fen) {
    this.#open = true;
    this.#dom.root.hidden = false;
    this.#loadFen(fen);
    this.#board.setLastMove(null, null);
    this.#board.setCheckSquare(null);
    this.#board.setEditHandler((square, erase) => this.#editSquare(square, erase));
    this.#render();
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#dom.root.hidden = true;
    this.#board.setEditHandler(null);
  }

  // ------------------------------------------------------------------ building

  #buildPalette() {
    const buttons = [];
    for (const color of [WHITE, BLACK]) {
      for (const type of PALETTE_TYPES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'palette-btn';
        button.dataset.tool = color + type;
        const name = `${COLOR_NAMES[color]} ${PIECE_NAMES[type]}`;
        button.title = name;
        button.setAttribute('aria-label', name);

        const glyph = document.createElement('span');
        glyph.className = 'piece';
        glyph.dataset.color = color;
        glyph.dataset.type = type;
        button.append(glyph);
        buttons.push(button);
      }
    }

    const eraser = document.createElement('button');
    eraser.type = 'button';
    eraser.className = 'palette-btn palette-btn--eraser';
    eraser.dataset.tool = ERASER;
    eraser.title = '지우개';
    eraser.setAttribute('aria-label', '지우개');
    eraser.textContent = '✕';
    buttons.push(eraser);

    this.#dom.palette.replaceChildren(...buttons);
  }

  #buildCastling() {
    const labels = CASTLING.map(({ right, label }) => {
      const wrap = document.createElement('label');
      wrap.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.right = right;
      wrap.append(input, document.createTextNode(label));
      return wrap;
    });
    this.#dom.castling.replaceChildren(...labels);
  }

  #bindControls() {
    const dom = this.#dom;

    dom.palette.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tool]');
      if (!button) return;
      this.#tool = button.dataset.tool;
      this.#renderPalette();
    });

    dom.turnGroup.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-turn]');
      if (!button) return;
      this.#turn = button.dataset.turn;
      this.#render();
    });

    dom.castling.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-right]');
      if (!input) return;
      if (input.checked) this.#castling.add(input.dataset.right);
      else this.#castling.delete(input.dataset.right);
      this.#render();
    });

    dom.standard.addEventListener('click', () => {
      this.#loadFen(DEFAULT_POSITION);
      this.#render();
    });

    dom.clear.addEventListener('click', () => {
      this.#loadFen(EMPTY_POSITION);
      this.#render();
    });

    const applyFenInput = () => {
      if (!this.#loadFen(dom.fenInput.value)) {
        this.#showMessage('FEN을 읽을 수 없습니다.', false);
        return;
      }
      this.#render();
    };
    dom.fenLoad.addEventListener('click', applyFenInput);
    dom.fenInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyFenInput();
      }
    });

    dom.start.addEventListener('click', () => {
      if (this.#check.ok) this.#onStart(this.#check.fen);
    });
    dom.cancel.addEventListener('click', () => this.#onCancel());
  }

  // ------------------------------------------------------------------- editing

  #editSquare(square, erase) {
    const current = this.#pieces.get(square);

    if (erase || this.#tool === ERASER) {
      this.#pieces.delete(square);
    } else {
      const color = this.#tool[0];
      const type = this.#tool[1];
      if (current && current.color === color && current.type === type) {
        // Tapping the same piece again removes it.
        this.#pieces.delete(square);
      } else if (type === 'p' && (square[1] === '1' || square[1] === '8')) {
        this.#showMessage('폰은 1랭크나 8랭크에 놓을 수 없습니다.', false);
        return;
      } else {
        // Only one king per side: placing it again moves it.
        if (type === 'k') {
          for (const [sq, piece] of this.#pieces) {
            if (piece.type === 'k' && piece.color === color) this.#pieces.delete(sq);
          }
        }
        this.#pieces.set(square, { type, color });
      }
    }

    this.#render();
  }

  /**
   * Reads placement, side to move and castling from a (possibly partial or
   * not yet playable) FEN.
   * @returns {boolean} false when the text could not be parsed
   */
  #loadFen(fen) {
    const [placement, turn = WHITE, castling = '-'] = String(fen ?? '').trim().split(/\s+/);
    const pieces = parsePlacement(placement);
    if (!pieces || (turn !== WHITE && turn !== BLACK)) return false;

    this.#pieces = pieces;
    this.#turn = turn;
    this.#castling = new Set([...castling].filter((c) => 'KQkq'.includes(c)));
    return true;
  }

  // ----------------------------------------------------------------- rendering

  #render() {
    const allowed = new Set(CASTLING.filter((c) => this.#castlingPossible(c)).map((c) => c.right));

    this.#board.render(this.#matrix());

    for (const button of this.#dom.turnGroup.querySelectorAll('button[data-turn]')) {
      const active = button.dataset.turn === this.#turn;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    for (const input of this.#dom.castling.querySelectorAll('input[data-right]')) {
      const right = input.dataset.right;
      input.disabled = !allowed.has(right);
      input.checked = allowed.has(right) && this.#castling.has(right);
    }

    this.#renderPalette();

    const fen = this.#fen(allowed);
    if (document.activeElement !== this.#dom.fenInput) this.#dom.fenInput.value = fen;

    this.#check = normalizePosition(fen);
    this.#dom.start.disabled = !this.#check.ok;
    this.#showMessage(this.#check.ok ? '올바른 포지션입니다. 시작할 수 있습니다.' : this.#check.error, this.#check.ok);
  }

  #renderPalette() {
    for (const button of this.#dom.palette.querySelectorAll('button[data-tool]')) {
      const active = button.dataset.tool === this.#tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  #showMessage(text, ok) {
    this.#dom.message.textContent = text;
    this.#dom.message.dataset.tone = ok ? 'ok' : 'error';
  }

  #castlingPossible({ color, king, rook }) {
    const k = this.#pieces.get(king);
    const r = this.#pieces.get(rook);
    return k?.type === 'k' && k.color === color && r?.type === 'r' && r.color === color;
  }

  /** 8x8 matrix in `Chess#board()` layout: rank 8 first, file a first. */
  #matrix() {
    const rows = [];
    for (let rank = 8; rank >= 1; rank -= 1) {
      rows.push(FILES.map((file) => this.#pieces.get(file + rank) ?? null));
    }
    return rows;
  }

  #fen(allowedCastling) {
    const rows = this.#matrix().map((row) => {
      let text = '';
      let empty = 0;
      for (const piece of row) {
        if (!piece) {
          empty += 1;
          continue;
        }
        if (empty) text += empty;
        empty = 0;
        text += piece.color === WHITE ? piece.type.toUpperCase() : piece.type;
      }
      return empty ? text + empty : text;
    });

    const castling = 'KQkq'
      .split('')
      .filter((right) => allowedCastling.has(right) && this.#castling.has(right))
      .join('') || '-';

    return `${rows.join('/')} ${this.#turn} ${castling} - 0 1`;
  }
}

/** @returns {Map<string, {type: string, color: 'w'|'b'}> | null} */
function parsePlacement(placement) {
  const rows = placement?.split('/');
  if (!rows || rows.length !== 8) return null;

  const pieces = new Map();
  for (let i = 0; i < 8; i += 1) {
    const rank = 8 - i;
    let file = 0;
    for (const char of rows[i]) {
      if (/[1-8]/.test(char)) {
        file += Number(char);
      } else if (/[pnbrqk]/i.test(char)) {
        if (file > 7) return null;
        const color = char === char.toUpperCase() ? WHITE : BLACK;
        pieces.set(FILES[file] + rank, { type: char.toLowerCase(), color });
        file += 1;
      } else {
        return null;
      }
    }
    if (file !== 8) return null;
  }
  return pieces;
}
