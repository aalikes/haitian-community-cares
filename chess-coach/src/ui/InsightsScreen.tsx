import { QUALITY_COLORS } from "../chess/classify";
import { formatDuration } from "../chess/clock";
import { MOVE_QUALITIES } from "../types";
import { TimingPanel } from "./TimingPanel";
import { useAppState } from "./state";

/**
 * The long view: what keeps going wrong, whether it is getting better, and
 * which phase of the game leaks the most.
 */
export function InsightsScreen() {
  const { profile, games, drills } = useAppState();

  if (profile.gamesAnalysed === 0) {
    return (
      <div className="screen">
        <section className="card">
          <h2>Nothing to report yet</h2>
          <p className="muted">
            Analyse a few games and this page fills in: your recurring mistake patterns, accuracy
            over time, and which phase of the game is costing you most.
          </p>
          <p className="muted small">
            {games.length} game{games.length === 1 ? "" : "s"} stored, none analysed.
          </p>
        </section>
      </div>
    );
  }

  const totalMoves = MOVE_QUALITIES.reduce(
    (sum, quality) => sum + (profile.counts[quality] ?? 0),
    0,
  );
  const phases = [
    { key: "opening" as const, label: "Opening" },
    { key: "middlegame" as const, label: "Middlegame" },
    { key: "endgame" as const, label: "Endgame" },
  ];
  const worstPhase = phases.reduce((worst, phase) =>
    profile.phaseLoss[phase.key] > profile.phaseLoss[worst.key] ? phase : worst,
  );

  return (
    <div className="screen">
      <section className="card tight">
        <h2>Overview</h2>
        <div className="stat-row">
          <Stat label="Games" value={String(profile.gamesAnalysed)} />
          <Stat label="Accuracy" value={`${profile.accuracy.toFixed(1)}%`} />
          <Stat label="Avg loss" value={`${profile.averageCentipawnLoss}cp`} />
          <Stat label="Drills" value={String(drills.length)} />
        </div>
        {profile.recentDelta !== null && (
          <p className={`trend ${profile.recentDelta >= 0 ? "up" : "down"}`}>
            {profile.recentDelta >= 0 ? "▲" : "▼"} {Math.abs(profile.recentDelta).toFixed(1)}
            {" points of accuracy over your last five games versus the five before."}
          </p>
        )}
      </section>

      <section className="card">
        <h2>What keeps going wrong</h2>
        {profile.weaknesses.length === 0 ? (
          <p className="muted">No repeat patterns yet — analyse more games.</p>
        ) : (
          <ul className="weakness-list">
            {profile.weaknesses.slice(0, 6).map((weakness) => {
              const share = Math.min(
                100,
                (weakness.count / Math.max(1, profile.weaknesses[0]!.count)) * 100,
              );
              return (
                <li key={weakness.tag}>
                  <div className="weakness-head">
                    <span>{weakness.label}</span>
                    <span className="muted small">
                      {weakness.count}× · {weakness.perGame.toFixed(1)} per game
                    </span>
                  </div>
                  <div className="bar">
                    <div className="bar-fill" style={{ width: `${share}%` }} />
                  </div>
                  <p className="muted small">{weakness.advice}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Move quality</h2>
        <div className="quality-bar">
          {MOVE_QUALITIES.map((quality) => {
            const count = profile.counts[quality] ?? 0;
            if (count === 0) return null;
            return (
              <div
                key={quality}
                className="quality-slice"
                style={{
                  width: `${(count / Math.max(1, totalMoves)) * 100}%`,
                  background: QUALITY_COLORS[quality],
                }}
                title={`${quality}: ${count}`}
              />
            );
          })}
        </div>
        <ul className="legend">
          {MOVE_QUALITIES.map((quality) => (
            <li key={quality}>
              <span className="swatch" style={{ background: QUALITY_COLORS[quality] }} />
              {quality} · {profile.counts[quality] ?? 0}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Where it leaks</h2>
        <p className="muted small">
          Average win probability lost per move. Your weakest phase is the {worstPhase.label.toLowerCase()}.
        </p>
        <ul className="phase-list">
          {phases.map((phase) => {
            const value = profile.phaseLoss[phase.key];
            const share = Math.min(100, value * 100 * 4);
            return (
              <li key={phase.key}>
                <div className="weakness-head">
                  <span>{phase.label}</span>
                  <span className="muted small">{(value * 100).toFixed(1)}% per move</span>
                </div>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {profile.timing && (
        <section className="card">
          <h2>Your clock</h2>
          <p className="muted small">
            From {profile.timedGames} game{profile.timedGames === 1 ? "" : "s"} that carried clock
            data. Fast and slow are judged against your own pace in each game, so blitz and rapid
            can be pooled without one drowning out the other. Total thinking time:{" "}
            {formatDuration(profile.timing.totalSeconds)}.
          </p>
          <TimingPanel report={profile.timing} />
        </section>
      )}

      {profile.openings.length > 0 && (
        <section className="card">
          <h2>Openings</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Opening</th>
                <th>Games</th>
                <th>Won</th>
                <th>Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {profile.openings.slice(0, 8).map((opening) => (
                <tr key={opening.name}>
                  <td>{opening.name}</td>
                  <td>{opening.games}</td>
                  <td>{opening.wins}</td>
                  <td>{opening.accuracy.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {profile.trend.length > 1 && (
        <section className="card">
          <h2>Accuracy over time</h2>
          <TrendChart points={profile.trend} />
        </section>
      )}
    </div>
  );
}

function TrendChart({ points }: { points: { playedAt: number; accuracy: number }[] }) {
  const width = 320;
  const height = 90;
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * width;
      const y = height - (point.accuracy / 100) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Accuracy per game over time"
    >
      <line x1="0" y1={height * 0.2} x2={width} y2={height * 0.2} className="eval-mid" />
      <line x1="0" y1={height * 0.5} x2={width} y2={height * 0.5} className="eval-mid" />
      <path d={path} className="eval-line" />
      {points.map((point, index) => (
        <circle
          key={`${point.playedAt}-${index}`}
          cx={(index / Math.max(1, points.length - 1)) * width}
          cy={height - (point.accuracy / 100) * height}
          r="2.6"
          className="trend-dot"
        />
      ))}
    </svg>
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
