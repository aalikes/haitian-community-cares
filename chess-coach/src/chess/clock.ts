import type { Color } from "../types";

/**
 * Clock data lives in PGN comments that both Chess.com and Lichess emit by
 * default and that this app previously threw away. Every online game you import
 * already carries a full record of how long you thought about each move.
 */

export interface TimeControl {
  kind: "real" | "correspondence" | "unlimited" | "unknown";
  /** Starting time in seconds. 0 when unknown. */
  baseSeconds: number;
  /** Increment added after each move, in seconds. */
  incrementSeconds: number;
}

const UNKNOWN_TC: TimeControl = {
  kind: "unknown",
  baseSeconds: 0,
  incrementSeconds: 0,
};

/**
 * Reads a PGN `TimeControl` tag.
 *
 * Handles the forms that actually turn up: "300", "180+2", "1/259200"
 * (correspondence, seconds per move), "-" (unlimited) and multi-period
 * controls like "40/7200:1800+30", where only the first period is used
 * because that is where club games are decided.
 */
export function parseTimeControl(raw: string | undefined | null): TimeControl {
  const text = raw?.trim();
  if (!text || text === "?") return UNKNOWN_TC;
  if (text === "-") return { kind: "unlimited", baseSeconds: 0, incrementSeconds: 0 };

  const firstPeriod = text.split(":")[0]!;

  // "40/7200" is a moves-in-time period; "1/259200" is how Chess.com writes a
  // daily game. Both are `moves/seconds`, and only the move count tells them
  // apart — one move per period means correspondence.
  const period = /^(\d+)\/(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?$/.exec(firstPeriod);
  if (period) {
    const movesPerPeriod = Number(period[1]);
    return {
      kind: movesPerPeriod === 1 ? "correspondence" : "real",
      baseSeconds: Number(period[2]),
      incrementSeconds: period[3] ? Number(period[3]) : 0,
    };
  }

  const real = /^(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?$/.exec(firstPeriod);
  if (real) {
    return {
      kind: "real",
      baseSeconds: Number(real[1]),
      incrementSeconds: real[2] ? Number(real[2]) : 0,
    };
  }

  return UNKNOWN_TC;
}

/**
 * Pulls the clock reading out of a PGN move comment.
 *
 * `[%clk 0:02:30.5]` is the time *remaining* after the move was played, with
 * any increment already added. `[%emt 12.4]` is the time the move itself took
 * and is returned separately because it needs no differencing.
 */
export function parseClockComment(comment: string): {
  remaining: number | null;
  elapsed: number | null;
} {
  return {
    remaining: matchRemaining(comment),
    elapsed: matchElapsed(comment),
  };
}

function matchRemaining(comment: string): number | null {
  const clk = /\[%clk\s+(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\]/.exec(comment);
  if (!clk) return null;
  // Two-component readings are M:SS; three are H:MM:SS.
  if (clk[3] === undefined) {
    return Number(clk[1]) * 60 + Number(clk[2]);
  }
  return Number(clk[1]) * 3600 + Number(clk[2]) * 60 + Number(clk[3]);
}

function matchElapsed(comment: string): number | null {
  const emt = /\[%emt\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]/.exec(comment);
  if (emt) {
    const hours = emt[1] ? Number(emt[1]) : 0;
    return hours * 3600 + Number(emt[2]) * 60 + Number(emt[3]);
  }
  const plain = /\[%emt\s+(\d+(?:\.\d+)?)\]/.exec(comment);
  return plain ? Number(plain[1]) : null;
}

export interface MoveTimes {
  /** Seconds spent on each ply, or null where the PGN said nothing. */
  spent: (number | null)[];
  /** Seconds left on the mover's clock after each ply. */
  remaining: (number | null)[];
  /** True when no `TimeControl` tag was usable and the increment was guessed. */
  incrementInferred: boolean;
  incrementSeconds: number;
  baseSeconds: number;
}

/** Standard online increments, used when one has to be guessed from the clocks. */
const COMMON_INCREMENTS = [0, 1, 2, 3, 5, 10, 15, 20, 30, 60];

/**
 * Turns a series of clock readings into time spent per move.
 *
 * The arithmetic is `spent = previous + increment − current`, because the
 * reading is taken after the increment has been credited. A player who moves
 * instantly on a 2-second increment therefore *gains* time, which is why the
 * increment has to be known rather than assumed to be zero.
 */
export function moveTimes(
  clocks: (number | null)[],
  elapsed: (number | null)[],
  colors: Color[],
  control: TimeControl,
): MoveTimes {
  let increment = control.incrementSeconds;
  let inferred = false;
  if (control.kind !== "real") {
    increment = inferIncrement(clocks, colors);
    inferred = true;
  }

  const base = control.kind === "real" ? control.baseSeconds : (firstReading(clocks) ?? 0);
  const spent: (number | null)[] = new Array(clocks.length).fill(null);
  const previous: Record<Color, number | null> = {
    w: base > 0 ? base : null,
    b: base > 0 ? base : null,
  };

  for (let ply = 0; ply < clocks.length; ply += 1) {
    const color = colors[ply];
    if (!color) continue;

    // An explicit elapsed-time tag needs no differencing and is always exact.
    const direct = elapsed[ply];
    if (direct !== null && direct !== undefined) {
      spent[ply] = Math.max(0, direct);
      const reading = clocks[ply];
      if (reading !== null && reading !== undefined) previous[color] = reading;
      continue;
    }

    const reading = clocks[ply];
    if (reading === null || reading === undefined) continue;

    const before = previous[color];
    previous[color] = reading;
    if (before === null) continue; // first reading for this side sets the baseline

    // Clamp: a negative result means the increment is wrong or the server
    // rounded, and no move can take more time than the player had.
    spent[ply] = clamp(before + increment - reading, 0, before + increment);
  }

  return {
    spent,
    remaining: clocks,
    incrementInferred: inferred,
    incrementSeconds: increment,
    baseSeconds: base,
  };
}

/**
 * Guesses the increment from the clocks themselves.
 *
 * If a player's clock ever goes *up* between their own moves, the increment
 * must be at least that rise, so the largest rise seen is a lower bound.
 * Rounding up to the nearest control people actually play turns that bound
 * into a usable number.
 *
 * It only works when somebody moved faster than the increment at least once.
 * A game where every move took longer than the increment looks exactly like a
 * game with no increment, and this will return 0 — which is why callers get
 * `incrementInferred` to pass on to the reader. All times are then short by
 * the true increment, uniformly, so comparisons between moves still hold even
 * where the absolute seconds do not.
 */
function inferIncrement(clocks: (number | null)[], colors: Color[]): number {
  const previous: Record<Color, number | null> = { w: null, b: null };
  let largestRise = 0;

  for (let ply = 0; ply < clocks.length; ply += 1) {
    const color = colors[ply];
    const reading = clocks[ply];
    if (!color || reading === null || reading === undefined) continue;
    const before = previous[color];
    previous[color] = reading;
    if (before === null) continue;
    largestRise = Math.max(largestRise, reading - before);
  }

  if (largestRise <= 0) return 0;
  return COMMON_INCREMENTS.find((value) => value >= largestRise) ?? Math.ceil(largestRise);
}

function firstReading(clocks: (number | null)[]): number | null {
  for (const clock of clocks) {
    if (clock !== null && clock !== undefined) return clock;
  }
  return null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** "4:07", "58s", "1:02:30" — short enough to sit in a table cell. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
