import { useCallback, useEffect, useState } from "react";
import { QUALITY_COLORS, QUALITY_LABELS, isMistake } from "../chess/classify";
import { formatDuration } from "../chess/clock";
import { formatScore } from "../chess/evaluation";
import { formatSanLine, parseUci } from "../chess/util";
import { ANALYSIS_VERSION } from "../engine/analysis";
import { summariseGame } from "../coach/commentary";
import { speak, speechSupported, stopSpeaking } from "../coach/voice";
import { describeError } from "../data/importers";
import type { AnalysedMove, Color, GameAnalysis, GameRecord } from "../types";
import { WEAKNESS_LABELS } from "../types";
import { Board } from "./Board";
import { ClockGraph } from "./ClockGraph";
import { EvalGraph } from "./EvalGraph";
import { ExplainClip } from "./ExplainClip";
import { TimingPanel } from "./TimingPanel";
import { useAppState } from "./state";

export function ReviewScreen({ gameId, onBack }: { gameId: string; onBack: () => void }) {
  const {
    games,
    settings,
    job,
    runAnalysis,
    cancelAnalysis,
    updateGame,
    setHero,
    setError,
    profile,
  } = useAppState();
  const game = games.find((entry) => entry.id === gameId);

  const [ply, setPly] = useState(0);
  const [showClip, setShowClip] = useState(false);
  const [coaching, setCoaching] = useState(false);

  useEffect(() => {
    setPly(0);
    setShowClip(false);
  }, [gameId]);

  useEffect(() => () => stopSpeaking(), []);

  if (!game) {
    return (
      <div className="screen">
        <button type="button" className="button ghost" onClick={onBack}>
          ← Back
        </button>
        <p className="muted">That game is no longer stored on this device.</p>
      </div>
    );
  }

  const analysis = game.analysis;
  const analysing = job?.gameId === game.id;

  if (!analysis) {
    return (
      <div className="screen">
        <ReviewHeader game={game} onBack={onBack} onSetHero={setHero} />
        <section className="card">
          <h2>Not analysed yet</h2>
          <p className="muted">
            Analysis runs Stockfish in this browser at depth {settings.depth}. Expect roughly a
            second per move on a phone, and keep the screen awake while it works.
          </p>
          {analysing ? (
            <>
              <Progress done={job.done} total={job.total} />
              <button type="button" className="button ghost" onClick={cancelAnalysis}>
                Stop
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => void runAnalysis(game.id)}>
              Analyse this game
            </button>
          )}
        </section>
      </div>
    );
  }

  const moves = analysis.moves;
  const current = moves[Math.min(ply, moves.length - 1)];
  const heroIsMover = current?.color === analysis.hero;
  const mistakePlies = moves
    .filter((move) => move.color === analysis.hero && isMistake(move.quality))
    .map((move) => move.ply);

  const jumpToNextMistake = () => {
    const next = mistakePlies.find((candidate) => candidate > ply);
    setPly(next ?? mistakePlies[0] ?? ply);
  };

  const requestCoaching = async () => {
    setCoaching(true);
    setError(null);
    try {
      // Loaded on demand so the Anthropic SDK stays out of the initial bundle.
      const { requestCoachReport } = await import("../coach/claude");
      const report = await requestCoachReport(
        { game, profile },
        { apiKey: settings.anthropicApiKey },
      );
      const noteByPly = new Map(report.notes.map((note) => [note.ply, note.note]));
      const updated: GameRecord = {
        ...game,
        analysis: {
          ...analysis,
          moves: analysis.moves.map((move) =>
            noteByPly.has(move.ply) ? { ...move, coachNote: noteByPly.get(move.ply) } : move,
          ),
        },
        coachSummary: report.summary,
        coachPlan: report.plan,
      };
      await updateGame(updated);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setCoaching(false);
    }
  };

  const coachSummary = game.coachSummary;
  const coachPlan = game.coachPlan ?? [];

  return (
    <div className="screen">
      <ReviewHeader game={game} onBack={onBack} onSetHero={setHero} />

      <section className="card tight">
        <p className="summary">{summariseGame(analysis.accuracy, analysis.counts, game.heroResult)}</p>
        {analysis.version < ANALYSIS_VERSION && (
          <p className="muted small">
            Scored with an older formula. Re-analyse to bring the numbers in line with the
            current scoring.
          </p>
        )}
        <div className="stat-row">
          <Stat label="Accuracy" value={`${analysis.accuracy.toFixed(1)}%`} />
          <Stat label="Avg loss" value={`${analysis.averageCentipawnLoss}cp`} />
          <Stat label="Blunders" value={String(analysis.counts.blunder)} />
          <Stat label="Depth" value={String(analysis.depth)} />
        </div>
        <EvalGraph moves={moves} hero={analysis.hero} currentPly={ply} onSelect={setPly} />
      </section>

      <BoardPanel
        move={current}
        flipped={settings.boardFlipped ? analysis.hero === "w" : analysis.hero === "b"}
      />

      <MoveBar moves={moves} hero={analysis.hero} currentPly={ply} onSelect={setPly} />

      <div className="nav-row">
        <button type="button" className="button ghost" onClick={() => setPly(0)} aria-label="Start">
          ⏮
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={() => setPly((value) => Math.max(0, value - 1))}
          aria-label="Previous move"
        >
          ◀
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={() => setPly((value) => Math.min(moves.length - 1, value + 1))}
          aria-label="Next move"
        >
          ▶
        </button>
        <button
          type="button"
          className="button"
          disabled={mistakePlies.length === 0}
          onClick={jumpToNextMistake}
        >
          Next mistake ({mistakePlies.length})
        </button>
      </div>

      {current && (
        <CommentaryCard
          move={current}
          heroIsMover={Boolean(heroIsMover)}
          voiceEnabled={settings.voiceEnabled}
          onSpeak={() =>
            speak(current.spoken ?? current.explanation ?? current.san, {
              voiceUri: settings.voiceUri,
              rate: settings.voiceRate,
            })
          }
        />
      )}

      <ClockCard analysis={analysis} currentPly={ply} onSelect={setPly} />

      {current && isMistake(current.quality) && (
        <section className="card">
          <div className="card-head">
            <h2>Watch it happen</h2>
            {!showClip && (
              <button type="button" className="button small" onClick={() => setShowClip(true)}>
                Build clip
              </button>
            )}
          </div>
          {showClip ? (
            <ExplainClip
              move={current}
              hero={analysis.hero}
              title={`${game.white} vs ${game.black}`}
              settings={settings}
              onError={setError}
            />
          ) : (
            <p className="muted">
              An animated replay of the mistake, how it gets punished, and the move you should have
              played — narrated out loud.
            </p>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Coach's notes</h2>
          {settings.claudeEnabled && settings.anthropicApiKey.trim() && (
            <button
              type="button"
              className="button small"
              disabled={coaching}
              onClick={() => void requestCoaching()}
            >
              {coaching ? "Thinking…" : coachSummary ? "Refresh" : "Ask Claude"}
            </button>
          )}
        </div>
        {!settings.claudeEnabled || !settings.anthropicApiKey.trim() ? (
          <p className="muted">
            Turn on Claude coaching in Settings to get a written review of the whole game on top of
            the engine analysis. Everything else works without it.
          </p>
        ) : coachSummary ? (
          <>
            <p>{coachSummary}</p>
            {coachPlan.length > 0 && (
              <ul className="plan-list">
                {coachPlan.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">
            Ask for a review and Claude will explain the ideas behind this game's mistakes and how
            they fit your recurring habits.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The clock half of the review. Absent for games whose PGN carried no times —
 * most pasted games — in which case nothing is shown rather than an empty card.
 */
function ClockCard({
  analysis,
  currentPly,
  onSelect,
}: {
  analysis: GameAnalysis;
  currentPly: number;
  onSelect: (ply: number) => void;
}) {
  const timing = analysis.timing;
  if (!timing) return null;

  return (
    <section className="card">
      <h2>The clock</h2>
      <div className="stat-row">
        <Stat label="Time used" value={formatDuration(timing.totalSeconds)} />
        <Stat label="Median move" value={formatDuration(timing.medianSeconds)} />
        <Stat
          label="Left at end"
          value={timing.finalClock === null ? "—" : formatDuration(timing.finalClock)}
        />
      </div>
      <ClockGraph
        moves={analysis.moves}
        hero={analysis.hero}
        troubleThreshold={timing.troubleThreshold}
        currentPly={currentPly}
        onSelect={onSelect}
      />
      <p className="muted small">
        Your clock in gold, your opponent&apos;s faded. Dots mark your mistakes.
        {timing.incrementInferred
          ? " The game carried no usable time control, so the increment was worked out from the clocks themselves and the times may be slightly off."
          : ""}
      </p>
      <TimingPanel report={timing} />
    </section>
  );
}

function ReviewHeader({
  game,
  onBack,
  onSetHero,
}: {
  game: GameRecord;
  onBack: () => void;
  onSetHero: (gameId: string, hero: Color) => Promise<void>;
}) {
  return (
    <header className="review-head">
      <button type="button" className="button ghost small" onClick={onBack}>
        ← Games
      </button>
      <div className="review-title">
        <h1>
          {game.white} vs {game.black}
        </h1>
        <p className="muted small">
          {game.result}
          {game.opening ? ` · ${game.opening}` : ""}
        </p>
        <div className="side-switch" role="group" aria-label="Which side did you play?">
          <span className="muted small">You played</span>
          {(["w", "b"] as Color[]).map((color) => (
            <button
              key={color}
              type="button"
              className={`side-button ${game.hero === color ? "active" : ""}`}
              aria-pressed={game.hero === color}
              onClick={() => void onSetHero(game.id, color)}
            >
              {color === "w" ? "White" : "Black"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function BoardPanel({ move, flipped }: { move: AnalysedMove | undefined; flipped: boolean }) {
  if (!move) return null;
  const played = parseUci(move.uci);
  const best = move.bestUci ? parseUci(move.bestUci) : null;
  const showBest = isMistake(move.quality) && best && move.bestUci !== move.uci;

  return (
    <div className="board-panel">
      <Board
        fen={move.fenAfter}
        flipped={flipped}
        overlay={{
          lastMove: played ? { from: played.from, to: played.to } : null,
          mistakeMove: isMistake(move.quality) && played ? { from: played.from, to: played.to } : null,
          arrows:
            showBest && best
              ? [{ from: best.from, to: best.to, color: "rgba(111, 174, 90, 0.85)" }]
              : [],
        }}
      />
      <div className="board-legend muted small">
        {isMistake(move.quality) ? (
          <>
            <span className="swatch mistake" /> played
            {showBest && (
              <>
                <span className="swatch best" /> engine&apos;s choice
              </>
            )}
          </>
        ) : (
          <span>Evaluation {formatScore(move.scoreAfter)}</span>
        )}
      </div>
    </div>
  );
}

function MoveBar({
  moves,
  hero,
  currentPly,
  onSelect,
}: {
  moves: AnalysedMove[];
  hero: string;
  currentPly: number;
  onSelect: (ply: number) => void;
}) {
  const scrollTo = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, []);

  return (
    <div className="move-bar" role="tablist" aria-label="Moves">
      {moves.map((move) => {
        const isHero = move.color === hero;
        const active = move.ply === currentPly;
        return (
          <button
            key={move.ply}
            type="button"
            ref={active ? scrollTo : undefined}
            className={`move-chip ${active ? "active" : ""} ${isHero ? "hero" : ""}`}
            style={
              isHero && isMistake(move.quality)
                ? { borderColor: QUALITY_COLORS[move.quality] }
                : undefined
            }
            onClick={() => onSelect(move.ply)}
            aria-current={active}
          >
            <span className="move-number">
              {move.color === "w" ? `${move.moveNumber}.` : ""}
            </span>
            {move.san}
          </button>
        );
      })}
    </div>
  );
}

function CommentaryCard({
  move,
  heroIsMover,
  voiceEnabled,
  onSpeak,
}: {
  move: AnalysedMove;
  heroIsMover: boolean;
  voiceEnabled: boolean;
  onSpeak: () => void;
}) {
  const bestLine = formatSanLine(move.bestLineSan, move.moveNumber, move.color);
  return (
    <section className="card">
      <div className="card-head">
        <h2 style={{ color: QUALITY_COLORS[move.quality] }}>
          {move.headline ?? `${QUALITY_LABELS[move.quality]} · ${move.san}`}
        </h2>
        {voiceEnabled && speechSupported() && (
          <button type="button" className="button small ghost" onClick={onSpeak}>
            🔊 Say it
          </button>
        )}
      </div>

      <p>{move.explanation}</p>

      {move.coachNote && (
        <p className="coach-note">
          <strong>Coach:</strong> {move.coachNote}
        </p>
      )}

      <dl className="detail-grid">
        <div>
          <dt>Evaluation</dt>
          <dd>
            {formatScore(move.scoreBefore)} → {formatScore(move.scoreAfter)}
          </dd>
        </div>
        {move.bestSan && (
          <div>
            <dt>Engine line</dt>
            <dd className="mono">{bestLine || move.bestSan}</dd>
          </div>
        )}
        {move.tags.length > 0 && (
          <div>
            <dt>Pattern</dt>
            <dd>{move.tags.map((tag) => WEAKNESS_LABELS[tag]).join(" · ")}</dd>
          </div>
        )}
        <div>
          <dt>Chances lost</dt>
          <dd>
            {heroIsMover ? "" : "opponent: "}
            {(move.winProbLost * 100).toFixed(1)}%
          </dd>
        </div>
        {typeof move.secondsSpent === "number" && (
          <div>
            <dt>Time taken</dt>
            <dd>
              {formatDuration(move.secondsSpent)}
              {typeof move.clockAfter === "number"
                ? ` · ${formatDuration(move.clockAfter)} left`
                : ""}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const percent = Math.round((done / Math.max(1, total)) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent}>
      <div className="progress-bar" style={{ width: `${percent}%` }} />
      <span className="progress-label">
        {done} / {total} positions
      </span>
    </div>
  );
}
