import { Chess, type Move, type Square } from "chess.js";
import type { Color } from "../types";

export const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export interface UciParts {
  from: Square;
  to: Square;
  promotion?: string;
}

export function parseUci(uci: string): UciParts | null {
  if (uci.length < 4) return null;
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length > 4 ? uci[4] : undefined;
  return { from, to, promotion };
}

/** Converts one UCI move to SAN in the context of `fen`. Returns null if illegal. */
export function uciToSan(fen: string, uci: string): string | null {
  const parts = parseUci(uci);
  if (!parts) return null;
  const board = new Chess(fen);
  try {
    const move = board.move(parts);
    return move.san;
  } catch {
    return null;
  }
}

/** Converts a UCI principal variation to SAN, stopping at the first illegal move. */
export function pvToSan(fen: string, pv: string[], limit = 6): string[] {
  const board = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, limit)) {
    const parts = parseUci(uci);
    if (!parts) break;
    try {
      out.push(board.move(parts).san);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Renders a SAN line the way a human writes it: "12...Nf6 13.Bg5 h6".
 * `moveNumber` and `color` describe whose move starts the line.
 */
export function formatSanLine(
  sanMoves: string[],
  moveNumber: number,
  color: Color,
): string {
  const parts: string[] = [];
  let number = moveNumber;
  let white = color === "w";
  for (const san of sanMoves) {
    if (white) {
      parts.push(`${number}.${san}`);
    } else {
      parts.push(parts.length === 0 ? `${number}...${san}` : san);
      number += 1;
    }
    white = !white;
  }
  return parts.join(" ");
}

/** Total non-king material on the board, in pawn units (32 at the start). */
export function materialTotal(fen: string): number {
  const board = new Chess(fen);
  let total = 0;
  for (const row of board.board()) {
    for (const square of row) {
      if (square) total += PIECE_VALUES[square.type] ?? 0;
    }
  }
  return total;
}

/** Material balance from `color`'s point of view, in pawn units. */
export function materialBalance(fen: string, color: Color): number {
  const board = new Chess(fen);
  let balance = 0;
  for (const row of board.board()) {
    for (const square of row) {
      if (!square) continue;
      const value = PIECE_VALUES[square.type] ?? 0;
      balance += square.color === color ? value : -value;
    }
  }
  return balance;
}

export type Phase = "opening" | "middlegame" | "endgame";

export function phaseOf(ply: number, fen: string): Phase {
  if (ply < 20) return "opening";
  return materialTotal(fen) <= 20 ? "endgame" : "middlegame";
}

export interface ParsedPgn {
  headers: Record<string, string>;
  moves: Move[];
}

/** Parses a single PGN game. Throws if the move text is unreadable. */
export function parsePgn(pgn: string): ParsedPgn {
  const board = new Chess();
  board.loadPgn(pgn);
  return {
    headers: board.getHeaders() as Record<string, string>,
    moves: board.history({ verbose: true }),
  };
}

/**
 * Splits a multi-game PGN export into individual games. Games are separated by
 * a blank line followed by a new `[Event ...]` tag pair.
 */
export function splitPgnGames(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, "\n").trim();
  if (!normalised) return [];
  const games: string[] = [];
  let current: string[] = [];
  for (const line of normalised.split("\n")) {
    if (/^\[Event\s/i.test(line) && current.some((l) => l.trim().length > 0)) {
      games.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim().length > 0)) games.push(current.join("\n").trim());
  return games.filter(Boolean);
}

/** Does `color` have a piece on `square` that nobody of theirs defends? */
export function isUndefended(fen: string, square: Square, color: Color): boolean {
  const board = new Chess(fen);
  const piece = board.get(square);
  if (!piece || piece.color !== color) return false;
  // isAttacked(square, by) counts defenders when `by` is the piece's own colour.
  // Remove the piece first so it does not count as defending itself.
  board.remove(square);
  return !board.isAttacked(square, color);
}

export function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

export function colorName(color: Color): string {
  return color === "w" ? "White" : "Black";
}

/**
 * Converts a SAN line back to UCI. Used when re-deriving analysis without
 * re-running the engine — the stored analysis keeps lines in SAN because that
 * is what gets displayed.
 */
export function sanLineToUci(fen: string, sanMoves: string[]): string[] {
  const board = new Chess(fen);
  const out: string[] = [];
  for (const san of sanMoves) {
    try {
      out.push(board.move(san).lan);
    } catch {
      break;
    }
  }
  return out;
}
