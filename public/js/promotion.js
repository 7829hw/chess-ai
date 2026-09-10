/**
 * Promotion chooser.
 *
 * A tiny modal that resolves to 'q' | 'r' | 'b' | 'n', or to `null` when the
 * user backs out. Kept separate from app.js so the game controller's promotion
 * hand-off has a single, testable implementation.
 */

import { PIECE_NAMES, PROMOTION_PIECES } from './constants.js';

export class PromotionDialog {
  #root;
  #options;
  #cancelButton;
  /** @type {((piece: string|null) => void) | null} */
  #resolve = null;
  /** @type {(event: KeyboardEvent) => void} */
  #keyHandler;

  /**
   * @param {object} elements
   * @param {HTMLElement} elements.root         Overlay container.
   * @param {HTMLElement} elements.options      Holder for the piece buttons.
   * @param {HTMLElement} elements.cancelButton
   */
  constructor({ root, options, cancelButton }) {
    this.#root = root;
    this.#options = options;
    this.#cancelButton = cancelButton;

    this.#options.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-piece]');
      if (button) this.close(button.dataset.piece);
    });

    this.#cancelButton.addEventListener('click', () => this.close(null));

    // Click on the backdrop (but not the card) cancels.
    this.#root.addEventListener('click', (event) => {
      if (event.target === this.#root) this.close(null);
    });

    this.#keyHandler = (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close(null);
    };
    document.addEventListener('keydown', this.#keyHandler);
  }

  get isOpen() {
    return this.#resolve !== null;
  }

  /**
   * @param {'w'|'b'} color Colour of the promoting pawn.
   * @returns {Promise<string|null>}
   */
  open(color) {
    // A dialog left open from an abandoned game must not linger.
    this.close(null);

    const buttons = PROMOTION_PIECES.map((type) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'promotion-option';
      button.dataset.piece = type;
      button.title = PIECE_NAMES[type];
      button.setAttribute('aria-label', PIECE_NAMES[type]);

      const glyph = document.createElement('span');
      glyph.className = 'piece';
      glyph.dataset.color = color;
      glyph.dataset.type = type;

      button.append(glyph);
      return button;
    });

    this.#options.replaceChildren(...buttons);
    this.#root.hidden = false;
    buttons[0].focus();

    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** @param {string|null} piece */
  close(piece) {
    const resolve = this.#resolve;
    this.#resolve = null;
    this.#root.hidden = true;
    this.#options.replaceChildren();
    resolve?.(piece ?? null);
  }
}
