import { Chess } from "chess.js";

/**
 * Canvas board renderer.
 *
 * One renderer serves both the interactive board and the video export, so what
 * you see on screen is exactly what lands in the exported clip.
 *
 * Pieces are drawn as Unicode chess glyphs with the text-presentation selector
 * (U+FE0E) appended, which stops phones rendering them as colour emoji. White
 * pieces use the solid glyph filled light with a dark outline, so both colours
 * are the same shape and read correctly on either square colour.
 */

export const PIECE_GLYPHS: Record<string, string> = {
  k: "♚︎",
  q: "♛︎",
  r: "♜︎",
  b: "♝︎",
  n: "♞︎",
  p: "♟︎",
};

const PIECE_FONT_STACK =
  '"DejaVu Sans", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", "Arial Unicode MS", sans-serif';

export interface Theme {
  light: string;
  dark: string;
  lightPiece: string;
  darkPiece: string;
  pieceOutline: string;
  coordinate: string;
  lastMove: string;
  suggestion: string;
  mistake: string;
  check: string;
  selected: string;
  target: string;
}

export const THEME: Theme = {
  light: "#efe3c8",
  dark: "#a8825b",
  lightPiece: "#fdfaf3",
  darkPiece: "#241f19",
  pieceOutline: "#241f19",
  coordinate: "#00000055",
  lastMove: "rgba(232, 180, 74, 0.45)",
  suggestion: "rgba(111, 174, 90, 0.45)",
  mistake: "rgba(209, 82, 79, 0.45)",
  check: "rgba(209, 82, 79, 0.75)",
  selected: "rgba(76, 194, 176, 0.5)",
  target: "rgba(36, 31, 25, 0.28)",
};

export interface Arrow {
  from: string;
  to: string;
  color: string;
}

export interface BoardOverlay {
  lastMove?: { from: string; to: string } | null;
  /** Highlighted in red — the move that went wrong. */
  mistakeMove?: { from: string; to: string } | null;
  /** Highlighted in green — what should have been played. */
  suggestedMove?: { from: string; to: string } | null;
  selected?: string | null;
  targets?: string[];
  arrows?: Arrow[];
  showCoordinates?: boolean;
  /** Squares to leave empty — used while a piece is mid-slide during animation. */
  hideSquares?: string[];
}

export interface DrawOptions {
  x?: number;
  y?: number;
  size: number;
  flipped: boolean;
  theme?: Theme;
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** Pixel rect of a square, honouring board orientation. */
export function squareRect(
  square: string,
  options: DrawOptions,
): { x: number; y: number; size: number } | null {
  const file = FILES.indexOf(square[0] ?? "");
  const rank = Number.parseInt(square[1] ?? "", 10);
  if (file < 0 || Number.isNaN(rank)) return null;
  const cell = options.size / 8;
  const column = options.flipped ? 7 - file : file;
  const row = options.flipped ? rank - 1 : 8 - rank;
  return {
    x: (options.x ?? 0) + column * cell,
    y: (options.y ?? 0) + row * cell,
    size: cell,
  };
}

/** Inverse of `squareRect`: which square is at this pixel? */
export function squareAt(px: number, py: number, options: DrawOptions): string | null {
  const cell = options.size / 8;
  const column = Math.floor((px - (options.x ?? 0)) / cell);
  const row = Math.floor((py - (options.y ?? 0)) / cell);
  if (column < 0 || column > 7 || row < 0 || row > 7) return null;
  const file = options.flipped ? 7 - column : column;
  const rank = options.flipped ? row + 1 : 8 - row;
  return `${FILES[file]}${rank}`;
}

export function drawBoard(
  ctx: CanvasRenderingContext2D,
  fen: string,
  overlay: BoardOverlay,
  options: DrawOptions,
): void {
  const theme = options.theme ?? THEME;
  const originX = options.x ?? 0;
  const originY = options.y ?? 0;
  const cell = options.size / 8;

  // Squares.
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const isLight = (row + column) % 2 === 0;
      ctx.fillStyle = isLight ? theme.light : theme.dark;
      ctx.fillRect(originX + column * cell, originY + row * cell, cell + 0.5, cell + 0.5);
    }
  }

  // Highlights, painted under the pieces.
  fillSquares(ctx, moveSquares(overlay.lastMove), theme.lastMove, options);
  fillSquares(ctx, moveSquares(overlay.mistakeMove), theme.mistake, options);
  fillSquares(ctx, moveSquares(overlay.suggestedMove), theme.suggestion, options);
  if (overlay.selected) fillSquares(ctx, [overlay.selected], theme.selected, options);

  let board: Chess | null = null;
  try {
    board = new Chess(fen);
  } catch {
    board = null;
  }

  if (board?.isCheck()) {
    const kingSquare = findKing(board);
    if (kingSquare) {
      const rect = squareRect(kingSquare, options);
      if (rect) {
        const gradient = ctx.createRadialGradient(
          rect.x + rect.size / 2,
          rect.y + rect.size / 2,
          rect.size * 0.1,
          rect.x + rect.size / 2,
          rect.y + rect.size / 2,
          rect.size * 0.6,
        );
        gradient.addColorStop(0, theme.check);
        gradient.addColorStop(1, "rgba(209, 82, 79, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
      }
    }
  }

  if (overlay.showCoordinates !== false) drawCoordinates(ctx, theme, options);

  // Pieces.
  if (board) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(cell * 0.76)}px ${PIECE_FONT_STACK}`;
    ctx.lineJoin = "round";
    const hidden = new Set(overlay.hideSquares ?? []);
    for (const row of board.board()) {
      for (const piece of row) {
        if (!piece || hidden.has(piece.square)) continue;
        const rect = squareRect(piece.square, options);
        if (!rect) continue;
        drawPiece(
          ctx,
          piece.type,
          piece.color,
          rect.x + rect.size / 2,
          rect.y + rect.size / 2,
          rect.size,
          theme,
        );
      }
    }
  }

  // Legal-move dots, painted over pieces so captures stay visible.
  for (const target of overlay.targets ?? []) {
    const rect = squareRect(target, options);
    if (!rect) continue;
    ctx.fillStyle = theme.target;
    ctx.beginPath();
    ctx.arc(rect.x + rect.size / 2, rect.y + rect.size / 2, rect.size * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const arrow of overlay.arrows ?? []) drawArrow(ctx, arrow, options);
}

/**
 * Draws one piece centred on (cx, cy). Exported so animations can slide a
 * piece between squares without re-deriving the glyph and outline styling.
 */
export function drawPiece(
  ctx: CanvasRenderingContext2D,
  type: string,
  color: "w" | "b",
  cx: number,
  cy: number,
  cell: number,
  theme: Theme = THEME,
): void {
  const glyph = PIECE_GLYPHS[type] ?? "?";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(cell * 0.76)}px ${PIECE_FONT_STACK}`;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.5, cell * 0.055);
  ctx.strokeStyle = color === "w" ? theme.pieceOutline : "rgba(253,250,243,0.55)";
  ctx.strokeText(glyph, cx, cy + cell * 0.02);
  ctx.fillStyle = color === "w" ? theme.lightPiece : theme.darkPiece;
  ctx.fillText(glyph, cx, cy + cell * 0.02);
}

function moveSquares(move: { from: string; to: string } | null | undefined): string[] {
  return move ? [move.from, move.to] : [];
}

function fillSquares(
  ctx: CanvasRenderingContext2D,
  squares: string[],
  color: string,
  options: DrawOptions,
): void {
  ctx.fillStyle = color;
  for (const square of squares) {
    const rect = squareRect(square, options);
    if (rect) ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
  }
}

function drawCoordinates(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  options: DrawOptions,
): void {
  const cell = options.size / 8;
  ctx.fillStyle = theme.coordinate;
  ctx.font = `${Math.round(cell * 0.22)}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";

  ctx.textAlign = "left";
  for (const file of FILES) {
    const rect = squareRect(`${file}1`, options);
    if (rect) ctx.fillText(file, rect.x + cell * 0.08, rect.y + cell * 0.94);
  }
  for (let rank = 1; rank <= 8; rank += 1) {
    const rect = squareRect(`a${rank}`, options);
    if (rect) ctx.fillText(String(rank), rect.x + cell * 0.08, rect.y + cell * 0.26);
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, arrow: Arrow, options: DrawOptions): void {
  const from = squareRect(arrow.from, options);
  const to = squareRect(arrow.to, options);
  if (!from || !to) return;

  const cell = from.size;
  const x1 = from.x + cell / 2;
  const y1 = from.y + cell / 2;
  const x2 = to.x + cell / 2;
  const y2 = to.y + cell / 2;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = cell * 0.34;
  // Stop the shaft short so the head sits inside the destination square.
  const endX = x2 - Math.cos(angle) * head * 0.8;
  const endY = y2 - Math.sin(angle) * head * 0.8;

  ctx.save();
  ctx.strokeStyle = arrow.color;
  ctx.fillStyle = arrow.color;
  ctx.lineWidth = cell * 0.14;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - Math.cos(angle - Math.PI / 7) * head,
    y2 - Math.sin(angle - Math.PI / 7) * head,
  );
  ctx.lineTo(
    x2 - Math.cos(angle + Math.PI / 7) * head,
    y2 - Math.sin(angle + Math.PI / 7) * head,
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function findKing(board: Chess): string | null {
  const turn = board.turn();
  for (const row of board.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === turn) return piece.square;
    }
  }
  return null;
}
