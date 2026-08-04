import { Chess } from "chess.js";
import {
  accuracyFromMoveAccuracies,
  classifyMove,
  isMistake,
  moveAccuracy,
  volatilityWeight,
  volatilityWindow,
} from "../chess/classify";
import { negate, scoreToWinProbability, type Score } from "../chess/evaluation";
import { detectMotifs } from "../chess/motifs";
import { parsePgn, phaseOf, pvToSan, sanLineToUci } from "../chess/util";
import { buildCommentary } from "../coach/commentary";
import type {
  AnalysedMove,
  Color,
  GameAnalysis,
  GameRecord,
  MoveQuality,
  PhaseLoss,
  WeaknessTag,
} from "../types";
import { MOVE_QUALITIES } from "../types";
import { getEngine, type EngineLine, type SearchResult } from "./engine";

// Bump whenever a change alters the numbers a stored analysis would produce.
// Games analysed under an older version keep their old figures until
// re-analysed, and the review screen says so rather than mixing the two
// silently. v2: adopted Lichess's thresholds and accuracy curve.
export const ANALYSIS_VERSION = 2;

export interface AnalyseOptions {
  depth?: number;
  multiPv?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Runs a full game through the engine.
 *
 * The whole thing costs one search per *position*, not two per move: the
 * evaluation of the position after your move is just the negation of the
 * engine's best score in the next position, which we have to search anyway.
 * That halves analysis time on a phone.
 */
export async function analyseGame(
  game: GameRecord,
  options: AnalyseOptions = {},
): Promise<GameAnalysis> {
  const depth = options.depth ?? 14;
  const multiPv = Math.max(2, options.multiPv ?? 3);
  const { moves } = parsePgn(game.pgn);
  if (moves.length === 0) throw new Error("This game has no moves to analyse.");

  // One FEN per position: before move 0, then after every move.
  const positions: string[] = [moves[0]!.before, ...moves.map((move) => move.after)];
  const searches: (SearchResult | null)[] = new Array(positions.length).fill(null);
  const engine = getEngine();

  for (let index = 0; index < positions.length; index += 1) {
    if (options.signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
    const fen = positions[index]!;
    if (isTerminal(fen)) {
      searches[index] = null; // nothing to search; handled by terminalScore()
    } else {
      searches[index] = await engine.analyse(fen, { depth, multiPv });
    }
    options.onProgress?.(index + 1, positions.length);
  }

  const analysed: AnalysedMove[] = [];

  for (let ply = 0; ply < moves.length; ply += 1) {
    const move = moves[ply]!;
    const mover = move.color as Color;
    const before = searches[ply];
    const after = searches[ply + 1];

    const bestLine = before?.lines[0] ?? null;
    const secondLine = before?.lines[1] ?? null;
    const scoreBefore = bestLine ? lineScore(bestLine) : terminalScore(move.before);
    const scoreAfter = after
      ? negate(after.lines[0] ? lineScore(after.lines[0]) : { cp: 0, mate: null })
      : negate(terminalScore(move.after));

    const bestUci = before?.bestMove ?? null;
    const playedBest = bestUci === move.lan || bestLine?.pv[0] === move.lan;

    const classification = classifyMove({
      scoreBefore,
      scoreAfter,
      playedBest,
      secondBestScore: secondLine ? lineScore(secondLine) : null,
    });

    const bestLineUci = bestLine?.pv ?? [];
    const punishLineUci = after?.lines[0]?.pv ?? [];

    const entry: AnalysedMove = {
      ply,
      moveNumber: Math.floor(ply / 2) + 1,
      color: mover,
      san: move.san,
      uci: move.lan,
      fenBefore: move.before,
      fenAfter: move.after,
      scoreBefore,
      scoreAfter,
      winProbLost: classification.winProbLost,
      centipawnLoss: classification.centipawnLoss,
      quality: classification.quality,
      bestUci,
      bestSan: bestUci ? (pvToSan(move.before, [bestUci], 1)[0] ?? null) : null,
      bestLineSan: pvToSan(move.before, bestLineUci, 6),
      punishLineSan: pvToSan(move.after, punishLineUci, 5),
      tags: [],
    };

    const motif = detectMotifs({
      ply,
      mover,
      fenBefore: move.before,
      fenAfter: move.after,
      playedUci: move.lan,
      bestUci,
      bestLineUci,
      punishLineUci,
      scoreBefore,
      scoreAfter,
      winProbLost: classification.winProbLost,
    });
    entry.tags = motif.tags;

    const commentary = buildCommentary(entry, motif, mover === game.hero);
    entry.headline = commentary.headline;
    entry.explanation = commentary.explanation;
    entry.spoken = commentary.spoken;

    analysed.push(entry);
  }

  return {
    version: ANALYSIS_VERSION,
    depth,
    hero: game.hero,
    moves: analysed,
    ...aggregate(analysed, game.hero),
    completedAt: Date.now(),
  };
}

/**
 * Re-points an existing analysis at the other player, without touching the
 * engine.
 *
 * Everything the engine produced — scores, best moves, lines — is
 * side-independent, so switching who "you" are only needs the motifs and the
 * commentary regenerated and the hero-side aggregates recomputed. That makes
 * "actually I was Black" instant instead of a re-analysis.
 */
export function rescopeAnalysis(analysis: GameAnalysis, hero: Color): GameAnalysis {
  const moves = analysis.moves.map((move) => {
    const motif = detectMotifs({
      ply: move.ply,
      mover: move.color,
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      playedUci: move.uci,
      bestUci: move.bestUci,
      bestLineUci: sanLineToUci(move.fenBefore, move.bestLineSan),
      punishLineUci: sanLineToUci(move.fenAfter, move.punishLineSan),
      scoreBefore: move.scoreBefore,
      scoreAfter: move.scoreAfter,
      winProbLost: move.winProbLost,
    });
    const commentary = buildCommentary(move, motif, move.color === hero);
    return {
      ...move,
      tags: motif.tags,
      headline: commentary.headline,
      explanation: commentary.explanation,
      spoken: commentary.spoken,
    };
  });

  return { ...analysis, hero, moves, ...aggregate(moves, hero) };
}

type Aggregates = Pick<
  GameAnalysis,
  "accuracy" | "averageCentipawnLoss" | "counts" | "phaseLoss" | "tagCounts"
>;

/** Summarises one side's play across a move list. */
function aggregate(moves: AnalysedMove[], hero: Color): Aggregates {
  const counts = emptyCounts();
  const tagCounts: Partial<Record<WeaknessTag, number>> = {};
  const lossTotals: PhaseLoss = { opening: 0, middlegame: 0, endgame: 0 };
  const moveTotals: PhaseLoss = { opening: 0, middlegame: 0, endgame: 0 };
  const accuracies: number[] = [];
  const weights: number[] = [];
  let heroMoves = 0;
  let cpLossTotal = 0;

  // Win percentages from White's point of view, one per position after a move.
  // Volatility is measured on this series, not on the losses, so a wild
  // position weighs more than a dead one regardless of who erred.
  const winPercents = moves.map((move) => {
    const fromMover = scoreToWinProbability(move.scoreAfter) * 100;
    return move.color === "w" ? fromMover : 100 - fromMover;
  });
  const window = volatilityWindow(winPercents.length);

  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index]!;
    if (move.color !== hero) continue;

    heroMoves += 1;
    cpLossTotal += move.centipawnLoss;
    counts[move.quality] += 1;
    accuracies.push(moveAccuracy(move.winProbLost));
    weights.push(
      volatilityWeight(winPercents.slice(Math.max(0, index - window + 1), index + 1)),
    );

    const phase = phaseOf(move.ply, move.fenBefore);
    lossTotals[phase] += move.winProbLost;
    moveTotals[phase] += 1;

    if (isMistake(move.quality)) {
      for (const tag of move.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  return {
    accuracy: accuracyFromMoveAccuracies(accuracies, weights),
    averageCentipawnLoss: heroMoves > 0 ? Math.round(cpLossTotal / heroMoves) : 0,
    counts,
    phaseLoss: {
      opening: average(lossTotals.opening, moveTotals.opening),
      middlegame: average(lossTotals.middlegame, moveTotals.middlegame),
      endgame: average(lossTotals.endgame, moveTotals.endgame),
    },
    tagCounts,
  };
}

function average(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

function lineScore(line: EngineLine): Score {
  return { cp: line.cp, mate: line.mate };
}

function isTerminal(fen: string): boolean {
  const board = new Chess(fen);
  return board.isGameOver();
}

/** Score of a finished position from the side-to-move's perspective. */
function terminalScore(fen: string): Score {
  const board = new Chess(fen);
  if (board.isCheckmate()) return { cp: null, mate: -1 };
  return { cp: 0, mate: null };
}

function emptyCounts(): Record<MoveQuality, number> {
  const counts = {} as Record<MoveQuality, number>;
  for (const quality of MOVE_QUALITIES) counts[quality] = 0;
  return counts;
}
