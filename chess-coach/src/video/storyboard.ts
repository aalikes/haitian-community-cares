import { Chess } from "chess.js";
import { formatScore } from "../chess/evaluation";
import { parseUci } from "../chess/util";
import { sanToSpeech } from "../coach/notation";
import type { AnalysedMove } from "../types";

/**
 * A storyboard is the shot list for one explanation: what the board shows,
 * what the caption says, and what the narrator says over it.
 *
 * The same list drives both in-app playback (with live speech) and the
 * exported video file, so the two never drift apart.
 */

export type FrameKind = "neutral" | "played" | "punish" | "best";

export interface StoryFrame {
  /** Position at the *start* of the frame. */
  fen: string;
  caption: string;
  subCaption?: string;
  kind: FrameKind;
  /** The move made during this frame, animated from `from` to `to`. */
  move?: { from: string; to: string } | null;
  /** Arrow drawn for the whole frame, for "consider this" shots. */
  arrow?: { from: string; to: string } | null;
  /** Milliseconds this frame occupies. */
  durationMs: number;
  /** Spoken line, if the narrator should say something at the start of the frame. */
  say?: string;
}

const HOLD = 1500;
const MOVE = 900;

export function buildStoryboard(move: AnalysedMove, heroIsMover: boolean): StoryFrame[] {
  const frames: StoryFrame[] = [];
  const label = `${move.moveNumber}${move.color === "w" ? "." : "..."}${move.san}`;
  const who = heroIsMover ? "You" : "Your opponent";

  // 1. Set the scene, with an arrow showing the move that is about to happen.
  frames.push({
    fen: move.fenBefore,
    caption: `${label} — ${move.quality}`,
    subCaption: `${who} played ${move.san}. Evaluation ${formatScore(move.scoreBefore)}.`,
    kind: "neutral",
    arrow: arrowFor(move.uci),
    durationMs: HOLD + 400,
    say: `${who === "You" ? "You" : "Your opponent"} played ${sanToSpeech(move.san)}.`,
  });

  // 2. Play the move.
  frames.push({
    fen: move.fenBefore,
    caption: move.san,
    subCaption: `Evaluation drops to ${formatScore(move.scoreAfter)}.`,
    kind: "played",
    move: arrowFor(move.uci),
    durationMs: MOVE + 500,
  });

  // 3. Show the refutation, one move at a time.
  const punish = walk(move.fenAfter, move.punishLineSan.length, move.punishLineSan);
  punish.forEach((step, index) => {
    frames.push({
      fen: step.fenBefore,
      caption: step.san,
      subCaption: index === 0 ? "And this is the problem." : undefined,
      kind: "punish",
      move: { from: step.from, to: step.to },
      durationMs: MOVE + (index === 0 ? 500 : 200),
      say:
        index === 0
          ? `The answer is ${sanToSpeech(step.san)}.`
          : undefined,
    });
  });

  // 4. Rewind and show what should have happened.
  if (move.bestSan && move.bestUci && move.bestUci !== move.uci) {
    frames.push({
      fen: move.fenBefore,
      caption: `Instead: ${move.bestSan}`,
      subCaption: "Back to the position before the mistake.",
      kind: "neutral",
      arrow: arrowFor(move.bestUci),
      durationMs: HOLD,
      say: `Instead, play ${sanToSpeech(move.bestSan)}.`,
    });

    const best = walk(move.fenBefore, move.bestLineSan.length, move.bestLineSan);
    best.forEach((step, index) => {
      frames.push({
        fen: step.fenBefore,
        caption: step.san,
        subCaption: index === 0 ? "The engine's line." : undefined,
        kind: "best",
        move: { from: step.from, to: step.to },
        durationMs: MOVE + (index === 0 ? 300 : 100),
      });
    });
  }

  // 5. Land the point.
  const takeaway = move.coachNote ?? move.explanation ?? "";
  if (takeaway) {
    frames.push({
      fen: lastFen(frames) ?? move.fenAfter,
      caption: "Takeaway",
      subCaption: takeaway,
      kind: "neutral",
      durationMs: 3200,
      say: takeaway,
    });
  }

  return frames;
}

function arrowFor(uci: string | null): { from: string; to: string } | null {
  if (!uci) return null;
  const parts = parseUci(uci);
  return parts ? { from: parts.from, to: parts.to } : null;
}

interface Step {
  san: string;
  from: string;
  to: string;
  fenBefore: string;
  fenAfter: string;
}

/** Replays SAN moves from `fen`, collecting the squares each one uses. */
function walk(fen: string, limit: number, sanMoves: string[]): Step[] {
  const board = new Chess(fen);
  const steps: Step[] = [];
  for (const san of sanMoves.slice(0, Math.min(limit, 4))) {
    const fenBefore = board.fen();
    let move;
    try {
      move = board.move(san);
    } catch {
      break;
    }
    steps.push({
      san: move.san,
      from: move.from,
      to: move.to,
      fenBefore,
      fenAfter: board.fen(),
    });
  }
  return steps;
}

function lastFen(frames: StoryFrame[]): string | null {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    if (!frame.move) return frame.fen;
    const board = new Chess(frame.fen);
    try {
      board.move({ from: frame.move.from, to: frame.move.to, promotion: "q" });
      return board.fen();
    } catch {
      return frame.fen;
    }
  }
  return null;
}

export function storyboardDuration(frames: StoryFrame[]): number {
  return frames.reduce((total, frame) => total + frame.durationMs, 0);
}
