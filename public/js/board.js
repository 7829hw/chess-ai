/**
 * Board rendering and input.
 *
 * Pure view layer: it draws a position, reports *attempted* moves, and knows
 * nothing about legality -- it asks an injected provider which squares are
 * reachable. That keeps rule enforcement in exactly one place (chess.js).
 *
 * Orientation note (a hard requirement of this project):
 *   `setOrientation(bottomColor)` decides which army sits on the BOTTOM half.
 *   The game controller always passes Stockfish's colour, so the user's army
 *   is always drawn on the TOP half -- the inverse of the usual convention.
 */

import {
  COLOR_NAMES,
  DRAG_THRESHOLD_PX,
  FILES,
  PIECE_NAMES,
  RANKS,
  WHITE,
} from './constants.js';

const BOARD_SIZE = 8;

export class ChessBoard {
  /** @type {HTMLElement} */
  #root;
  /** @type {Map<string, HTMLElement>} */
  #squares = new Map();

  /** Colour drawn on the bottom half of the board. */
  #bottomColor = WHITE;

  #interactive = false;
  /** @type {(square: string) => string[]} */
  #legalTargetsFor = () => [];
  /** @type {(from: string, to: string) => void} */
  #onMoveAttempt = () => {};

  /** @type {string|null} */
  #selected = null;
  /** @type {string[]} */
  #targets = [];
  /** @type {{from: string, to: string} | null} */
  #lastMove = null;
  /** @type {string|null} */
  #checkSquare = null;

  /**
   * Set while the position editor owns the board: presses are reported as
   * square edits and piece drags as relocations instead of moves.
   * @type {EditHandlers | null}
   */
  #edit = null;
  /** Square highlighted as the current drop target. @type {string|null} */
  #dropHover = null;

  /** In-flight pointer interaction. */
  #press = null;
  #drag = null;

  /**
   * @param {HTMLElement} root
   * @param {object} handlers
   * @param {(from: string, to: string) => void} handlers.onMoveAttempt
   * @param {(square: string) => string[]} handlers.legalTargetsFor
   */
  constructor(root, { onMoveAttempt, legalTargetsFor }) {
    if (!root) throw new Error('ChessBoard requires a root element');
    this.#root = root;
    this.#onMoveAttempt = onMoveAttempt;
    this.#legalTargetsFor = legalTargetsFor;

    this.#buildSquares();
    this.#applyOrientation();
    this.#bindPointerEvents();
  }

  /** @param {'w'|'b'} bottomColor */
  setOrientation(bottomColor) {
    if (this.#bottomColor === bottomColor) return;
    this.#bottomColor = bottomColor;
    this.#applyOrientation();
  }

  get bottomColor() {
    return this.#bottomColor;
  }

  /** @param {boolean} enabled */
  setInteractive(enabled) {
    this.#interactive = Boolean(enabled);
    this.#root.classList.toggle('board--locked', !this.#interactive);
    if (!this.#interactive) {
      this.#cancelPointerInteraction();
      this.clearSelection();
    }
  }

  /**
   * Switches the board into (or out of) position-editing mode, regardless of
   * `setInteractive`. A primary tap reports `onTap(square, false)`, a right
   * click `onTap(square, true)`, and dragging a piece reports
   * `onDrop(from, to)` -- `to` is null when it was dropped off the board.
   *
   * @typedef {{ onTap: (square: string, erase: boolean) => void,
   *             onDrop: (from: string, to: string|null) => void }} EditHandlers
   * @param {EditHandlers | null} handlers
   */
  setEditHandler(handlers) {
    this.#edit = handlers ?? null;
    this.#cancelPointerInteraction();
    this.clearSelection();
    this.#root.classList.toggle('board--editing', Boolean(this.#edit));
  }

  /** @returns {string|null} The square under a viewport point, if any. */
  squareAt(clientX, clientY) {
    return this.#squareFromPoint(clientX, clientY);
  }

  /** Width of one square in CSS pixels. */
  get squareSize() {
    return this.#root.getBoundingClientRect().width / BOARD_SIZE;
  }

  /** @param {string|null} square Square to outline as the drop target. */
  setDropHover(square) {
    if (this.#dropHover === square) return;
    if (this.#dropHover) this.#squares.get(this.#dropHover)?.classList.remove('square--drop');
    this.#dropHover = square ?? null;
    if (this.#dropHover) this.#squares.get(this.#dropHover)?.classList.add('square--drop');
  }

  /**
   * Paints a position.
   * @param {Array<Array<{type:string,color:'w'|'b'}|null>>} matrix `Chess#board()` output.
   */
  render(matrix) {
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        // chess.js returns rank 8 first, file a first.
        const square = FILES[col] + (BOARD_SIZE - row);
        this.#paintSquare(square, matrix[row][col]);
      }
    }
    this.#refreshMarkers();
  }

  /**
   * @param {string|null} from
   * @param {string|null} to
   */
  setLastMove(from, to) {
    this.#lastMove = from && to ? { from, to } : null;
    this.#refreshMarkers();
  }

  /** @param {string|null} square Square of a king that is in check. */
  setCheckSquare(square) {
    this.#checkSquare = square ?? null;
    this.#refreshMarkers();
  }

  clearSelection() {
    if (!this.#selected) return;
    this.#selected = null;
    this.#targets = [];
    this.#refreshMarkers();
  }

  // ------------------------------------------------------------------ building

  #buildSquares() {
    this.#root.replaceChildren();
    for (const file of FILES) {
      for (const rank of RANKS) {
        const square = file + rank;
        const el = document.createElement('div');
        el.className = 'square';
        el.dataset.square = square;
        el.setAttribute('role', 'gridcell');
        el.classList.add(isLightSquare(square) ? 'square--light' : 'square--dark');

        const fileTag = document.createElement('span');
        fileTag.className = 'coord coord--file';
        fileTag.textContent = file;

        const rankTag = document.createElement('span');
        rankTag.className = 'coord coord--rank';
        rankTag.textContent = String(rank);

        const marker = document.createElement('span');
        marker.className = 'marker';

        const piece = document.createElement('span');
        piece.className = 'piece';
        piece.hidden = true;

        el.append(fileTag, rankTag, marker, piece);
        this.#squares.set(square, el);
      }
    }
  }

  /**
   * Re-orders the 64 square nodes.
   *
   * White on the bottom  -> ranks 8..1 downwards, files a..h rightwards.
   * Black on the bottom  -> the board rotated 180 degrees, i.e. ranks 1..8
   *                         downwards and files h..a rightwards.
   */
  #applyOrientation() {
    const whiteAtBottom = this.#bottomColor === WHITE;
    const ranks = whiteAtBottom ? [...RANKS].reverse() : [...RANKS];
    const files = whiteAtBottom ? [...FILES] : [...FILES].reverse();

    const ordered = [];
    ranks.forEach((rank, row) => {
      files.forEach((file, col) => {
        const el = this.#squares.get(file + rank);
        // Coordinates are only shown along the outer edges of the view.
        el.classList.toggle('square--show-file', row === BOARD_SIZE - 1);
        el.classList.toggle('square--show-rank', col === 0);
        el.setAttribute('aria-label', `${file}${rank}`);
        ordered.push(el);
      });
    });

    this.#root.append(...ordered);
    this.#root.dataset.bottomColor = this.#bottomColor;
  }

  #paintSquare(square, piece) {
    const el = this.#squares.get(square);
    const glyph = el.querySelector('.piece');

    if (!piece) {
      if (!glyph.hidden) {
        glyph.hidden = true;
        glyph.removeAttribute('data-color');
        glyph.removeAttribute('data-type');
        glyph.removeAttribute('aria-label');
        el.removeAttribute('data-piece');
      }
      return;
    }

    const signature = piece.color + piece.type;
    if (el.dataset.piece === signature) return;

    el.dataset.piece = signature;
    glyph.hidden = false;
    glyph.dataset.color = piece.color;
    glyph.dataset.type = piece.type;
    glyph.setAttribute(
      'aria-label',
      `${COLOR_NAMES[piece.color]} ${PIECE_NAMES[piece.type]}`,
    );
  }

  #refreshMarkers() {
    for (const [square, el] of this.#squares) {
      const isTarget = this.#targets.includes(square);
      el.classList.toggle('square--selected', square === this.#selected);
      el.classList.toggle('square--target', isTarget);
      el.classList.toggle('square--capture', isTarget && Boolean(el.dataset.piece));
      el.classList.toggle(
        'square--last',
        Boolean(this.#lastMove) && (square === this.#lastMove.from || square === this.#lastMove.to),
      );
      el.classList.toggle('square--check', square === this.#checkSquare);
    }
  }

  // ------------------------------------------------------------------- pointers

  #bindPointerEvents() {
    this.#root.addEventListener('pointerdown', (event) => this.#onPointerDown(event));
    this.#root.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    this.#root.addEventListener('pointerup', (event) => this.#onPointerUp(event));
    this.#root.addEventListener('pointercancel', () => this.#cancelPointerInteraction());
    // Suppress the native image/text drag so our pointer drag is the only one.
    this.#root.addEventListener('dragstart', (event) => event.preventDefault());
    this.#root.addEventListener('contextmenu', (event) => {
      if (this.#drag || this.#edit) event.preventDefault();
    });
  }

  #squareFromEvent(event) {
    const el = event.target instanceof Element ? event.target.closest('.square') : null;
    return el?.dataset.square ?? null;
  }

  #squareFromPoint(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return el instanceof Element ? (el.closest('.square')?.dataset.square ?? null) : null;
  }

  #onPointerDown(event) {
    if (this.#edit) {
      const square = this.#squareFromEvent(event);
      if (!square) return;
      if (event.pointerType === 'mouse' && event.button === 2) {
        this.#edit.onTap(square, true);
        return;
      }
      if (event.button !== 0) return;
      // Decided on release: a tap edits the square, a drag relocates the piece.
      this.#press = {
        pointerId: event.pointerId,
        square,
        startX: event.clientX,
        startY: event.clientY,
        movable: Boolean(this.#squares.get(square).dataset.piece),
        edit: true,
      };
      return;
    }

    if (!this.#interactive) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const square = this.#squareFromEvent(event);
    if (!square) return;

    const previous = { selected: this.#selected, targets: this.#targets };
    const targets = this.#legalTargetsFor(square);

    this.#press = {
      pointerId: event.pointerId,
      square,
      startX: event.clientX,
      startY: event.clientY,
      movable: targets.length > 0,
      previous,
    };

    // Immediate feedback when grabbing one of our own movable pieces.
    if (targets.length > 0) {
      this.#selected = square;
      this.#targets = targets;
      this.#refreshMarkers();
    }
  }

  #onPointerMove(event) {
    const press = this.#press;
    if (!press || press.pointerId !== event.pointerId) return;

    if (!this.#drag) {
      if (!press.movable) return;
      const travelled = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
      if (travelled < DRAG_THRESHOLD_PX) return;
      this.#beginDrag(press, event);
    }

    if (this.#drag) {
      event.preventDefault();
      this.#moveDragged(event.clientX, event.clientY);
      if (press.edit) this.setDropHover(this.#squareFromPoint(event.clientX, event.clientY));
    }
  }

  #onPointerUp(event) {
    const press = this.#press;
    if (!press || press.pointerId !== event.pointerId) return;
    this.#press = null;

    if (press.edit) {
      if (!this.#drag) {
        this.#edit.onTap(press.square, false);
        return;
      }
      const dropSquare = this.#squareFromPoint(event.clientX, event.clientY);
      this.#endDrag();
      if (dropSquare !== press.square) this.#edit.onDrop(press.square, dropSquare);
      return;
    }

    if (this.#drag) {
      const dropSquare = this.#squareFromPoint(event.clientX, event.clientY);
      const from = this.#drag.square;
      this.#endDrag();

      if (dropSquare && dropSquare !== from && this.#targets.includes(dropSquare)) {
        this.clearSelection();
        this.#onMoveAttempt(from, dropSquare);
      }
      return;
    }

    // Tap / click semantics, decided against the selection as it was *before*
    // this press so that "select then click destination" works.
    const { selected, targets } = press.previous;

    if (selected && selected !== press.square && targets.includes(press.square)) {
      this.clearSelection();
      this.#onMoveAttempt(selected, press.square);
      return;
    }

    if (selected === press.square) {
      this.clearSelection();
      return;
    }

    if (!press.movable) this.clearSelection();
  }

  #beginDrag(press, event) {
    const el = this.#squares.get(press.square);
    const glyph = el?.querySelector('.piece');
    if (!glyph || glyph.hidden) return;

    const rect = glyph.getBoundingClientRect();
    this.#drag = {
      square: press.square,
      glyph,
      width: rect.width,
      height: rect.height,
    };

    glyph.classList.add('piece--dragging');
    glyph.style.width = `${rect.width}px`;
    glyph.style.height = `${rect.height}px`;
    this.#root.classList.add('board--dragging');

    try {
      this.#root.setPointerCapture(event.pointerId);
      this.#drag.capturedPointerId = event.pointerId;
    } catch {
      /* pointer capture is a nicety, not a requirement */
    }

    this.#moveDragged(event.clientX, event.clientY);
  }

  #moveDragged(clientX, clientY) {
    const { glyph, width, height } = this.#drag;
    glyph.style.left = `${clientX - width / 2}px`;
    glyph.style.top = `${clientY - height / 2}px`;
  }

  #endDrag() {
    const drag = this.#drag;
    this.#drag = null;
    if (!drag) return;

    drag.glyph.classList.remove('piece--dragging');
    drag.glyph.style.removeProperty('left');
    drag.glyph.style.removeProperty('top');
    drag.glyph.style.removeProperty('width');
    drag.glyph.style.removeProperty('height');
    this.#root.classList.remove('board--dragging');
    this.setDropHover(null);

    if (drag.capturedPointerId !== undefined) {
      try {
        this.#root.releasePointerCapture(drag.capturedPointerId);
      } catch {
        /* already released */
      }
    }
  }

  #cancelPointerInteraction() {
    this.#press = null;
    this.#endDrag();
  }
}

/** a1 is dark; a square is light when file index + rank number is even. */
function isLightSquare(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return (fileIndex + rank) % 2 === 0;
}
