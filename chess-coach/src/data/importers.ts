import type { Color, GameRecord } from "../types";
import { parsePgn, splitPgnGames } from "../chess/util";

export interface ImportResult {
  games: GameRecord[];
  /** Games we could not parse, with the reason, so nothing fails silently. */
  skipped: { reason: string }[];
}

/**
 * Builds a GameRecord from raw PGN.
 *
 * `username` decides which side is "you". When it matches neither player we
 * fall back to White, and the review screen lets you flip it.
 */
export function recordFromPgn(
  pgn: string,
  options: {
    source: GameRecord["source"];
    username?: string;
    id?: string;
    url?: string;
  },
): GameRecord {
  const { headers, moves } = parsePgn(pgn);
  const white = headers.White ?? "White";
  const black = headers.Black ?? "Black";
  const result = headers.Result ?? "*";

  const hero = resolveHero(options.username, white, black);
  const id = options.id ?? `${options.source}:${hashString(pgn)}`;

  return {
    id,
    source: options.source,
    url: options.url ?? headers.Site,
    pgn,
    white,
    black,
    whiteElo: toNumber(headers.WhiteElo),
    blackElo: toNumber(headers.BlackElo),
    result,
    playedAt: parseDate(headers),
    timeControl: headers.TimeControl,
    opening: headers.Opening,
    eco: headers.ECO,
    hero,
    heroResult: heroResultFrom(result, hero),
    moveCount: moves.length,
    importedAt: Date.now(),
  };
}

function resolveHero(username: string | undefined, white: string, black: string): Color {
  if (!username) return "w";
  const target = username.trim().toLowerCase();
  if (white.toLowerCase() === target) return "w";
  if (black.toLowerCase() === target) return "b";
  return "w";
}

export function heroResultFrom(result: string, hero: Color): GameRecord["heroResult"] {
  if (result === "1/2-1/2") return "draw";
  if (result === "1-0") return hero === "w" ? "win" : "loss";
  if (result === "0-1") return hero === "b" ? "win" : "loss";
  return "unknown";
}

function parseDate(headers: Record<string, string>): number {
  const date = headers.UTCDate ?? headers.Date ?? "";
  const time = headers.UTCTime ?? "00:00:00";
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(date);
  if (!match) return Date.now();
  const stamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${time}Z`);
  return Number.isNaN(stamp) ? Date.now() : stamp;
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** FNV-1a — just needs to be stable and collision-free enough to dedupe games. */
export function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Parses a pasted or uploaded PGN file, which may hold many games. */
export function importPgnText(text: string, username?: string): ImportResult {
  const games: GameRecord[] = [];
  const skipped: { reason: string }[] = [];
  for (const chunk of splitPgnGames(text)) {
    try {
      games.push(recordFromPgn(chunk, { source: "pgn", username }));
    } catch (error) {
      skipped.push({ reason: describeError(error) });
    }
  }
  if (games.length === 0 && skipped.length === 0) {
    skipped.push({ reason: "No games found in that PGN." });
  }
  return { games, skipped };
}

interface ChessComGame {
  url?: string;
  pgn?: string;
  end_time?: number;
  rules?: string;
}

/**
 * Pulls recent games from Chess.com's public API. No key or login needed —
 * these endpoints are open and CORS-enabled.
 */
export async function importFromChessCom(
  username: string,
  maxGames = 20,
): Promise<ImportResult> {
  const user = username.trim().toLowerCase();
  if (!user) throw new Error("Enter your Chess.com username first.");

  const archivesResponse = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`,
  );
  if (archivesResponse.status === 404) {
    throw new Error(`Chess.com has no player called "${username}".`);
  }
  if (!archivesResponse.ok) {
    throw new Error(`Chess.com returned ${archivesResponse.status}. Try again shortly.`);
  }
  const { archives } = (await archivesResponse.json()) as { archives?: string[] };
  if (!archives || archives.length === 0) {
    return { games: [], skipped: [{ reason: "That account has no archived games." }] };
  }

  const games: GameRecord[] = [];
  const skipped: { reason: string }[] = [];

  // Archives are ordered oldest first, so walk backwards from the newest month.
  for (let index = archives.length - 1; index >= 0 && games.length < maxGames; index -= 1) {
    const monthResponse = await fetch(archives[index]!);
    if (!monthResponse.ok) continue;
    const { games: monthGames } = (await monthResponse.json()) as { games?: ChessComGame[] };
    if (!monthGames) continue;

    for (const game of [...monthGames].reverse()) {
      if (games.length >= maxGames) break;
      if (!game.pgn) continue;
      if (game.rules && game.rules !== "chess") continue; // skip variants
      try {
        games.push(
          recordFromPgn(game.pgn, {
            source: "chess.com",
            username: user,
            id: game.url ? `chess.com:${game.url}` : undefined,
            url: game.url,
          }),
        );
      } catch (error) {
        skipped.push({ reason: describeError(error) });
      }
    }
  }

  return { games, skipped };
}

/**
 * Pulls recent games from Lichess. The export endpoint streams PGN and is
 * open for public games.
 */
export async function importFromLichess(
  username: string,
  maxGames = 20,
): Promise<ImportResult> {
  const user = username.trim();
  if (!user) throw new Error("Enter your Lichess username first.");

  const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(user)}`);
  url.searchParams.set("max", String(maxGames));
  url.searchParams.set("opening", "true");
  url.searchParams.set("clocks", "false");
  url.searchParams.set("evals", "false");

  const response = await fetch(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (response.status === 404) {
    throw new Error(`Lichess has no player called "${username}".`);
  }
  if (!response.ok) {
    throw new Error(`Lichess returned ${response.status}. Try again shortly.`);
  }

  const text = await response.text();
  const games: GameRecord[] = [];
  const skipped: { reason: string }[] = [];
  for (const chunk of splitPgnGames(text)) {
    try {
      games.push(recordFromPgn(chunk, { source: "lichess", username: user }));
    } catch (error) {
      skipped.push({ reason: describeError(error) });
    }
  }
  if (games.length === 0 && skipped.length === 0) {
    skipped.push({ reason: "No public games found for that account." });
  }
  return { games, skipped };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
