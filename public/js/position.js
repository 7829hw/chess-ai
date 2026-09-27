/**
 * Validation and normalisation of user-supplied starting positions.
 *
 * chess.js's own `validateFen` only checks the syntax plus a few basics (one
 * king each, no pawns on the back ranks). A custom position also has to be
 * something Stockfish can search safely, so this adds the rules chess.js
 * leaves out and rewrites the FEN into a canonical form.
 */

import { Chess, DEFAULT_POSITION, validateFen } from '../lib/chess.js';

export { DEFAULT_POSITION };

/** Castling right -> the squares its king and rook must still stand on. */
const CASTLING_HOME = Object.freeze({
  K: { color: 'w', king: 'e1', rook: 'h1' },
  Q: { color: 'w', king: 'e1', rook: 'a1' },
  k: { color: 'b', king: 'e8', rook: 'h8' },
  q: { color: 'b', king: 'e8', rook: 'a8' },
});

/**
 * @param {string} input FEN; the trailing fields may be omitted.
 * @returns {{ok: true, fen: string} | {ok: false, error: string}}
 */
export function normalizePosition(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: 'FEN needs at least the piece placement and the side to move.' };
  }
  const padding = ['-', '-', '0', '1'];
  const fen = tokens.concat(padding.slice(tokens.length - 2)).slice(0, 6).join(' ');

  const syntax = validateFen(fen);
  if (!syntax.ok) return { ok: false, error: syntax.error.replace(/^Invalid FEN: /, '') };

  const chess = new Chess(fen);
  const fields = fen.split(' ');

  for (const color of ['w', 'b']) {
    const pieces = chess.board().flat().filter((p) => p?.color === color);
    const name = color === 'w' ? 'White' : 'Black';
    if (pieces.length > 16) return { ok: false, error: `${name} has more than 16 pieces.` };
    if (pieces.filter((p) => p.type === 'p').length > 8) {
      return { ok: false, error: `${name} has more than 8 pawns.` };
    }
  }

  // Drop castling rights whose king or rook has left its home square.
  const castling = [...fields[2]]
    .filter((right) => {
      const home = CASTLING_HOME[right];
      if (!home) return false;
      const king = chess.get(home.king);
      const rook = chess.get(home.rook);
      return king?.type === 'k' && king.color === home.color
        && rook?.type === 'r' && rook.color === home.color;
    })
    .join('') || '-';

  // The side that just "moved" can never be left in check.
  const flipped = new Chess(
    [fields[0], fields[1] === 'w' ? 'b' : 'w', '-', '-', '0', '1'].join(' '),
  );
  if (flipped.isCheck()) {
    const name = fields[1] === 'w' ? 'Black' : 'White';
    return { ok: false, error: `${name} is in check but it is not ${name}'s move.` };
  }

  // Rebuild through chess.js so an impossible en-passant square is dropped.
  const canonical = new Chess([fields[0], fields[1], castling, fields[3], fields[4], fields[5]].join(' '));
  if (canonical.isCheckmate()) return { ok: false, error: 'The position is already checkmate.' };
  if (canonical.isStalemate()) return { ok: false, error: 'The position is already stalemate.' };
  if (canonical.isInsufficientMaterial()) {
    return { ok: false, error: 'Neither side has enough material to mate.' };
  }

  return { ok: true, fen: canonical.fen() };
}
