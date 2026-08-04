import Anthropic from "@anthropic-ai/sdk";
import { formatScore } from "../chess/evaluation";
import { formatSanLine } from "../chess/util";
import type { GameRecord, WeaknessTag } from "../types";
import { WEAKNESS_LABELS } from "../types";
import type { Profile } from "./profile";

/**
 * Optional layer: the rule-based commentary in commentary.ts always works and
 * needs no network. This adds a coach's voice on top — connecting the dots
 * across a whole game and across your history — when you supply an API key.
 *
 * The key is stored in this browser's IndexedDB and is sent only to
 * api.anthropic.com. Calling the API straight from a browser means the key is
 * visible to anything running on the page, which is fine for a personal build
 * and not fine for a shared deployment — see the README.
 */

const MODEL = "claude-opus-5";

export interface CoachNote {
  ply: number;
  note: string;
}

export interface CoachReport {
  summary: string;
  plan: string[];
  notes: CoachNote[];
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Two to four sentences on how the game actually went wrong, in plain language.",
    },
    plan: {
      type: "array",
      description: "Two to four concrete things to work on, each one sentence.",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      description: "A coaching note for each mistake supplied, keyed by ply.",
      items: {
        type: "object",
        properties: {
          ply: { type: "integer" },
          note: {
            type: "string",
            description:
              "One or two sentences explaining the idea behind the mistake, not the engine line.",
          },
        },
        required: ["ply", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "plan", "notes"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a chess coach reviewing one of your student's games.

You are given engine analysis that has already found the mistakes and the correct
moves. Do not repeat the engine lines back — the student can already see those.
Your job is the part the engine cannot do: explain the *idea* the student missed,
name the pattern, and connect it to their recurring habits.

Rules:
- Write for a club player. No jargon the student has to look up.
- Be specific to the position. Never write filler like "calculate more carefully".
- One or two sentences per note. Say the useful thing and stop.
- If the supplied history shows a recurring habit, say so explicitly.
- Never invent moves, evaluations, or variations that are not in the data given.`;

export interface CoachRequest {
  game: GameRecord;
  profile: Profile;
  /** Cap on how many mistakes to send, to keep the request small. */
  maxMistakes?: number;
}

export interface CoachClientOptions {
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * Asks Claude for coaching prose over the mistakes in one game.
 * Throws with a readable message on auth failure, refusal, or network error.
 */
export async function requestCoachReport(
  request: CoachRequest,
  options: CoachClientOptions,
): Promise<CoachReport> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Add your Anthropic API key in Settings first.");

  const client = new Anthropic({
    apiKey,
    // Required to talk to the API from page context; see the note above.
    dangerouslyAllowBrowser: true,
  });

  const prompt = buildPrompt(request);
  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    thinking: { type: "adaptive" as const },
    output_config: { format: { type: "json_schema" as const, schema: REPORT_SCHEMA } },
    messages: [{ role: "user" as const, content: prompt }],
  };

  const message = await send(client, params, options.signal);

  if (message.stop_reason === "refusal") {
    throw new Error(
      "Claude declined to answer this request. The offline commentary is still available.",
    );
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  return parseReport(text);
}

/**
 * Sends the request with server-side refusal fallbacks enabled, and retries on
 * the plain endpoint if this SDK build does not accept the beta parameters.
 */
async function send(
  client: Anthropic,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoachMessage> {
  // Streaming keeps a slow, thinking-heavy request from tripping HTTP timeouts.
  try {
    const stream = (
      client as unknown as {
        beta: { messages: { stream: (p: unknown, o?: unknown) => AnthropicStream } };
      }
    ).beta.messages.stream(
      {
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    return await stream.finalMessage();
  } catch (error) {
    if (isAbort(error)) throw error;
    if (!looksLikeBetaRejection(error)) throw friendlyError(error);
    // Fall through to the non-beta path below.
  }

  try {
    const stream = client.messages.stream(
      params as Parameters<typeof client.messages.stream>[0],
      { signal },
    );
    return (await stream.finalMessage()) as CoachMessage;
  } catch (error) {
    throw friendlyError(error);
  }
}

/**
 * The shape we actually read off a response. Declared locally because the beta
 * and non-beta message types differ in ways this code does not care about.
 */
interface CoachMessage {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
}

interface AnthropicStream {
  finalMessage: () => Promise<CoachMessage>;
}

function looksLikeBetaRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /fallback/i.test(message) ||
    /beta/i.test(message) ||
    /unexpected|unknown|not permitted/i.test(message)
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

function friendlyError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error("That API key was rejected. Check it in Settings.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error("Rate limited by the API. Wait a moment and try again.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error("That API key does not have access to this model.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error("Could not reach the API. Check your connection.");
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`API error ${error.status ?? ""}: ${error.message}`.trim());
  }
  return error instanceof Error ? error : new Error(String(error));
}

function parseReport(text: string): CoachReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Claude returned something this app could not read.");
  }
  const report = parsed as Partial<CoachReport>;
  return {
    summary: typeof report.summary === "string" ? report.summary : "",
    plan: Array.isArray(report.plan) ? report.plan.filter((item) => typeof item === "string") : [],
    notes: Array.isArray(report.notes)
      ? report.notes.filter(
          (note): note is CoachNote =>
            typeof note?.ply === "number" && typeof note?.note === "string",
        )
      : [],
  };
}

function buildPrompt(request: CoachRequest): string {
  const { game, profile } = request;
  const analysis = game.analysis;
  if (!analysis) throw new Error("Analyse the game before asking for coaching notes.");

  const maxMistakes = request.maxMistakes ?? 12;
  const mistakes = analysis.moves
    .filter((move) => move.color === analysis.hero)
    .filter((move) => move.quality === "blunder" || move.quality === "mistake")
    .sort((a, b) => b.winProbLost - a.winProbLost)
    .slice(0, maxMistakes)
    .sort((a, b) => a.ply - b.ply);

  const lines = mistakes.map((move) => {
    const bestLine = formatSanLine(move.bestLineSan, move.moveNumber, move.color);
    const punish = formatSanLine(
      move.punishLineSan,
      move.color === "w" ? move.moveNumber : move.moveNumber + 1,
      move.color === "w" ? "b" : "w",
    );
    return [
      `ply ${move.ply} (${move.moveNumber}${move.color === "w" ? "." : "..."}${move.san}) — ${move.quality}`,
      `  position before: ${move.fenBefore}`,
      `  engine prefers: ${bestLine || move.bestSan || "n/a"}`,
      `  what happens instead: ${punish || "n/a"}`,
      `  eval ${formatScore(move.scoreBefore)} -> ${formatScore(move.scoreAfter)}`,
      `  tags: ${move.tags.length > 0 ? move.tags.join(", ") : "none"}`,
    ].join("\n");
  });

  const habits = profile.weaknesses
    .slice(0, 5)
    .map(
      (weakness) =>
        `- ${WEAKNESS_LABELS[weakness.tag as WeaknessTag]}: ${weakness.count} times across ${profile.gamesAnalysed} analysed games`,
    )
    .join("\n");

  return [
    `Game: ${game.white} vs ${game.black} (${game.result}). The student played ${
      analysis.hero === "w" ? "White" : "Black"
    }.`,
    game.opening ? `Opening: ${game.opening}` : null,
    `Accuracy this game: ${analysis.accuracy.toFixed(1)}%. Average centipawn loss: ${analysis.averageCentipawnLoss}.`,
    "",
    "Mistakes to comment on:",
    lines.join("\n\n") || "(none significant)",
    "",
    habits ? `The student's recurring habits so far:\n${habits}` : "",
    "",
    "Return a note for every ply listed above, plus the overall summary and plan.",
  ]
    .filter((part) => part !== null && part !== "")
    .join("\n");
}
