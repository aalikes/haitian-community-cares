import { QUALITY_LABELS, isMistake } from "../chess/classify";
import { describeAdvantage, formatScore, scoreToCp } from "../chess/evaluation";
import type { MotifResult } from "../chess/motifs";
import { formatSanLine } from "../chess/util";
import type { AnalysedMove } from "../types";
import { sanLineToSpeech, sanToSpeech } from "./notation";

export interface Commentary {
  headline: string;
  explanation: string;
  /** Same substance, phrased for a text-to-speech voice. */
  spoken: string;
}

/**
 * Builds the written and spoken explanation for one move.
 *
 * Everything here is derived from engine output and board facts — no guessing
 * at what the player was thinking. The goal is that each sentence points at
 * something the player can go and verify on the board.
 */
export function buildCommentary(
  move: AnalysedMove,
  motif: MotifResult,
  heroIsMover: boolean,
): Commentary {
  const label = QUALITY_LABELS[move.quality];
  const moveRef = `${move.moveNumber}${move.color === "w" ? "." : "..."}${move.san}`;
  const bestLine = formatSanLine(move.bestLineSan, move.moveNumber, move.color);
  const punishLine = formatSanLine(
    move.punishLineSan,
    move.color === "w" ? move.moveNumber : move.moveNumber + 1,
    move.color === "w" ? "b" : "w",
  );

  if (!isMistake(move.quality)) {
    return praise(move, moveRef, label, bestLine, heroIsMover);
  }

  const written: string[] = [];
  const spoken: string[] = [];
  const you = heroIsMover ? "you" : "your opponent";
  const your = heroIsMover ? "your" : "their";

  // 1. What went wrong.
  if (motif.tags.includes("allowed-mate")) {
    written.push(
      `${move.san} walks into a forced mate. ${punishLine || "The engine's line"} finishes it.`,
    );
    spoken.push(
      `${sanToSpeech(move.san)} walks into a forced mate. ${
        move.punishLineSan.length > 0 ? sanLineToSpeech(move.punishLineSan) + "." : ""
      }`,
    );
  } else if (motif.tags.includes("missed-mate")) {
    written.push(
      `There was a forced mate here — ${bestLine || move.bestSan} — and ${move.san} lets it go.`,
    );
    spoken.push(
      `There was a forced mate here. ${sanLineToSpeech(move.bestLineSan)}. ${sanToSpeech(
        move.san,
      )} let it slip.`,
    );
  } else if (motif.lostPiece && motif.materialSwing >= 1.5) {
    const cost =
      motif.materialSwing >= 8
        ? "decisive material"
        : `about ${Math.round(motif.materialSwing)} ${
            Math.round(motif.materialSwing) === 1 ? "pawn" : "pawns"
          } of material`;
    written.push(
      `${move.san} costs ${cost}: ${punishLine || "the reply"} picks up ${your} ${motif.lostPiece}.`,
    );
    spoken.push(
      `${sanToSpeech(move.san)} loses ${your} ${motif.lostPiece}. ${
        move.punishLineSan.length > 0
          ? `The refutation is ${sanLineToSpeech(move.punishLineSan, 3)}.`
          : ""
      }`,
    );
  } else if (motif.missedFreeMaterial && move.bestSan) {
    written.push(`${move.bestSan} was free material and ${move.san} passes it up.`);
    spoken.push(
      `${sanToSpeech(move.bestSan)} was free material. ${sanToSpeech(move.san)} passed it up.`,
    );
  } else {
    const swing = describeAdvantage(scoreToCp(move.scoreBefore));
    written.push(
      `Before ${move.san}, ${swing}. The move gives up ${Math.round(
        move.winProbLost * 100,
      )}% of ${your} practical chances without an obvious tactical reason — it is a positional slip.`,
    );
    spoken.push(
      `${sanToSpeech(move.san)} is a positional slip. It costs about ${Math.round(
        move.winProbLost * 100,
      )} percent of ${your} chances.`,
    );
  }

  // 2. What to do instead.
  if (move.bestSan && move.bestUci !== move.uci) {
    if (motif.tags.includes("allowed-fork") && motif.forkSquare) {
      written.push(
        `The problem is the fork on ${motif.forkSquare}. ${move.bestSan} keeps ${your} pieces off the forking squares` +
          (bestLine ? `: ${bestLine}.` : "."),
      );
    } else {
      written.push(`Instead: ${bestLine || move.bestSan}.`);
    }
    spoken.push(`Play ${sanToSpeech(move.bestSan)} instead.`);
  }

  // 3. The scoreboard, so the size of the error is concrete.
  written.push(
    `Evaluation ${formatScore(move.scoreBefore)} → ${formatScore(move.scoreAfter)} from ${
      heroIsMover ? "your" : "their"
    } side of the board.`,
  );

  // 4. The takeaway, if a motif gives us one worth repeating.
  const lesson = lessonFor(motif);
  if (lesson) {
    written.push(lesson);
    spoken.push(lesson);
  }

  return {
    headline: `${label} · ${moveRef}`,
    explanation: written.join(" "),
    spoken: `${moveRef.replace(/\./g, " ")}. ${spoken.filter(Boolean).join(" ")}`.replace(
      /\s+/g,
      " ",
    ),
  };

  function lessonFor(result: MotifResult): string | null {
    if (result.tags.includes("hanging-piece")) {
      return `The piece was undefended before ${you} moved — a quick sweep for loose pieces catches this one.`;
    }
    if (result.tags.includes("allowed-fork")) {
      return "Ask what the opponent's knight or queen hits after your move, not just what it hits now.";
    }
    if (result.tags.includes("missed-tactic")) {
      return "Checks, captures, threats — in that order — before settling on a move.";
    }
    return null;
  }
}

function praise(
  move: AnalysedMove,
  moveRef: string,
  label: string,
  bestLine: string,
  heroIsMover: boolean,
): Commentary {
  const subject = heroIsMover ? "You" : "Your opponent";
  if (move.quality === "brilliant") {
    return {
      headline: `${label} · ${moveRef}`,
      explanation: `${move.san} was the only move that held the position together — every alternative was clearly worse. Continuation: ${
        bestLine || move.san
      }.`,
      spoken: `${sanToSpeech(move.san)} was the only move. Well found.`,
    };
  }
  if (move.quality === "best") {
    return {
      headline: `${label} · ${moveRef}`,
      explanation: `${subject} found the engine's first choice. Continuation: ${bestLine || move.san}.`,
      spoken: `${sanToSpeech(move.san)} is the engine's first choice.`,
    };
  }
  return {
    headline: `${label} · ${moveRef}`,
    explanation: `${move.san} keeps the evaluation steady at ${formatScore(move.scoreAfter)}.${
      move.bestSan && move.bestSan !== move.san ? ` ${move.bestSan} was marginally sharper.` : ""
    }`,
    spoken: `${sanToSpeech(move.san)} is fine.`,
  };
}

/** One-line summary of a whole game, for the review header. */
export function summariseGame(
  accuracy: number,
  counts: Record<string, number>,
  result: "win" | "loss" | "draw" | "unknown",
): string {
  const blunders = counts.blunder ?? 0;
  const mistakes = counts.mistake ?? 0;
  const inaccuracies = counts.inaccuracy ?? 0;
  const errors: string[] = [];
  if (blunders) errors.push(`${blunders} blunder${blunders === 1 ? "" : "s"}`);
  if (mistakes) errors.push(`${mistakes} mistake${mistakes === 1 ? "" : "s"}`);
  if (inaccuracies) errors.push(`${inaccuracies} inaccurac${inaccuracies === 1 ? "y" : "ies"}`);

  const errorText = errors.length > 0 ? errors.join(", ") : "no significant errors";
  const outcome =
    result === "win"
      ? "You won"
      : result === "loss"
        ? "You lost"
        : result === "draw"
          ? "Drawn"
          : "Result unknown";

  return `${outcome} · ${accuracy.toFixed(1)}% accuracy · ${errorText}.`;
}
