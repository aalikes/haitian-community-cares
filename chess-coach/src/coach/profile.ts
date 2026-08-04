import { accuracyFromLosses } from "../chess/classify";
import type {
  GameRecord,
  MoveQuality,
  PhaseLoss,
  WeaknessTag,
} from "../types";
import { MOVE_QUALITIES, WEAKNESS_ADVICE, WEAKNESS_LABELS } from "../types";

export interface WeaknessStat {
  tag: WeaknessTag;
  label: string;
  advice: string;
  count: number;
  /** Mistakes carrying this tag per analysed game. */
  perGame: number;
}

export interface TrendPoint {
  playedAt: number;
  accuracy: number;
  gameId: string;
}

export interface OpeningStat {
  name: string;
  games: number;
  accuracy: number;
  wins: number;
}

export interface Profile {
  gamesAnalysed: number;
  movesAnalysed: number;
  accuracy: number;
  averageCentipawnLoss: number;
  counts: Record<MoveQuality, number>;
  phaseLoss: PhaseLoss;
  weaknesses: WeaknessStat[];
  trend: TrendPoint[];
  openings: OpeningStat[];
  /** Accuracy over the most recent five games minus the five before that. */
  recentDelta: number | null;
}

/**
 * Aggregates every analysed game into one picture of what keeps going wrong.
 * This is what the drill generator prioritises against.
 */
export function buildProfile(games: GameRecord[]): Profile {
  const analysed = games
    .filter((game) => game.analysis)
    .sort((a, b) => a.playedAt - b.playedAt);

  const counts = {} as Record<MoveQuality, number>;
  for (const quality of MOVE_QUALITIES) counts[quality] = 0;

  const tagCounts = new Map<WeaknessTag, number>();
  const phaseTotals: PhaseLoss = { opening: 0, middlegame: 0, endgame: 0 };
  const phaseGames: PhaseLoss = { opening: 0, middlegame: 0, endgame: 0 };
  const trend: TrendPoint[] = [];
  const openings = new Map<string, { games: number; losses: number[]; wins: number }>();

  let movesAnalysed = 0;
  let cpLossTotal = 0;
  const heroLosses: number[] = [];

  for (const game of analysed) {
    const analysis = game.analysis!;
    trend.push({ playedAt: game.playedAt, accuracy: analysis.accuracy, gameId: game.id });

    for (const quality of MOVE_QUALITIES) {
      counts[quality] += analysis.counts[quality] ?? 0;
    }
    for (const [tag, count] of Object.entries(analysis.tagCounts)) {
      const key = tag as WeaknessTag;
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + (count ?? 0));
    }

    for (const phase of ["opening", "middlegame", "endgame"] as const) {
      if (analysis.phaseLoss[phase] > 0) {
        phaseTotals[phase] += analysis.phaseLoss[phase];
        phaseGames[phase] += 1;
      }
    }

    const heroMoves = analysis.moves.filter((move) => move.color === analysis.hero);
    movesAnalysed += heroMoves.length;
    cpLossTotal += analysis.averageCentipawnLoss * heroMoves.length;
    for (const move of heroMoves) heroLosses.push(move.winProbLost);

    const openingName = normaliseOpening(game);
    const bucket = openings.get(openingName) ?? { games: 0, losses: [], wins: 0 };
    bucket.games += 1;
    bucket.losses.push(...heroMoves.map((move) => move.winProbLost));
    if (game.heroResult === "win") bucket.wins += 1;
    openings.set(openingName, bucket);
  }

  const weaknesses: WeaknessStat[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({
      tag,
      label: WEAKNESS_LABELS[tag],
      advice: WEAKNESS_ADVICE[tag],
      count,
      perGame: analysed.length > 0 ? count / analysed.length : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    gamesAnalysed: analysed.length,
    movesAnalysed,
    accuracy: accuracyFromLosses(heroLosses),
    averageCentipawnLoss: movesAnalysed > 0 ? Math.round(cpLossTotal / movesAnalysed) : 0,
    counts,
    phaseLoss: {
      opening: divide(phaseTotals.opening, phaseGames.opening),
      middlegame: divide(phaseTotals.middlegame, phaseGames.middlegame),
      endgame: divide(phaseTotals.endgame, phaseGames.endgame),
    },
    weaknesses,
    trend,
    openings: [...openings.entries()]
      .map(([name, bucket]) => ({
        name,
        games: bucket.games,
        wins: bucket.wins,
        accuracy: accuracyFromLosses(bucket.losses),
      }))
      .sort((a, b) => b.games - a.games),
    recentDelta: computeRecentDelta(trend),
  };
}

function divide(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

function normaliseOpening(game: GameRecord): string {
  const name = game.opening?.trim();
  if (name) {
    // Chess.com writes openings as a URL slug in some exports.
    const slug = /openings\/([^/]+)$/.exec(name);
    if (slug) return slug[1]!.replace(/-/g, " ");
    return name.split(":")[0]!.trim();
  }
  return game.eco ? `ECO ${game.eco}` : "Unclassified";
}

function computeRecentDelta(trend: TrendPoint[]): number | null {
  if (trend.length < 6) return null;
  const recent = trend.slice(-5);
  const previous = trend.slice(-10, -5);
  if (previous.length === 0) return null;
  const mean = (points: TrendPoint[]) =>
    points.reduce((sum, point) => sum + point.accuracy, 0) / points.length;
  return Math.round((mean(recent) - mean(previous)) * 10) / 10;
}

/** Longest-standing problems first, capped so the UI stays readable. */
export function topWeaknesses(profile: Profile, limit = 4): WeaknessStat[] {
  return profile.weaknesses.slice(0, limit);
}
