import { Chess } from "chess.js";
import { isMistake } from "../chess/classify";
import { WEAKNESS_LABELS, type Drill, type GameRecord, type WeaknessTag } from "../types";
import type { Profile } from "./profile";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Turns the mistakes in one analysed game into practice positions.
 *
 * Every drill is a position you actually reached, so the practice is not
 * generic tactics — it is the exact shape of problem you keep losing to.
 */
export function drillsFromGame(game: GameRecord): Drill[] {
  const analysis = game.analysis;
  if (!analysis) return [];

  const drills: Drill[] = [];
  for (const move of analysis.moves) {
    if (move.color !== analysis.hero) continue;
    if (!isMistake(move.quality)) continue;
    if (!move.bestUci || !move.bestSan) continue;
    // Inaccuracies make weak drills — the "right" answer is rarely findable.
    if (move.quality === "inaccuracy") continue;

    drills.push({
      id: `${game.id}#${move.ply}`,
      gameId: game.id,
      ply: move.ply,
      fen: move.fenBefore,
      sideToMove: move.color,
      bestUci: move.bestUci,
      bestSan: move.bestSan,
      playedSan: move.san,
      quality: move.quality,
      tags: move.tags,
      prompt: promptFor(move.tags, move.quality),
      attempts: 0,
      solved: 0,
      lastSeenAt: null,
      dueAt: Date.now(),
    });
  }
  return drills;
}

function promptFor(tags: WeaknessTag[], quality: string): string {
  if (tags.includes("missed-mate")) return "There is a forced mate. Find it.";
  if (tags.includes("allowed-mate")) return "Your king is in danger. Find the safe move.";
  if (tags.includes("missed-capture")) return "There is material to be won. Take it.";
  if (tags.includes("hanging-piece")) return "One of your pieces is loose. Find the best move.";
  if (tags.includes("allowed-fork")) return "A fork is coming. Prevent it.";
  if (tags.includes("missed-tactic")) return "There is a tactic here. Find the strongest move.";
  if (tags.includes("endgame")) return "Endgame technique. Find the most accurate move.";
  return quality === "blunder"
    ? "You blundered here. Find the move you should have played."
    : "Find the best move.";
}

export interface DrillSelection {
  drills: Drill[];
  /** Which weakness the session is aimed at, when the queue is targeted. */
  focus: WeaknessTag | null;
  focusLabel: string | null;
}

/**
 * Picks a session's worth of drills: due ones first, weighted towards the
 * weaknesses that show up most often across your games.
 */
export function selectDrills(
  drills: Drill[],
  profile: Profile,
  count = 8,
): DrillSelection {
  const now = Date.now();
  const due = drills.filter((drill) => drill.dueAt <= now);
  const pool = due.length >= count ? due : drills;

  const focus = profile.weaknesses[0]?.tag ?? null;
  const priority = new Map<WeaknessTag, number>();
  profile.weaknesses.forEach((weakness, index) => {
    priority.set(weakness.tag, profile.weaknesses.length - index);
  });

  const scored = pool
    .map((drill) => ({ drill, score: scoreDrill(drill, priority, now) }))
    .sort((a, b) => b.score - a.score);

  return {
    drills: scored.slice(0, count).map((entry) => entry.drill),
    focus,
    focusLabel: focus ? WEAKNESS_LABELS[focus] : null,
  };
}

function scoreDrill(drill: Drill, priority: Map<WeaknessTag, number>, now: number): number {
  let score = drill.quality === "blunder" ? 3 : 1;
  for (const tag of drill.tags) score += priority.get(tag) ?? 0;
  // Unseen drills first, then the ones you have got wrong most often.
  if (drill.attempts === 0) score += 4;
  else score += 3 * (1 - drill.solved / drill.attempts);
  // Mild recency penalty so a session does not repeat itself.
  if (drill.lastSeenAt && now - drill.lastSeenAt < DAY) score -= 5;
  return score;
}

/**
 * Records an attempt and schedules the next showing. Correct answers back off
 * quickly (1, 3, 9, 27 days); a wrong answer resets to tomorrow.
 */
export function recordAttempt(drill: Drill, correct: boolean): Drill {
  const attempts = drill.attempts + 1;
  const solved = drill.solved + (correct ? 1 : 0);
  const streak = correct ? solved : 0;
  const interval = correct ? Math.min(30, 3 ** Math.max(0, streak - 1)) : 1;
  return {
    ...drill,
    attempts,
    solved,
    lastSeenAt: Date.now(),
    dueAt: Date.now() + interval * DAY,
  };
}

/**
 * Is the move the user played on a drill the right answer? Accepts any move
 * that transposes to the same position as the engine's choice, which matters
 * for promotions and equivalent captures.
 */
export function isDrillSolved(drill: Drill, playedUci: string): boolean {
  if (playedUci === drill.bestUci) return true;
  // Compare resulting positions so e.g. "e7e8q" and "e7e8" both count.
  const target = positionAfter(drill.fen, drill.bestUci);
  const attempt = positionAfter(drill.fen, playedUci);
  return Boolean(target && attempt && target === attempt);
}

function positionAfter(fen: string, uci: string): string | null {
  if (uci.length < 4) return null;
  const board = new Chess(fen);
  try {
    board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }
  return board.fen().split(" ").slice(0, 4).join(" ");
}
