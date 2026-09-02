import { useMemo } from "react";
import { QUALITY_COLORS } from "../chess/classify";
import { scoreToWinProbability } from "../chess/evaluation";
import type { AnalysedMove, Color } from "../types";

interface EvalGraphProps {
  moves: AnalysedMove[];
  hero: Color;
  currentPly: number;
  onSelect: (ply: number) => void;
}

const WIDTH = 320;
const HEIGHT = 72;

/**
 * Win-probability graph from the hero's point of view, with a marker on every
 * mistake so the shape of the game is readable at a glance.
 */
export function EvalGraph({ moves, hero, currentPly, onSelect }: EvalGraphProps) {
  const points = useMemo(() => {
    return moves.map((move, index) => {
      // scoreAfter is from the mover's perspective; flip it when the opponent moved.
      const fromMover = scoreToWinProbability(move.scoreAfter);
      const heroProbability = move.color === hero ? fromMover : 1 - fromMover;
      return {
        x: (index / Math.max(1, moves.length - 1)) * WIDTH,
        y: HEIGHT - heroProbability * HEIGHT,
        move,
      };
    });
  }, [moves, hero]);

  if (points.length < 2) return null;

  const area = [
    `M 0 ${HEIGHT}`,
    ...points.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
    `L ${WIDTH} ${HEIGHT}`,
    "Z",
  ].join(" ");

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");

  const markers = points.filter(
    (point) =>
      point.move.color === hero &&
      (point.move.quality === "blunder" || point.move.quality === "mistake"),
  );

  const current = points[Math.min(currentPly, points.length - 1)];

  return (
    <svg
      className="eval-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Win probability across the game"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        onSelect(
          Math.max(0, Math.min(moves.length - 1, Math.round(fraction * (moves.length - 1)))),
        );
      }}
    >
      <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="eval-mid" />
      <path d={area} className="eval-area" />
      <path d={line} className="eval-line" />
      {markers.map((marker) => (
        <circle
          key={marker.move.ply}
          cx={marker.x}
          cy={marker.y}
          r="3.2"
          fill={QUALITY_COLORS[marker.move.quality]}
        />
      ))}
      {current && (
        <line x1={current.x} y1="0" x2={current.x} y2={HEIGHT} className="eval-cursor" />
      )}
    </svg>
  );
}
