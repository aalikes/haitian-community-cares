import type { MoveQuality } from "../types";
import { scoreToCp, scoreToWinProbability, type Score } from "./evaluation";

/**
 * Thresholds in win probability lost (0..1), not centipawns.
 *
 * A blunder is "you gave away roughly a third of your winning chances", which
 * is a stable definition whether the position was level or already lost.
 *
 * These are Lichess's published values (`Advice.scala`) rather than our own,
 * deliberately: a player who sees "2 mistakes" here and "2 mistakes" on Lichess
 * should be looking at the same two moves. Tightening them would flag more
 * moves, but the count would stop meaning anything comparable.
 */
export const QUALITY_THRESHOLDS = {
  blunder: 0.3,
  mistake: 0.2,
  inaccuracy: 0.1,
} as const;

export interface ClassifyInput {
  /** Best score available to the mover before moving. Mover's perspective. */
  scoreBefore: Score;
  /** Score after the move actually played. Mover's perspective. */
  scoreAfter: Score;
  /** Was the played move the engine's first choice? */
  playedBest: boolean;
  /**
   * Score of the engine's second-choice move, mover's perspective. Used to spot
   * "only move" situations, where finding the best move genuinely mattered.
   */
  secondBestScore: Score | null;
}

export interface Classification {
  quality: MoveQuality;
  winProbLost: number;
  centipawnLoss: number;
}

export function classifyMove(input: ClassifyInput): Classification {
  const wpBefore = scoreToWinProbability(input.scoreBefore);
  const wpAfter = scoreToWinProbability(input.scoreAfter);
  // The engine's own preference is the ceiling; a move can't beat it, and small
  // negatives are just search noise between two depths.
  const winProbLost = Math.max(0, wpBefore - wpAfter);

  const cpBefore = scoreToCp(input.scoreBefore);
  const cpAfter = scoreToCp(input.scoreAfter);
  // Clamp so one lost-on-move-40 position doesn't dominate the average.
  const centipawnLoss = Math.min(1000, Math.max(0, cpBefore - cpAfter));

  let quality: MoveQuality;
  if (winProbLost >= QUALITY_THRESHOLDS.blunder) {
    quality = "blunder";
  } else if (winProbLost >= QUALITY_THRESHOLDS.mistake) {
    quality = "mistake";
  } else if (winProbLost >= QUALITY_THRESHOLDS.inaccuracy) {
    quality = "inaccuracy";
  } else if (input.playedBest) {
    quality = isOnlyMove(input) ? "brilliant" : "best";
  } else {
    quality = "good";
  }

  return { quality, winProbLost, centipawnLoss };
}

/**
 * "Brilliant" here means something specific and checkable: you played the best
 * move, and every alternative was materially worse. No guessing at intent.
 */
function isOnlyMove(input: ClassifyInput): boolean {
  if (!input.secondBestScore) return false;
  const best = scoreToWinProbability(input.scoreBefore);
  const second = scoreToWinProbability(input.secondBestScore);
  return best - second >= 0.15;
}

// Lichess's accuracy curve, from lila's AccuracyPercent.scala. Reproduced
// exactly — including the `+1` uncertainty bonus — so the number this app shows
// is the number the player already knows from elsewhere.
const CURVE_SCALE = 103.1668100711649;
const CURVE_DECAY = -0.04354415386753951;
const CURVE_SHIFT = -3.166924740191411;

/** Accuracy (0..100) of one move, given the win probability it gave away (0..1). */
export function moveAccuracy(winProbLost: number): number {
  const lostPercent = Math.max(0, winProbLost) * 100;
  const raw = CURVE_SCALE * Math.exp(CURVE_DECAY * lostPercent) + CURVE_SHIFT;
  return clamp(raw + 1, 0, 100);
}

/**
 * Game accuracy from per-move accuracies.
 *
 * Lichess blends a volatility-weighted arithmetic mean with a harmonic mean and
 * halves the sum. The weighting discounts quiet positions where a "loss" is
 * mostly engine noise; the harmonic mean stops a single catastrophe being
 * averaged away by forty quiet moves. Both matter, so both are kept.
 */
export function accuracyFromMoveAccuracies(
  accuracies: number[],
  weights: number[],
): number {
  if (accuracies.length === 0) return 100;
  const weighted = weightedMean(accuracies, weights);
  const harmonic = harmonicMean(accuracies);
  return round1(clamp((weighted + harmonic) / 2, 0, 100));
}

/**
 * Accuracy from raw losses, with every move weighted equally. Used when the
 * position sequence is not available — for instance pooling moves across many
 * games for the long-term profile.
 */
export function accuracyFromLosses(losses: number[]): number {
  const accuracies = losses.map(moveAccuracy);
  return accuracyFromMoveAccuracies(
    accuracies,
    accuracies.map(() => 1),
  );
}

/** Sliding-window size Lichess uses for volatility: 2..8, by game length. */
export function volatilityWindow(positionCount: number): number {
  return clamp(Math.floor(positionCount / 10), 2, 8);
}

/**
 * Volatility of a window of win percentages (0..100), clamped to Lichess's
 * range. A sharp, swinging position weighs more than a dead one.
 */
export function volatilityWeight(window: number[]): number {
  return clamp(standardDeviation(window), 0.5, 12);
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function weightedMean(values: number[], weights: number[]): number {
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = weights[index] ?? 1;
    total += values[index]! * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? total / weightTotal : 100;
}

function harmonicMean(values: number[]): number {
  // Floor each term at 1: a genuine 0 would otherwise make the mean 0 outright.
  const reciprocalSum = values.reduce((sum, value) => sum + 1 / Math.max(value, 1), 0);
  return reciprocalSum > 0 ? values.length / reciprocalSum : 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export const QUALITY_LABELS: Record<MoveQuality, string> = {
  brilliant: "Only move",
  best: "Best",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

export const QUALITY_COLORS: Record<MoveQuality, string> = {
  brilliant: "#4cc2b0",
  best: "#6fae5a",
  good: "#9aa47c",
  inaccuracy: "#e8b44a",
  mistake: "#e08640",
  blunder: "#d1524f",
};

export function isMistake(quality: MoveQuality): boolean {
  return quality === "inaccuracy" || quality === "mistake" || quality === "blunder";
}
