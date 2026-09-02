import { formatDuration } from "../chess/clock";
import type { TimingBucket, TimingReport } from "../types";

/**
 * The clock read as coaching rather than trivia: which pace costs you the most,
 * and whether the damage is concentrated in time trouble.
 *
 * Shared by the single-game review and the cross-game Insights page, because
 * the question is the same at both scales.
 */
export function TimingPanel({ report }: { report: TimingReport }) {
  const paces: { label: string; note: string; bucket: TimingBucket }[] = [
    {
      label: "Snap moves",
      note: `under ${formatDuration(report.fastThreshold)}`,
      bucket: report.rushed,
    },
    { label: "Normal pace", note: "your usual speed", bucket: report.steady },
    {
      label: "Long thinks",
      note: `over ${formatDuration(report.slowThreshold)}`,
      bucket: report.deliberate,
    },
  ];

  const pressure: { label: string; note: string; bucket: TimingBucket }[] = [
    {
      label: "In time trouble",
      note: `under ${formatDuration(report.troubleThreshold)} left`,
      bucket: report.timeTrouble,
    },
    { label: "Clock comfortable", note: "before that", bucket: report.comfortable },
  ];

  const baseline = report.steady.averageLoss;

  return (
    <>
      {report.findings.length > 0 && (
        <ul className="finding-list">
          {report.findings.map((finding) => (
            <li key={finding.kind} className={finding.kind === "healthy" ? "good" : "bad"}>
              {finding.text}
            </li>
          ))}
        </ul>
      )}

      <h3 className="panel-head">Cost by pace</h3>
      <LossRows rows={paces} baseline={baseline} />

      {report.timeTrouble.moves > 0 && report.troubleThreshold > 0 && (
        <>
          <h3 className="panel-head">Cost under pressure</h3>
          <LossRows rows={pressure} baseline={report.comfortable.averageLoss} />
        </>
      )}

      <h3 className="panel-head">Where the clock goes</h3>
      <PhaseSplit report={report} />
    </>
  );
}

/**
 * One row per bucket, bars scaled against the worst row so the comparison is
 * visible even when every bucket is small in absolute terms.
 */
function LossRows({
  rows,
  baseline,
}: {
  rows: { label: string; note: string; bucket: TimingBucket }[];
  baseline: number;
}) {
  const worst = Math.max(...rows.map((row) => row.bucket.averageLoss), 0.0001);

  return (
    <ul className="phase-list">
      {rows.map((row) => {
        const { bucket } = row;
        if (bucket.moves === 0) return null;
        // Anything meaningfully worse than the reference bucket reads as a problem.
        const costly = baseline > 0 && bucket.averageLoss >= baseline * 1.4;
        return (
          <li key={row.label}>
            <div className="weakness-head">
              <span>
                {row.label} <span className="muted small">· {row.note}</span>
              </span>
              <span className="muted small">
                {(bucket.averageLoss * 100).toFixed(1)}% per move
              </span>
            </div>
            <div className="bar">
              <div
                className={`bar-fill ${costly ? "danger" : ""}`}
                style={{ width: `${Math.min(100, (bucket.averageLoss / worst) * 100)}%` }}
              />
            </div>
            <p className="muted small">
              {bucket.moves} move{bucket.moves === 1 ? "" : "s"} · {formatDuration(bucket.averageSeconds)} each
              {bucket.mistakes > 0 ? ` · ${bucket.mistakes} went wrong` : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

const PHASES = [
  { key: "opening" as const, label: "Opening" },
  { key: "middlegame" as const, label: "Middlegame" },
  { key: "endgame" as const, label: "Endgame" },
];

function PhaseSplit({ report }: { report: TimingReport }) {
  return (
    <>
      <div className="quality-bar" role="img" aria-label="Share of thinking time by phase">
        {PHASES.map((phase, index) => {
          const value = report.phaseShare[phase.key];
          if (value <= 0) return null;
          return (
            <div
              key={phase.key}
              className="quality-slice"
              style={{
                width: `${value * 100}%`,
                background: `color-mix(in srgb, var(--accent) ${100 - index * 30}%, transparent)`,
              }}
              title={`${phase.label}: ${Math.round(value * 100)}%`}
            />
          );
        })}
      </div>
      <ul className="legend">
        {PHASES.map((phase, index) => (
          <li key={phase.key}>
            <span
              className="swatch"
              style={{
                background: `color-mix(in srgb, var(--accent) ${100 - index * 30}%, transparent)`,
              }}
            />
            {phase.label} · {Math.round(report.phaseShare[phase.key] * 100)}% ·{" "}
            {formatDuration(report.phaseSeconds[phase.key])}
          </li>
        ))}
      </ul>
    </>
  );
}
