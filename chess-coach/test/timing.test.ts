import {
  formatDuration,
  moveTimes,
  parseClockComment,
  parseTimeControl,
} from "../src/chess/clock";
import { parsePgn } from "../src/chess/util";
import { buildGameTiming, aggregateTiming } from "../src/coach/timing";
import type { AnalysedMove, Color, GameTiming } from "../src/types";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
function near(name: string, actual: number, expected: number, tol = 0.01) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${actual}, want ${expected}`}`);
}

// ---- time control parsing -------------------------------------------------
check("TC 180+2", parseTimeControl("180+2"), { kind: "real", baseSeconds: 180, incrementSeconds: 2 });
check("TC 600", parseTimeControl("600"), { kind: "real", baseSeconds: 600, incrementSeconds: 0 });
check("TC daily", parseTimeControl("1/259200"), { kind: "correspondence", baseSeconds: 259200, incrementSeconds: 0 });
check("TC unlimited", parseTimeControl("-"), { kind: "unlimited", baseSeconds: 0, incrementSeconds: 0 });
check("TC missing", parseTimeControl(undefined), { kind: "unknown", baseSeconds: 0, incrementSeconds: 0 });
check("TC multiperiod", parseTimeControl("40/7200:1800+30"), { kind: "real", baseSeconds: 7200, incrementSeconds: 0 });
check("TC 40 moves in 2h is real, not daily", parseTimeControl("40/7200").kind, "real");
check("TC 1/N is daily", parseTimeControl("1/86400").kind, "correspondence");

// ---- clock comments -------------------------------------------------------
check("clk H:MM:SS.s", parseClockComment("[%clk 0:02:30.5]").remaining, 150.5);
check("clk M:SS", parseClockComment("[%clk 2:30]").remaining, 150);
check("clk 1:00:00", parseClockComment("[%clk 1:00:00]").remaining, 3600);
check("emt plain", parseClockComment("[%emt 12.4]").elapsed, 12.4);
check("no clock", parseClockComment("good move!").remaining, null);

// ---- move times from a real PGN -------------------------------------------
const pgn = `[Event "Live Chess"]
[White "alice"]
[Black "bob"]
[Result "0-1"]
[TimeControl "180+2"]

1. e4 {[%clk 0:03:00.1]} 1... e5 {[%clk 0:02:59.8]} 2. Nf3 {[%clk 0:02:58.4]} 2... Nc6 {[%clk 0:02:55.2]} 3. Bc4 {[%clk 0:02:57.9]} 3... Nf6 {[%clk 0:02:40.0]} 0-1`;

const parsed = parsePgn(pgn);
const control = parseTimeControl(parsed.headers.TimeControl);
const times = moveTimes(parsed.clocks, parsed.elapsed, parsed.moves.map((m) => m.color as Color), control);

// White: 180 + 2 - 180.1 = 1.9 ; Black: 180 + 2 - 179.8 = 2.2
near("white move 1 time", times.spent[0] as number, 1.9);
near("black move 1 time", times.spent[1] as number, 2.2);
// White move 2: 180.1 + 2 - 178.4 = 3.7
near("white move 2 time", times.spent[2] as number, 3.7);
// Black move 2: 179.8 + 2 - 175.2 = 6.6
near("black move 2 time", times.spent[3] as number, 6.6);
// White move 3: clock ROSE (178.4 -> 177.9 is a fall of 0.5) => 178.4 + 2 - 177.9 = 2.5
near("white move 3 time (increment gain)", times.spent[4] as number, 2.5);
check("increment not inferred when TC present", times.incrementInferred, false);

// Increment inference when the TimeControl tag is missing entirely. In this
// game nobody ever moved faster than the increment, so the clock never rises
// and there is nothing to infer from — the honest answer is 0.
const noTc = moveTimes(parsed.clocks, parsed.elapsed, parsed.moves.map((m) => m.color as Color), parseTimeControl(undefined));
check("increment flagged as inferred", noTc.incrementInferred, true);
check("no rise in the clocks -> no increment detected", noTc.incrementSeconds, 0);

// A game where someone *does* move faster than the increment: white's clock
// climbs 179 -> 180.5, a rise of 1.5, which rounds up to a real 2s increment.
const risingClocks = [179, 179, 180.5, 175, 179.2, 170];
const risingColors: Color[] = ["w", "b", "w", "b", "w", "b"];
const rising = moveTimes(risingClocks, [null, null, null, null, null, null], risingColors, parseTimeControl(undefined));
check("increment inferred from a clock rise", rising.incrementSeconds, 2);

// ---- bucketing ------------------------------------------------------------
function move(ply: number, color: Color, seconds: number, clock: number, loss: number): AnalysedMove {
  return {
    ply, moveNumber: Math.floor(ply / 2) + 1, color, san: "Nf3", uci: "g1f3",
    fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    fenAfter: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1",
    scoreBefore: { cp: 20, mate: null }, scoreAfter: { cp: 20, mate: null },
    winProbLost: loss, centipawnLoss: Math.round(loss * 300),
    quality: loss >= 0.3 ? "blunder" : loss >= 0.1 ? "inaccuracy" : "good",
    bestUci: null, bestSan: null, bestLineSan: [], punishLineSan: [], tags: [],
    secondsSpent: seconds, clockAfter: clock,
  };
}

// Ten hero moves: five at 10s (clean), five at 1s (each a blunder), clock high.
const moves: AnalysedMove[] = [];
for (let i = 0; i < 5; i += 1) moves.push(move(i * 2, "w", 10, 150, 0.02));
for (let i = 5; i < 10; i += 1) moves.push(move(i * 2, "w", 1, 140, 0.4));

const timing = buildGameTiming({ moves, hero: "w", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false })!;
check("timing built", Boolean(timing), true);
check("hero moves counted", timing.moves, 10);
near("median of 10x10s/1s", timing.medianSeconds, 5.5);
// median 5.5 -> fast threshold 1.833, slow threshold 11 -> 1s moves rushed, 10s steady
check("rushed bucket size", timing.rushed.moves, 5);
check("steady bucket size", timing.steady.moves, 5);
check("deliberate bucket empty", timing.deliberate.moves, 0);
near("rushed average loss", timing.rushed.averageLoss, 0.4);
near("steady average loss", timing.steady.averageLoss, 0.02);
check("rushing finding surfaced", timing.findings[0]?.kind, "rushing");
console.log("      -> " + timing.findings[0]?.text);

// Time trouble: threshold is 20% of 180 = 36s. Nothing under it here.
check("no time trouble", timing.timeTrouble.moves, 0);

const pressured = moves.map((m, i) => (i >= 5 ? { ...m, clockAfter: 20 } : m));
const timing2 = buildGameTiming({ moves: pressured, hero: "w", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false })!;
check("time trouble bucket", timing2.timeTrouble.moves, 5);
check("time trouble ply", timing2.timeTroubleFromPly, 10);
const troubleFinding = timing2.findings.find((f) => f.kind === "time-trouble");
check("time trouble finding", Boolean(troubleFinding), true);
console.log("      -> " + troubleFinding?.text);

// ---- healthy game produces no false alarm ---------------------------------
// 30 hero moves at an even pace, so only the first 10 fall in the opening and
// the phase split looks like a real game rather than an opening marathon.
const even: AnalysedMove[] = [];
for (let i = 0; i < 30; i += 1) even.push(move(i * 2, "w", 8 + (i % 3), 150, 0.03));
const healthy = buildGameTiming({ moves: even, hero: "w", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false })!;
check("healthy verdict", healthy.findings[0]?.kind, "healthy");
check("healthy game raises exactly one finding", healthy.findings.length, 1);

// ...and an opening marathon still gets called out.
const frontloaded: AnalysedMove[] = [];
for (let i = 0; i < 30; i += 1) frontloaded.push(move(i * 2, "w", i < 10 ? 30 : 4, 150, 0.03));
const burn = buildGameTiming({ moves: frontloaded, hero: "w", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false })!;
check("opening burn flagged", burn.findings.some((f) => f.kind === "opening-burn"), true);
console.log("      -> " + burn.findings.find((f) => f.kind === "opening-burn")?.text);

// ---- too little data returns null -----------------------------------------
check("under 5 timed moves -> null", buildGameTiming({ moves: moves.slice(0, 3), hero: "w", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false }), null);
check("wrong hero -> null", buildGameTiming({ moves, hero: "b", baseSeconds: 180, incrementSeconds: 2, incrementInferred: false }), null);

// ---- cross-game aggregation preserves the weighted averages ---------------
const pooled = aggregateTiming([timing, timing2] as GameTiming[])!;
check("pooled moves", pooled.moves, 20);
near("pooled rushed loss stays 0.4", pooled.rushed.averageLoss, 0.4);
near("pooled steady loss stays 0.02", pooled.steady.averageLoss, 0.02);
check("pooled rushed count", pooled.rushed.moves, 10);
check("pooled finding", pooled.findings[0]?.kind, "rushing");

// ---- formatting -----------------------------------------------------------
check("format 5.5s", formatDuration(5.5), "5.5s");
check("format 45s", formatDuration(45), "45s");
check("format 150s", formatDuration(150), "2:30");
check("format 3661s", formatDuration(3661), "1:01:01");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
