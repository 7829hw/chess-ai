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
    return { ok: false, error: 'FEN에는 최소한 기물 배치와 차례가 있어야 합니다.' };
  }
  const padding = ['-', '-', '0', '1'];
  const fen = tokens.concat(padding.slice(tokens.length - 2)).slice(0, 6).join(' ');

  const syntax = validateFen(fen);
  if (!syntax.ok) return { ok: false, error: translateFenError(syntax.error) };

  const chess = new Chess(fen);
  const fields = fen.split(' ');

  for (const color of ['w', 'b']) {
    const pieces = chess.board().flat().filter((p) => p?.color === color);
    const name = color === 'w' ? '백' : '흑';
    if (pieces.length > 16) return { ok: false, error: `${name} 기물이 16개를 넘습니다.` };
    if (pieces.filter((p) => p.type === 'p').length > 8) {
      return { ok: false, error: `${name} 폰이 8개를 넘습니다.` };
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
    const name = fields[1] === 'w' ? '흑' : '백';
    return { ok: false, error: `${name}이 체크 상태인데 ${name} 차례가 아닙니다.` };
  }

  // Rebuild through chess.js so an impossible en-passant square is dropped.
  const canonical = new Chess([fields[0], fields[1], castling, fields[3], fields[4], fields[5]].join(' '));
  if (canonical.isCheckmate()) return { ok: false, error: '이미 체크메이트인 포지션입니다.' };
  if (canonical.isStalemate()) return { ok: false, error: '이미 스테일메이트인 포지션입니다.' };
  if (canonical.isInsufficientMaterial()) {
    return { ok: false, error: '양쪽 모두 체크메이트할 기물이 부족합니다.' };
  }

  return { ok: true, fen: canonical.fen() };
}

/** chess.js `validateFen` message -> Korean UI text. */
const FEN_ERRORS = [
  [/six space-delimited/, 'FEN 필드는 6개여야 합니다.'],
  [/move number/, '수 번호는 1 이상의 정수여야 합니다.'],
  [/half move/, '하프무브 카운터는 0 이상의 정수여야 합니다.'],
  [/en-passant/, '앙파상 칸이 올바르지 않습니다.'],
  [/castling/, '캐슬링 표기가 올바르지 않습니다.'],
  [/side-to-move/, '차례는 w 또는 b여야 합니다.'],
  [/missing white king/, '백 킹이 없습니다.'],
  [/missing black king/, '흑 킹이 없습니다.'],
  [/too many white kings/, '백 킹이 두 개 이상입니다.'],
  [/too many black kings/, '흑 킹이 두 개 이상입니다.'],
  [/pawns are on the edge rows/, '1랭크나 8랭크에 폰이 있습니다.'],
  [/piece data/, '기물 배치가 올바르지 않습니다.'],
];

function translateFenError(message) {
  return FEN_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? '올바르지 않은 FEN입니다.';
}
