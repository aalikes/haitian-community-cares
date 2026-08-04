/**
 * Turning engine scores into something you can reason about.
 *
 * Raw centipawns are a bad yardstick for "how bad was that move" — dropping a
 * pawn when you are +9 barely matters, dropping one when you are level is the
 * whole game. So every judgement in this app goes through a win-probability
 * curve first and compares *probability* lost, not centipawns lost.
 */

export interface Score {
  /** Centipawns from the side-to-move's perspective, or null for a mate score. */
  cp: number | null;
  /** Mate distance in moves; positive = we mate, negative = we get mated. */
  mate: number | null;
}

/** Centipawn value we treat a forced mate as being worth. */
const MATE_CP = 10_000;

export function scoreToCp(score: Score): number {
  if (score.mate !== null) {
    return score.mate > 0 ? MATE_CP - score.mate * 10 : -MATE_CP - score.mate * 10;
  }
  return score.cp ?? 0;
}

export function negate(score: Score): Score {
  return {
    cp: score.cp === null ? null : -score.cp,
    mate: score.mate === null ? null : -score.mate,
  };
}

/**
 * Probability (0..1) that the side to move wins, treating a draw as half a
 * win. Logistic fit published by Lichess against millions of human games.
 */
export function winProbability(cp: number): number {
  const clamped = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 1 / (1 + Math.exp(-0.00368208 * clamped));
}

export function scoreToWinProbability(score: Score): number {
  return winProbability(scoreToCp(score));
}

/** "+1.35", "-0.40", "M4", "-M2" — the way it reads on a scoresheet. */
export function formatScore(score: Score): string {
  if (score.mate !== null) {
    return score.mate > 0 ? `M${score.mate}` : `-M${Math.abs(score.mate)}`;
  }
  const pawns = (score.cp ?? 0) / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "−" : "";
  return `${sign}${Math.abs(pawns).toFixed(2)}`;
}

/** Plain-English size of an advantage, for use inside a sentence. */
export function describeAdvantage(cpFromMoverView: number): string {
  const abs = Math.abs(cpFromMoverView);
  const who = cpFromMoverView >= 0 ? "you" : "your opponent";
  if (abs >= MATE_CP - 1000) return `${who} had a forced mate`;
  if (abs < 30) return "the position was dead level";
  if (abs < 90) return `${who} were slightly better`;
  if (abs < 250) return `${who} were clearly better`;
  if (abs < 600) return `${who} were winning`;
  return `${who} were completely winning`;
}
