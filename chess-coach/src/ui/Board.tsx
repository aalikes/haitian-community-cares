import { Chess, type Square } from "chess.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drawBoard, squareAt, type BoardOverlay, type DrawOptions } from "../board/draw";

export interface BoardProps {
  fen: string;
  flipped?: boolean;
  overlay?: BoardOverlay;
  /** Allow tapping pieces to make moves. */
  interactive?: boolean;
  /** Called with the UCI move once a legal move is tapped out. */
  onMove?: (uci: string) => void;
  className?: string;
}

/**
 * Interactive board. Tap a piece, tap a destination — no dragging, which is
 * both easier on a phone and less code than a drag-and-drop layer.
 */
export function Board({
  fen,
  flipped = false,
  overlay,
  interactive = false,
  onMove,
  className,
}: BoardProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(320);
  const [selected, setSelected] = useState<string | null>(null);

  // Reset the selection whenever the position changes underneath us.
  useEffect(() => setSelected(null), [fen]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setSize(Math.floor(width));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const legalTargets = useMemo(() => {
    if (!interactive || !selected) return [];
    try {
      const board = new Chess(fen);
      return board
        .moves({ square: selected as Square, verbose: true })
        .map((move) => move.to as string);
    } catch {
      return [];
    }
  }, [fen, interactive, selected]);

  const options: DrawOptions = useMemo(
    () => ({ x: 0, y: 0, size, flipped }),
    [size, flipped],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size * ratio);
    canvas.height = Math.floor(size * ratio);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawBoard(
      ctx,
      fen,
      {
        ...overlay,
        selected: selected ?? overlay?.selected ?? null,
        targets: legalTargets.length > 0 ? legalTargets : overlay?.targets,
      },
      options,
    );
  }, [fen, overlay, options, selected, legalTargets, size]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const square = squareAt(event.clientX - rect.left, event.clientY - rect.top, options);
      if (!square) return;

      let board: Chess;
      try {
        board = new Chess(fen);
      } catch {
        return;
      }

      if (selected) {
        const candidate = board
          .moves({ square: selected as Square, verbose: true })
          .find((move) => move.to === square);
        if (candidate) {
          // Auto-promote to a queen; anything else is rare enough to skip here.
          const promotion = candidate.promotion ? "q" : "";
          onMove?.(`${candidate.from}${candidate.to}${promotion}`);
          setSelected(null);
          return;
        }
      }

      const piece = board.get(square as Square);
      setSelected(piece && piece.color === board.turn() ? square : null);
    },
    [fen, interactive, onMove, options, selected],
  );

  return (
    <div className={`board-wrapper ${className ?? ""}`} ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        onPointerDown={handlePointer}
        style={{ cursor: interactive ? "pointer" : "default" }}
        role="img"
        aria-label="Chess board"
      />
    </div>
  );
}
