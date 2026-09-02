import { Chess, type Square } from "chess.js";
import type { Color, WeaknessTag } from "../types";
import type { Score } from "./evaluation";
import {
  PIECE_NAMES,
  PIECE_VALUES,
  materialBalance,
  opposite,
  parseUci,
  phaseOf,
} from "./util";

export interface MotifInput {
  ply: number;
  mover: Color;
  fenBefore: string;
  fenAfter: string;
  /** The move actually played, UCI. */
  playedUci: string;
  /** The move the engine wanted, UCI. */
  bestUci: string | null;
  /** Engine's line from `fenBefore`, UCI. */
  bestLineUci: string[];
  /** Opponent's best continuation from `fenAfter`, UCI. */
  punishLineUci: string[];
  scoreBefore: Score;
  scoreAfter: Score;
  winProbLost: number;
}

export interface MotifResult {
  tags: WeaknessTag[];
  /** Human-readable name of the biggest piece the mover loses in the punish line. */
  lostPiece: string | null;
  /** Material the mover ends up down over the punish line, in pawn units. */
  materialSwing: number;
  /** True when the engine's move was a capture of an undefended enemy piece. */
  missedFreeMaterial: boolean;
  /** Square of the fork, if one was allowed. */
  forkSquare: string | null;
}

// Matches the inaccuracy threshold in classify.ts: below this a "loss" is
// mostly search noise, and tagging it would pollute the weakness profile.
const LOSS_NOTICEABLE = 0.1;

export function detectMotifs(input: MotifInput): MotifResult {
  const tags = new Set<WeaknessTag>();
  const opponent = opposite(input.mover);

  // --- mate motifs -------------------------------------------------------
  const hadMate = input.scoreBefore.mate !== null && input.scoreBefore.mate > 0;
  const keptMate = input.scoreAfter.mate !== null && input.scoreAfter.mate > 0;
  if (hadMate && !keptMate) tags.add("missed-mate");
  if (input.scoreAfter.mate !== null && input.scoreAfter.mate < 0) {
    tags.add("allowed-mate");
    tags.add("king-safety");
  }

  // --- what the punish line actually wins --------------------------------
  const punish = walkLine(input.fenAfter, input.punishLineUci, 6);
  const balanceBefore = materialBalance(input.fenAfter, input.mover);
  const balanceAfter = punish.finalFen
    ? materialBalance(punish.finalFen, input.mover)
    : balanceBefore;
  const materialSwing = balanceBefore - balanceAfter;

  if (materialSwing >= 1.5 && input.winProbLost >= LOSS_NOTICEABLE) {
    tags.add("lost-material");
    if (punish.biggestVictim === "q") tags.add("lost-queen");
  }

  // A hanging piece is the special case where the very first reply just takes
  // something the mover left undefended.
  const firstReply = input.punishLineUci[0];
  if (firstReply && materialSwing >= 1.5) {
    const victim = victimOfCapture(input.fenAfter, firstReply);
    if (victim && wasUndefended(input.fenAfter, firstReply, input.mover)) {
      tags.add("hanging-piece");
    }
  }

  // --- what the mover walked past ---------------------------------------
  let missedFreeMaterial = false;
  if (input.bestUci && input.bestUci !== input.playedUci) {
    const bestVictim = victimOfCapture(input.fenBefore, input.bestUci);
    if (
      bestVictim &&
      (PIECE_VALUES[bestVictim] ?? 0) >= 3 &&
      wasUndefended(input.fenBefore, input.bestUci, opponent) &&
      input.winProbLost >= LOSS_NOTICEABLE
    ) {
      tags.add("missed-capture");
      missedFreeMaterial = true;
    }
    if (input.winProbLost >= 0.1 && isForcing(input.fenBefore, input.bestUci)) {
      tags.add("missed-tactic");
    }
  }

  // --- forks the mover allowed ------------------------------------------
  let forkSquare: string | null = null;
  if (firstReply && input.winProbLost >= LOSS_NOTICEABLE) {
    forkSquare = detectFork(input.fenAfter, firstReply);
    if (forkSquare) tags.add("allowed-fork");
  }

  // --- softer, positional buckets ---------------------------------------
  if (input.winProbLost >= LOSS_NOTICEABLE) {
    if (punish.gaveCheck && !tags.has("allowed-mate")) tags.add("king-safety");

    const phase = phaseOf(input.ply, input.fenBefore);
    if (phase === "opening") tags.add("opening");
    if (phase === "endgame") tags.add("endgame");

    const played = describeMove(input.fenBefore, input.playedUci);
    if (
      played?.piece === "p" &&
      !played.captured &&
      !tags.has("lost-material") &&
      !tags.has("allowed-mate")
    ) {
      tags.add("pawn-structure");
    }
  }

  return {
    tags: [...tags],
    lostPiece: punish.biggestVictim ? (PIECE_NAMES[punish.biggestVictim] ?? null) : null,
    materialSwing,
    missedFreeMaterial,
    forkSquare,
  };
}

interface WalkResult {
  finalFen: string | null;
  /** Piece type of the most valuable mover piece captured along the line. */
  biggestVictim: string | null;
  gaveCheck: boolean;
}

/** Plays `line` out from `fen`, reporting what the side that moves first wins. */
function walkLine(fen: string, line: string[], limit: number): WalkResult {
  const board = new Chess(fen);
  const attacker = board.turn();
  let biggestVictim: string | null = null;
  let biggestValue = 0;
  let gaveCheck = false;
  let played = 0;

  for (const uci of line.slice(0, limit)) {
    const parts = parseUci(uci);
    if (!parts) break;
    let move;
    try {
      move = board.move(parts);
    } catch {
      break;
    }
    played += 1;
    if (move.color === attacker) {
      if (move.captured) {
        const value = PIECE_VALUES[move.captured] ?? 0;
        if (value > biggestValue) {
          biggestValue = value;
          biggestVictim = move.captured;
        }
      }
      if (board.isCheck()) gaveCheck = true;
    }
  }

  return {
    finalFen: played > 0 ? board.fen() : null,
    biggestVictim,
    gaveCheck,
  };
}

function describeMove(fen: string, uci: string) {
  const parts = parseUci(uci);
  if (!parts) return null;
  const board = new Chess(fen);
  try {
    return board.move(parts);
  } catch {
    return null;
  }
}

/** Piece type captured by `uci`, or null if it is not a capture. */
function victimOfCapture(fen: string, uci: string): string | null {
  const move = describeMove(fen, uci);
  return move?.captured ?? null;
}

/** Was the piece standing on the capture target square undefended? */
function wasUndefended(fen: string, uci: string, owner: Color): boolean {
  const parts = parseUci(uci);
  if (!parts) return false;
  const board = new Chess(fen);
  const target = board.get(parts.to);
  if (!target || target.color !== owner) return false;
  board.remove(parts.to);
  return !board.isAttacked(parts.to, owner);
}

/** A check or a capture — the two move types most tactics start with. */
function isForcing(fen: string, uci: string): boolean {
  const move = describeMove(fen, uci);
  if (!move) return false;
  return Boolean(move.captured) || move.san.includes("+") || move.san.includes("#");
}

/**
 * After `reply` is played from `fen`, does the landing piece hit two or more
 * things the moving side's opponent cannot afford to lose? Returns the fork square.
 */
function detectFork(fen: string, reply: string): string | null {
  const parts = parseUci(reply);
  if (!parts) return null;
  const board = new Chess(fen);
  let move;
  try {
    move = board.move(parts);
  } catch {
    return null;
  }
  const forkerValue = PIECE_VALUES[move.promotion ?? move.piece] ?? 0;
  const attacker = move.color;

  // The position now has `victim` to move. Flip the turn so we can enumerate
  // what the newly-placed piece attacks.
  const flipped = withTurn(board.fen(), attacker);
  let probe: Chess;
  try {
    probe = new Chess(flipped);
  } catch {
    return null;
  }

  let threats = 0;
  for (const candidate of probe.moves({ square: parts.to, verbose: true })) {
    if (!candidate.captured) continue;
    if ((PIECE_VALUES[candidate.captured] ?? 0) >= Math.max(forkerValue, 3)) threats += 1;
  }
  // A check plus an attack on a real piece is a fork too.
  if (board.isCheck() && threats >= 1) return parts.to;
  return threats >= 2 ? parts.to : null;
}

/** Rewrites a FEN's active-colour field, clearing en passant so it stays legal. */
function withTurn(fen: string, turn: Color): string {
  const fields = fen.split(" ");
  if (fields.length < 6) return fen;
  fields[1] = turn;
  fields[3] = "-";
  return fields.join(" ");
}

export function squareName(square: string): Square {
  return square as Square;
}
