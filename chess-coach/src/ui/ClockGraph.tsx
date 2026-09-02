import { useMemo } from "react";
import { QUALITY_COLORS, isMistake } from "../chess/classify";
import type { AnalysedMove, Color } from "../types";

const WIDTH = 320;
const HEIGHT = 72;

interface ClockGraphProps {
  moves: AnalysedMove[];
  hero: Color;
  /** Clock reading below which the hero counts as short of time. */
  troubleThreshold: number;
  currentPly: number;
  onSelect: (ply: number) => void;
}

/**
 * Both clocks draining across the game, with the hero's mistakes marked.
 *
 * The shape is the point: a line that falls off a cliff and then sprouts red
 * dots tells the whole story of a time scramble in one glance, which no table
 * of averages does.
 */
export function ClockGraph({
  moves,
  hero,
  troubleThreshold,
  currentPly,
  onSelect,
}: ClockGraphProps) {
  const { heroPath, opponentPath, markers, ceiling } = useMemo(() => {
    const readings = moves
      .map((move) => move.clockAfter)
      .filter((value): value is number => typeof value === "number");
    const top = Math.max(...readings, 1);

    const x = (ply: number) => (ply / Math.max(1, moves.length - 1)) * WIDTH;
    const y = (seconds: number) => HEIGHT - (seconds / top) * HEIGHT;

    const build = (color: Color) =>
      moves
        .filter(
          (move) => move.color === color && typeof move.clockAfter === "number",
        )
        .map((move, index) => {
          const point = `${x(move.ply).toFixed(1)} ${y(move.clockAfter as number).toFixed(1)}`;
          return `${index === 0 ? "M" : "L"} ${point}`;
        })
        .join(" ");

    return {
      heroPath: build(hero),
      opponentPath: build(hero === "w" ? "b" : "w"),
      ceiling: top,
      markers: moves
        .filter(
          (move) =>
            move.color === hero &&
            isMistake(move.quality) &&
            typeof move.clockAfter === "number",
        )
        .map((move) => ({
          ply: move.ply,
          cx: x(move.ply),
          cy: y(move.clockAfter as number),
          quality: move.quality,
        })),
    };
  }, [moves, hero]);

  if (!heroPath) return null;

  const cursorX = (Math.min(currentPly, moves.length - 1) / Math.max(1, moves.length - 1)) * WIDTH;
  const troubleY = HEIGHT - (troubleThreshold / ceiling) * HEIGHT;

  return (
    <svg
      className="eval-graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Time remaining on both clocks across the game"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        onSelect(
          Math.max(0, Math.min(moves.length - 1, Math.round(fraction * (moves.length - 1)))),
        );
      }}
    >
      {troubleThreshold > 0 && troubleY < HEIGHT && (
        <line x1="0" y1={troubleY} x2={WIDTH} y2={troubleY} className="clock-trouble" />
      )}
      <path d={opponentPath} className="clock-line opponent" />
      <path d={heroPath} className="clock-line" />
      {markers.map((marker) => (
        <circle
          key={marker.ply}
          cx={marker.cx}
          cy={marker.cy}
          r="3.2"
          fill={QUALITY_COLORS[marker.quality]}
        />
      ))}
      <line x1={cursorX} y1="0" x2={cursorX} y2={HEIGHT} className="eval-cursor" />
    </svg>
  );
}
