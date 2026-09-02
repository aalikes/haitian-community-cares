import { isMistake } from "../chess/classify";
import { formatDuration } from "../chess/clock";
import { phaseOf } from "../chess/util";
import type {
  AnalysedMove,
  Color,
  GameTiming,
  PhaseLoss,
  TimingBucket,
  TimingFinding,
  TimingReport,
} from "../types";

/**
 * What the clock says about your chess.
 *
 * The engine tells you a move was bad. The clock often tells you *why* it was
 * bad — you played it in two seconds, or you played it with eleven seconds left
 * on a three-minute game. Those are different problems with different fixes,
 * and neither shows up in an accuracy percentage.
 *
 * Everything here is measured against your own pace in that game rather than
 * an absolute number of seconds, because "fast" in a bullet game and "fast" in
 * a rapid game are nowhere near the same thing.
 */

/** A bucket needs this many moves before a comparison means anything. */
const MIN_BUCKET = 3;

/** How much worse a bucket must be than the baseline before it is worth saying. */
const NOTABLE_RATIO = 1.4;

export interface GameTimingInput {
  moves: AnalysedMove[];
  hero: Color;
  baseSeconds: number;
  incrementSeconds: number;
  incrementInferred: boolean;
}

/**
 * Builds the per-game clock report, or returns null when the game carried no
 * usable clock data — most pasted PGNs, and every correspondence game where
 * "time spent" means nothing useful.
 */
export function buildGameTiming(input: GameTimingInput): GameTiming | null {
  const heroMoves = input.moves.filter(
    (move) => move.color === input.hero && typeof move.secondsSpent === "number",
  );
  if (heroMoves.length < 5) return null;

  const troubleThreshold = input.baseSeconds > 0 ? input.baseSeconds * 0.2 : 0;
  const report = summarise(heroMoves, troubleThreshold);

  const finalClock = lastClock(input.moves, input.hero);
  return {
    ...report,
    baseSeconds: input.baseSeconds,
    incrementSeconds: input.incrementSeconds,
    incrementInferred: input.incrementInferred,
    timeTroubleFromPly: firstTroublePly(heroMoves, troubleThreshold),
    finalClock,
  };
}

/**
 * Groups one player's moves by pace and reports how each group played.
 *
 * `troubleThreshold` is a clock reading, not a duration: moves made below it
 * are "in time trouble" regardless of how long they took.
 */
function summarise(moves: AnalysedMove[], troubleThreshold: number): TimingReport {
  const times = moves.map((move) => move.secondsSpent as number);
  const median = medianOf(times);
  const total = times.reduce((sum, value) => sum + value, 0);

  // Thresholds are relative to your own pace, with a floor so that a game
  // where you moved instantly throughout does not classify everything as slow.
  const fastThreshold = Math.max(0.5, median / 3);
  const slowThreshold = Math.max(2, median * 2);

  const rushed: AnalysedMove[] = [];
  const steady: AnalysedMove[] = [];
  const deliberate: AnalysedMove[] = [];
  const timeTrouble: AnalysedMove[] = [];
  const comfortable: AnalysedMove[] = [];

  const phaseSeconds: PhaseLoss = { opening: 0, middlegame: 0, endgame: 0 };

  for (const move of moves) {
    const seconds = move.secondsSpent as number;
    if (seconds < fastThreshold) rushed.push(move);
    else if (seconds > slowThreshold) deliberate.push(move);
    else steady.push(move);

    const clock = move.clockAfter;
    if (troubleThreshold > 0 && typeof clock === "number" && clock < troubleThreshold) {
      timeTrouble.push(move);
    } else {
      comfortable.push(move);
    }

    phaseSeconds[phaseOf(move.ply, move.fenBefore)] += seconds;
  }

  const report: TimingReport = {
    moves: moves.length,
    totalSeconds: total,
    medianSeconds: median,
    phaseSeconds,
    phaseShare: {
      opening: share(phaseSeconds.opening, total),
      middlegame: share(phaseSeconds.middlegame, total),
      endgame: share(phaseSeconds.endgame, total),
    },
    rushed: bucket(rushed),
    steady: bucket(steady),
    deliberate: bucket(deliberate),
    timeTrouble: bucket(timeTrouble),
    comfortable: bucket(comfortable),
    fastThreshold,
    slowThreshold,
    troubleThreshold,
    findings: [],
  };
  report.findings = deriveFindings(report);
  return report;
}

function bucket(moves: AnalysedMove[]): TimingBucket {
  const totalSeconds = moves.reduce((sum, move) => sum + (move.secondsSpent ?? 0), 0);
  const loss = moves.reduce((sum, move) => sum + move.winProbLost, 0);
  return {
    moves: moves.length,
    totalSeconds,
    averageSeconds: moves.length > 0 ? totalSeconds / moves.length : 0,
    averageLoss: moves.length > 0 ? loss / moves.length : 0,
    mistakes: moves.filter((move) => isMistake(move.quality)).length,
  };
}

/**
 * Turns the buckets into things worth saying out loud.
 *
 * Each finding needs both a big enough sample and a big enough gap — a single
 * fast blunder is a story, not a pattern, and telling someone to slow down on
 * that evidence would be noise.
 */
export function deriveFindings(report: TimingReport): TimingFinding[] {
  const findings: TimingFinding[] = [];

  // 1. Rushing. Compared against your steady moves, not against everything,
  //    so that a few long thinks cannot mask it.
  const baseline = report.steady.averageLoss;
  if (report.rushed.moves >= MIN_BUCKET && baseline > 0) {
    const ratio = report.rushed.averageLoss / baseline;
    if (ratio >= NOTABLE_RATIO) {
      findings.push({
        kind: "rushing",
        severity: ratio,
        text:
          `Moves you played in under ${formatDuration(report.fastThreshold)} cost ` +
          `${percent(report.rushed.averageLoss)} each — ${ratio.toFixed(1)}× what your ` +
          `normal-paced moves cost. ${report.rushed.mistakes} of your ` +
          `${report.rushed.moves} quick moves went wrong.`,
      });
    }
  }

  // 2. Time trouble.
  if (
    report.timeTrouble.moves >= MIN_BUCKET &&
    report.comfortable.moves >= MIN_BUCKET &&
    report.comfortable.averageLoss > 0
  ) {
    const ratio = report.timeTrouble.averageLoss / report.comfortable.averageLoss;
    if (ratio >= NOTABLE_RATIO) {
      findings.push({
        kind: "time-trouble",
        severity: ratio,
        text:
          `Once you were under ${formatDuration(report.troubleThreshold)} on the clock, ` +
          `your moves cost ${ratio.toFixed(1)}× more — ${percent(report.timeTrouble.averageLoss)} ` +
          `per move against ${percent(report.comfortable.averageLoss)} before that. ` +
          `The damage is happening in the scramble, not the game.`,
      });
    }
  }

  // 3. Clock spent on the opening, where the answers are memorised anyway.
  if (report.phaseShare.opening >= 0.35 && report.moves >= 12) {
    findings.push({
      kind: "opening-burn",
      severity: report.phaseShare.opening * 2,
      text:
        `${Math.round(report.phaseShare.opening * 100)}% of your thinking time went on the ` +
        `opening, before the position had anything to decide. That time is worth more ` +
        `later — the middlegame is where games are actually lost.`,
    });
  }

  // 4. Long thinks that did not buy anything.
  if (report.deliberate.moves >= MIN_BUCKET && baseline > 0) {
    const ratio = report.deliberate.averageLoss / baseline;
    if (ratio >= NOTABLE_RATIO) {
      findings.push({
        kind: "long-think-wasted",
        severity: ratio,
        text:
          `Your long thinks are not paying off: moves over ` +
          `${formatDuration(report.slowThreshold)} still cost ` +
          `${percent(report.deliberate.averageLoss)} each, worse than your quicker ones. ` +
          `That usually means the time is going on calculation in positions that call ` +
          `for a plan instead.`,
      });
    }
  }

  if (findings.length === 0 && report.moves >= 12) {
    findings.push({
      kind: "healthy",
      severity: 0,
      text:
        `No clock problem showing. Your fast, slow and time-trouble moves all cost about ` +
        `the same, so pace is not what is costing you points here.`,
    });
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

/**
 * Sums per-game reports into one picture.
 *
 * Buckets are combined rather than re-derived, because "fast" is defined
 * against the pace of the game it came from — three seconds is a long think in
 * bullet and an instant move in rapid, and pooling the raw times first would
 * blur the two into nonsense.
 */
export function aggregateTiming(reports: GameTiming[]): TimingReport | null {
  if (reports.length === 0) return null;

  const merged: TimingReport = {
    moves: 0,
    totalSeconds: 0,
    medianSeconds: 0,
    phaseSeconds: { opening: 0, middlegame: 0, endgame: 0 },
    phaseShare: { opening: 0, middlegame: 0, endgame: 0 },
    rushed: emptyBucket(),
    steady: emptyBucket(),
    deliberate: emptyBucket(),
    timeTrouble: emptyBucket(),
    comfortable: emptyBucket(),
    fastThreshold: 0,
    slowThreshold: 0,
    troubleThreshold: 0,
    findings: [],
  };

  for (const report of reports) {
    merged.moves += report.moves;
    merged.totalSeconds += report.totalSeconds;
    for (const phase of ["opening", "middlegame", "endgame"] as const) {
      merged.phaseSeconds[phase] += report.phaseSeconds[phase];
    }
    mergeBucket(merged.rushed, report.rushed);
    mergeBucket(merged.steady, report.steady);
    mergeBucket(merged.deliberate, report.deliberate);
    mergeBucket(merged.timeTrouble, report.timeTrouble);
    mergeBucket(merged.comfortable, report.comfortable);
  }

  for (const phase of ["opening", "middlegame", "endgame"] as const) {
    merged.phaseShare[phase] = share(merged.phaseSeconds[phase], merged.totalSeconds);
  }
  finishBucket(merged.rushed);
  finishBucket(merged.steady);
  finishBucket(merged.deliberate);
  finishBucket(merged.timeTrouble);
  finishBucket(merged.comfortable);

  merged.medianSeconds = medianOf(reports.map((report) => report.medianSeconds));
  // Thresholds differ per game, so the pooled figures are averages weighted by
  // move count — used for wording only, never for classifying.
  merged.fastThreshold = weighted(reports, (report) => report.fastThreshold);
  merged.slowThreshold = weighted(reports, (report) => report.slowThreshold);
  merged.troubleThreshold = weighted(reports, (report) => report.troubleThreshold);
  merged.findings = deriveFindings(merged);
  return merged;
}

function emptyBucket(): TimingBucket {
  return { moves: 0, totalSeconds: 0, averageSeconds: 0, averageLoss: 0, mistakes: 0 };
}

/** Accumulates counts and a running loss *total* into `averageLoss`. */
function mergeBucket(target: TimingBucket, source: TimingBucket): void {
  target.moves += source.moves;
  target.totalSeconds += source.totalSeconds;
  target.mistakes += source.mistakes;
  target.averageLoss += source.averageLoss * source.moves;
}

/** Converts the running totals left by `mergeBucket` back into averages. */
function finishBucket(target: TimingBucket): void {
  if (target.moves === 0) {
    target.averageSeconds = 0;
    target.averageLoss = 0;
    return;
  }
  target.averageSeconds = target.totalSeconds / target.moves;
  target.averageLoss = target.averageLoss / target.moves;
}

function weighted(reports: GameTiming[], pick: (report: GameTiming) => number): number {
  const total = reports.reduce((sum, report) => sum + report.moves, 0);
  if (total === 0) return 0;
  return reports.reduce((sum, report) => sum + pick(report) * report.moves, 0) / total;
}

function firstTroublePly(moves: AnalysedMove[], threshold: number): number | null {
  if (threshold <= 0) return null;
  for (const move of moves) {
    if (typeof move.clockAfter === "number" && move.clockAfter < threshold) return move.ply;
  }
  return null;
}

function lastClock(moves: AnalysedMove[], hero: Color): number | null {
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index]!;
    if (move.color === hero && typeof move.clockAfter === "number") return move.clockAfter;
  }
  return null;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
