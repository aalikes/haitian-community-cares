/**
 * Thin UCI wrapper around the Stockfish WASM worker.
 *
 * The stockfish.js build we ship reads the path to its `.wasm` from the worker
 * URL hash, defaulting to the same path with the extension swapped — so
 * `new Worker("/engine/stockfish-18-lite-single.js")` finds
 * `/engine/stockfish-18-lite-single.wasm` sitting next to it. Messages in and
 * out are plain UCI text lines.
 *
 * Requests are serialised: one search at a time per engine instance. Callers
 * that want more parallelism should create more instances (each one costs
 * another ~7 MB of WASM, so on a phone: don't).
 */

const ENGINE_URL = "/engine/stockfish-18-lite-single.js";

/** One line of the engine's principal-variation output. */
export interface EngineLine {
  /** 1-based MultiPV rank; 1 is the engine's preferred line. */
  multipv: number;
  /** Centipawns from the perspective of the side to move. Null for mate scores. */
  cp: number | null;
  /** Mate distance in moves from the side-to-move's perspective. Negative means being mated. */
  mate: number | null;
  depth: number;
  /** Moves in UCI coordinate notation, e.g. ["e2e4", "e7e5"]. */
  pv: string[];
}

export interface SearchResult {
  fen: string;
  depth: number;
  lines: EngineLine[];
  /** UCI best move, or null in a terminal position. */
  bestMove: string | null;
}

export interface SearchOptions {
  depth?: number;
  multiPv?: number;
  /** Hard wall-clock cap in ms; the search is stopped if it overruns. */
  timeoutMs?: number;
}

type Pending = {
  fen: string;
  resolve: (r: SearchResult) => void;
  reject: (e: unknown) => void;
  lines: Map<number, EngineLine>;
  timer: ReturnType<typeof setTimeout> | null;
};

export class Engine {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private currentMultiPv = 1;
  private disposed = false;

  /** Fires with a 0..1 fraction while the WASM binary downloads, if reported. */
  onDownloadProgress: ((fraction: number) => void) | null = null;

  /** Boots the worker and completes the UCI handshake. Safe to call repeatedly. */
  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(ENGINE_URL);
      } catch (err) {
        reject(new Error(`Could not start the chess engine worker: ${String(err)}`));
        return;
      }
      this.worker = worker;

      const settle = (err?: unknown) => {
        worker.removeEventListener("message", onHandshake);
        if (err) reject(err);
        else resolve();
      };

      const onHandshake = (event: MessageEvent) => {
        const line = String(event.data ?? "");
        if (line.startsWith("uciok")) {
          worker.addEventListener("message", this.onMessage);
          this.send("setoption name Threads value 1");
          this.send("setoption name Hash value 32");
          this.send("ucinewgame");
          settle();
        }
      };

      worker.addEventListener("message", onHandshake);
      worker.addEventListener("error", (event) => {
        const message = event.message || "engine worker crashed";
        settle(new Error(message));
        this.failPending(new Error(message));
      });

      this.send("uci");
    });
    return this.readyPromise;
  }

  /**
   * Analyses a single position. Resolves once the engine reports `bestmove`.
   * Calls are queued, so it is safe to fire these off in a loop.
   */
  analyse(fen: string, options: SearchOptions = {}): Promise<SearchResult> {
    const run = () => this.runSearch(fen, options);
    // Chain onto the queue but don't let one failure poison later searches.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.failPending(new Error("engine disposed"));
    if (this.worker) {
      try {
        this.worker.postMessage("quit");
      } catch {
        /* worker may already be gone */
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.readyPromise = null;
  }

  private async runSearch(fen: string, options: SearchOptions): Promise<SearchResult> {
    if (this.disposed) throw new Error("engine disposed");
    await this.init();

    const depth = options.depth ?? 14;
    const multiPv = Math.max(1, options.multiPv ?? 1);
    const timeoutMs = options.timeoutMs ?? 20_000;

    if (multiPv !== this.currentMultiPv) {
      this.send(`setoption name MultiPV value ${multiPv}`);
      this.currentMultiPv = multiPv;
    }

    return new Promise<SearchResult>((resolve, reject) => {
      this.pending = {
        fen,
        resolve,
        reject,
        lines: new Map(),
        timer: setTimeout(() => this.send("stop"), timeoutMs),
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  private send(command: string): void {
    this.worker?.postMessage(command);
  }

  private onMessage = (event: MessageEvent): void => {
    const line = String(event.data ?? "");
    if (line.startsWith("info")) {
      this.onInfo(line);
    } else if (line.startsWith("bestmove")) {
      this.onBestMove(line);
    } else if (line.startsWith("info WillOutputEngineDownloadProgress")) {
      /* handshake echo, ignore */
    } else if (line.startsWith("download")) {
      const match = /(\d+)\s*\/\s*(\d+)/.exec(line);
      if (match && this.onDownloadProgress) {
        this.onDownloadProgress(Number(match[1]) / Number(match[2]));
      }
    }
  };

  private onInfo(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    // Only full PV reports are useful; skip "currmove"-style progress lines.
    const pvIndex = line.indexOf(" pv ");
    if (pvIndex === -1) return;

    const depth = numberAfter(line, "depth");
    if (depth === null) return;
    const multipv = numberAfter(line, "multipv") ?? 1;
    const cp = numberAfter(line, "score cp");
    const mate = numberAfter(line, "score mate");
    const pv = line.slice(pvIndex + 4).trim().split(/\s+/).filter(Boolean);
    if (pv.length === 0) return;

    const previous = pending.lines.get(multipv);
    if (previous && previous.depth > depth) return; // keep the deepest report
    pending.lines.set(multipv, { multipv, cp, mate, depth, pv });
  }

  private onBestMove(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);

    const token = line.split(/\s+/)[1] ?? "";
    const bestMove = token && token !== "(none)" ? token : null;
    const lines = [...pending.lines.values()].sort((a, b) => a.multipv - b.multipv);
    const depth = lines.length > 0 ? Math.max(...lines.map((l) => l.depth)) : 0;

    pending.resolve({ fen: pending.fen, depth, lines, bestMove });
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function numberAfter(line: string, key: string): number | null {
  const index = line.indexOf(`${key} `);
  if (index === -1) return null;
  const value = Number.parseInt(line.slice(index + key.length + 1), 10);
  return Number.isNaN(value) ? null : value;
}

/** Shared instance — one 7 MB engine is plenty for a phone. */
let shared: Engine | null = null;

export function getEngine(): Engine {
  if (!shared) shared = new Engine();
  return shared;
}
