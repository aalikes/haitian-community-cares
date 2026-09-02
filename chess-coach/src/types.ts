import type { Score } from "./chess/evaluation";

export type Color = "w" | "b";

export type MoveQuality =
  | "brilliant"
  | "best"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

export const MOVE_QUALITIES: MoveQuality[] = [
  "brilliant",
  "best",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
];

/**
 * The recurring-problem vocabulary. Every mistake gets zero or more of these,
 * and the Insights tab ranks them so drills can target the worst offenders.
 */
export type WeaknessTag =
  | "hanging-piece"
  | "lost-queen"
  | "lost-material"
  | "missed-mate"
  | "allowed-mate"
  | "missed-tactic"
  | "missed-capture"
  | "allowed-fork"
  | "king-safety"
  | "opening"
  | "endgame"
  | "pawn-structure";

export const WEAKNESS_LABELS: Record<WeaknessTag, string> = {
  "hanging-piece": "Leaving pieces undefended",
  "lost-queen": "Losing the queen",
  "lost-material": "Dropping material",
  "missed-mate": "Missing forced mates",
  "allowed-mate": "Walking into mate",
  "missed-tactic": "Missing tactics",
  "missed-capture": "Missing free captures",
  "allowed-fork": "Allowing forks",
  "king-safety": "King safety",
  opening: "Opening play",
  endgame: "Endgame technique",
  "pawn-structure": "Pawn structure",
};

export const WEAKNESS_ADVICE: Record<WeaknessTag, string> = {
  "hanging-piece":
    "Before every move, name every one of your pieces that is attacked and count the defenders.",
  "lost-queen":
    "Your queen is the easiest piece to trap. Check what attacks her square before and after you move her.",
  "lost-material":
    "Slow down on captures and checks. Count the material on the whole sequence, not just the first move.",
  "missed-mate":
    "When your opponent's king has few escape squares, look at every check before anything else.",
  "allowed-mate":
    "After choosing a move, ask what checks your opponent gets. Any check near your king deserves a hard look.",
  "missed-tactic":
    "Scan for checks, captures and threats in that order — most tactics start with one of the three.",
  "missed-capture":
    "You left free material on the board. A quick sweep of undefended enemy pieces catches these.",
  "allowed-fork":
    "Watch knights especially. Ask which of your pieces sit two squares apart on the same colour.",
  "king-safety":
    "Get castled, keep the pawns in front of your king intact, and count attackers versus defenders.",
  opening:
    "Learn the first eight moves of your main lines properly — develop, castle, and take the centre.",
  endgame:
    "Study king activity, passed pawns and basic rook endings. Most of your endgame losses are technique, not tactics.",
  "pawn-structure":
    "Pawn moves are permanent. Before pushing, ask which squares you are giving up forever.",
};

export interface AnalysedMove {
  /** 0-based index into the move list. */
  ply: number;
  /** 1-based move number as written on a scoresheet. */
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Best available score for the mover, before they moved. Mover's perspective. */
  scoreBefore: Score;
  /** Score for the mover after the move they actually played. Mover's perspective. */
  scoreAfter: Score;
  /** Win probability the mover gave away, 0..1. */
  winProbLost: number;
  /** Centipawns given away, clamped to a sane range for averaging. */
  centipawnLoss: number;
  quality: MoveQuality;
  bestUci: string | null;
  bestSan: string | null;
  /** The engine's recommended line from the position before the move, in SAN. */
  bestLineSan: string[];
  /** How the opponent punishes the move actually played, in SAN. */
  punishLineSan: string[];
  tags: WeaknessTag[];
  /** Seconds spent on this move, where the PGN carried clock data. */
  secondsSpent?: number | null;
  /** Seconds left on the mover's clock after playing it. */
  clockAfter?: number | null;
  /** Filled in by the commentary generator. */
  headline?: string;
  explanation?: string;
  spoken?: string;
  /** Optional richer coaching prose from Claude, when enabled. */
  coachNote?: string;
}

export interface PhaseLoss {
  opening: number;
  middlegame: number;
  endgame: number;
}

/**
 * One slice of moves grouped by how long they took, so "fast moves" and
 * "moves in time trouble" can be compared against everything else on the same
 * terms: how often they went wrong, and how much they cost.
 */
export interface TimingBucket {
  moves: number;
  totalSeconds: number;
  averageSeconds: number;
  /** Mean win probability lost per move in this bucket, 0..1. */
  averageLoss: number;
  /** Inaccuracies, mistakes and blunders. */
  mistakes: number;
}

export type TimingFindingKind =
  | "rushing"
  | "time-trouble"
  | "opening-burn"
  | "long-think-wasted"
  | "healthy";

export interface TimingFinding {
  kind: TimingFindingKind;
  /** Ready to display; already has the numbers in it. */
  text: string;
  /** Strongest first. Roughly "how many times worse than the baseline". */
  severity: number;
}

export interface TimingReport {
  /** Hero moves that carried a usable time. */
  moves: number;
  totalSeconds: number;
  medianSeconds: number;
  /** Seconds of thought spent in each phase, and that as a share of the total. */
  phaseSeconds: PhaseLoss;
  phaseShare: PhaseLoss;
  /** Under a third of your own median for the game. */
  rushed: TimingBucket;
  steady: TimingBucket;
  /** Over twice your own median. */
  deliberate: TimingBucket;
  /** Played with less than a fifth of the starting time left. */
  timeTrouble: TimingBucket;
  comfortable: TimingBucket;
  fastThreshold: number;
  slowThreshold: number;
  troubleThreshold: number;
  findings: TimingFinding[];
}

export interface GameTiming extends TimingReport {
  baseSeconds: number;
  incrementSeconds: number;
  /** True when there was no usable `TimeControl` tag and it had to be guessed. */
  incrementInferred: boolean;
  /** First ply where the hero dropped under the time-trouble threshold. */
  timeTroubleFromPly: number | null;
  /** Seconds left on the hero's clock at the end. */
  finalClock: number | null;
}

export interface GameAnalysis {
  version: number;
  depth: number;
  hero: Color;
  moves: AnalysedMove[];
  /** 0..100, computed from average win-probability loss on the hero's moves. */
  accuracy: number;
  averageCentipawnLoss: number;
  counts: Record<MoveQuality, number>;
  phaseLoss: PhaseLoss;
  tagCounts: Partial<Record<WeaknessTag, number>>;
  /** Absent when the PGN carried no clock data — most pasted games. */
  timing?: GameTiming;
  completedAt: number;
}

export interface GameRecord {
  id: string;
  source: "chess.com" | "lichess" | "pgn";
  url?: string;
  pgn: string;
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  /** PGN result token: "1-0", "0-1", "1/2-1/2" or "*". */
  result: string;
  playedAt: number;
  timeControl?: string;
  opening?: string;
  eco?: string;
  /** Which side is you. */
  hero: Color;
  heroResult: "win" | "loss" | "draw" | "unknown";
  moveCount: number;
  importedAt: number;
  analysis?: GameAnalysis;
  /** Whole-game review written by Claude, when that is enabled. */
  coachSummary?: string;
  coachPlan?: string[];
}

export interface Drill {
  id: string;
  gameId: string;
  ply: number;
  /** Position to solve, i.e. the position before the mistake. */
  fen: string;
  sideToMove: Color;
  bestUci: string;
  bestSan: string;
  playedSan: string;
  quality: MoveQuality;
  tags: WeaknessTag[];
  prompt: string;
  attempts: number;
  solved: number;
  lastSeenAt: number | null;
  /** Simple spaced repetition: only show a drill once it is due. */
  dueAt: number;
}

export interface Settings {
  chessComUser: string;
  lichessUser: string;
  /** Search depth per position. 12 is quick, 18 is thorough and slow on a phone. */
  depth: number;
  multiPv: number;
  voiceEnabled: boolean;
  voiceUri: string | null;
  voiceRate: number;
  autoSpeak: boolean;
  claudeEnabled: boolean;
  /** Stored only in this browser's IndexedDB, never sent anywhere but api.anthropic.com. */
  anthropicApiKey: string;
  boardFlipped: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  chessComUser: "",
  lichessUser: "",
  depth: 14,
  multiPv: 3,
  voiceEnabled: true,
  voiceUri: null,
  voiceRate: 1,
  autoSpeak: false,
  claudeEnabled: false,
  anthropicApiKey: "",
  boardFlipped: false,
};
