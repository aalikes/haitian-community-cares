import { Chess } from "chess.js";
import { THEME, drawBoard, drawPiece, squareRect, type DrawOptions } from "../board/draw";
import type { FrameKind, StoryFrame } from "./storyboard";

/**
 * Draws a storyboard frame onto a canvas, including the caption panel.
 *
 * `progress` runs 0..1 through the frame and drives the piece slide, so the
 * same function serves a realtime animation loop and a frame-by-frame encoder.
 */

const BACKGROUND = "#16140f";
const PANEL = "#221f18";
const TEXT = "#f3ede0";
const MUTED = "#b7ae99";

const KIND_ACCENT: Record<FrameKind, string> = {
  neutral: "#e8b44a",
  played: "#d1524f",
  punish: "#d1524f",
  best: "#6fae5a",
};

export interface RenderLayout {
  width: number;
  height: number;
  flipped: boolean;
  /** Extra label drawn in the top strip, e.g. "White vs Black". */
  title?: string;
}

const MARGIN_RATIO = 0.045;
const TITLE_RATIO = 0.09;
const PANEL_RATIO = 0.34;

/**
 * Canvas height that fits a square board plus the caption panel exactly, with
 * no dead space. Callers size the canvas from this rather than picking a
 * height and hoping.
 */
export function preferredHeight(width: number, hasTitle: boolean): number {
  const margin = Math.round(width * MARGIN_RATIO);
  const title = hasTitle ? Math.round(width * TITLE_RATIO) : 0;
  const board = width - margin * 2;
  const panel = Math.round(width * PANEL_RATIO);
  return title + margin + board + margin + panel + margin;
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: StoryFrame,
  progress: number,
  layout: RenderLayout,
): void {
  const { width, height } = layout;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  const margin = Math.round(width * MARGIN_RATIO);
  const titleHeight = layout.title ? Math.round(width * TITLE_RATIO) : 0;
  const boardSize = Math.min(
    width - margin * 2,
    height - titleHeight - margin * 3 - width * PANEL_RATIO,
  );
  const boardX = (width - boardSize) / 2;
  const boardY = titleHeight + margin;

  if (layout.title) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(width * 0.036)}px system-ui, sans-serif`;
    ctx.fillText(layout.title, width / 2, titleHeight / 2 + margin * 0.4);
  }

  const options: DrawOptions = {
    x: boardX,
    y: boardY,
    size: boardSize,
    flipped: layout.flipped,
    theme: THEME,
  };

  const accent = KIND_ACCENT[frame.kind];
  const slide = frame.move ? easeInOut(clamp01(progress / 0.55)) : 1;

  if (frame.move && slide < 1) {
    // Mid-slide: hide the travelling piece and draw it at an interpolated point.
    const board = safeBoard(frame.fen);
    const piece = board?.get(frame.move.from as never);
    drawBoard(
      ctx,
      frame.fen,
      {
        arrows: frame.arrow ? [{ ...frame.arrow, color: withAlpha(accent, 0.8) }] : [],
        lastMove: null,
        hideSquares: [frame.move.from],
        showCoordinates: true,
      },
      options,
    );
    const from = squareRect(frame.move.from, options);
    const to = squareRect(frame.move.to, options);
    if (piece && from && to) {
      const cx = from.x + from.size / 2 + (to.x - from.x) * slide;
      const cy = from.y + from.size / 2 + (to.y - from.y) * slide;
      drawPiece(ctx, piece.type, piece.color, cx, cy, from.size);
    }
  } else {
    // Settled: show the resulting position with the move highlighted.
    const resultingFen = frame.move ? applyMove(frame.fen, frame.move) : frame.fen;
    drawBoard(
      ctx,
      resultingFen,
      {
        lastMove: frame.move ?? null,
        mistakeMove: frame.kind === "played" ? frame.move ?? null : null,
        suggestedMove: frame.kind === "best" ? frame.move ?? null : null,
        arrows: frame.arrow ? [{ ...frame.arrow, color: withAlpha(accent, 0.8) }] : [],
        showCoordinates: true,
      },
      options,
    );
  }

  drawCaptionPanel(ctx, frame, accent, {
    x: margin,
    y: boardY + boardSize + margin,
    width: width - margin * 2,
    height: height - (boardY + boardSize + margin) - margin,
  });
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function drawCaptionPanel(
  ctx: CanvasRenderingContext2D,
  frame: StoryFrame,
  accent: string,
  rect: Rect,
): void {
  if (rect.height <= 10) return;
  const radius = Math.round(rect.width * 0.03);
  ctx.fillStyle = PANEL;
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, radius);
  ctx.fill();

  ctx.fillStyle = accent;
  roundedRect(ctx, rect.x, rect.y, rect.width * 0.012, rect.height, radius * 0.3);
  ctx.fill();

  const padding = rect.width * 0.045;
  const headingSize = Math.round(rect.width * 0.055);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = TEXT;
  ctx.font = `600 ${headingSize}px system-ui, sans-serif`;
  ctx.fillText(frame.caption, rect.x + padding, rect.y + padding);

  if (frame.subCaption) {
    const bodySize = Math.round(rect.width * 0.04);
    ctx.fillStyle = MUTED;
    ctx.font = `${bodySize}px system-ui, sans-serif`;
    wrapText(
      ctx,
      frame.subCaption,
      rect.x + padding,
      rect.y + padding + headingSize * 1.5,
      rect.width - padding * 2,
      bodySize * 1.35,
      Math.max(1, Math.floor((rect.height - padding * 2 - headingSize * 1.5) / (bodySize * 1.35))),
    );
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/);
  let line = "";
  let lines = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      if (lines + 1 >= maxLines) {
        ctx.fillText(`${line}…`, x, y + lines * lineHeight);
        return;
      }
      ctx.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineHeight);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function applyMove(fen: string, move: { from: string; to: string }): string {
  const board = safeBoard(fen);
  if (!board) return fen;
  try {
    board.move({ from: move.from as never, to: move.to as never, promotion: "q" });
  } catch {
    return fen;
  }
  return board.fen();
}

function safeBoard(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
