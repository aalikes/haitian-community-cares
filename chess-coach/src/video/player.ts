import { drawFrame, type RenderLayout } from "./render";
import { storyboardDuration, type StoryFrame } from "./storyboard";

/**
 * Realtime storyboard playback and WebM export.
 *
 * Playback drives the visible canvas and can speak each frame's narration
 * through the device voice. Export drives an offscreen canvas through
 * MediaRecorder.
 *
 * One deliberate limitation: browsers do not let a page capture
 * `speechSynthesis` output, so the exported file carries on-screen captions but
 * no audio track. Live playback has the voice; the file is silent. Recording
 * your own narration would need microphone capture, which is a separate opt-in.
 */

export interface PlaybackOptions {
  layout: RenderLayout;
  /** Called at the start of each frame, for narration and UI state. */
  onFrame?: (frame: StoryFrame, index: number) => void;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** 1 is realtime; 1.5 plays half again as fast. */
  speed?: number;
}

/** Plays the storyboard on a visible canvas. Resolves when it finishes. */
export function playStoryboard(
  canvas: HTMLCanvasElement,
  frames: StoryFrame[],
  options: PlaybackOptions,
): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx || frames.length === 0) return Promise.resolve();

  canvas.width = options.layout.width;
  canvas.height = options.layout.height;

  return runTimeline(frames, options.speed ?? 1, {
    signal: options.signal,
    onFrameStart: options.onFrame,
    onProgress: options.onProgress,
    draw: (frame, progress) => drawFrame(ctx, frame, progress, options.layout),
  });
}

export interface ExportOptions {
  layout: RenderLayout;
  fps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  extension: string;
}

const CANDIDATE_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
];

export function videoExportSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickMimeType() !== null
  );
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * Renders the storyboard to a video file. Runs in real time — a 20-second clip
 * takes 20 seconds — because canvas capture streams frames as they are painted.
 */
export async function exportStoryboard(
  frames: StoryFrame[],
  options: ExportOptions,
): Promise<ExportResult> {
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("This browser cannot record video from a canvas.");
  if (frames.length === 0) throw new Error("Nothing to record.");

  const canvas = document.createElement("canvas");
  canvas.width = options.layout.width;
  canvas.height = options.layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a drawing context.");

  const fps = options.fps ?? 30;
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve());
    recorder.addEventListener("error", (event) =>
      reject((event as ErrorEvent).error ?? new Error("Recording failed")),
    );
  });

  // Paint the first frame before starting so the file never opens on black.
  drawFrame(ctx, frames[0]!, 0, options.layout);
  recorder.start(200);

  try {
    await runTimeline(frames, 1, {
      signal: options.signal,
      onProgress: options.onProgress,
      draw: (frame, progress) => drawFrame(ctx, frame, progress, options.layout),
    });
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  }

  await stopped;
  const blob = new Blob(chunks, { type: mimeType });
  return {
    blob,
    mimeType,
    durationMs: storyboardDuration(frames),
    extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
  };
}

interface TimelineHandlers {
  draw: (frame: StoryFrame, progress: number) => void;
  onFrameStart?: (frame: StoryFrame, index: number) => void;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Walks the storyboard in real time, calling `draw` once per animation frame. */
function runTimeline(
  frames: StoryFrame[],
  speed: number,
  handlers: TimelineHandlers,
): Promise<void> {
  const total = storyboardDuration(frames) / speed;
  const starts: number[] = [];
  let cursor = 0;
  for (const frame of frames) {
    starts.push(cursor);
    cursor += frame.durationMs / speed;
  }

  return new Promise<void>((resolve, reject) => {
    const start = performance.now();
    let announced = -1;
    let raf = 0;

    const onAbort = () => {
      cancelAnimationFrame(raf);
      reject(new DOMException("Playback cancelled", "AbortError"));
    };
    handlers.signal?.addEventListener("abort", onAbort, { once: true });

    const tick = (now: number) => {
      if (handlers.signal?.aborted) return;
      const elapsed = now - start;

      let index = frames.length - 1;
      for (let i = 0; i < frames.length; i += 1) {
        if (elapsed < starts[i]! + frames[i]!.durationMs / speed) {
          index = i;
          break;
        }
      }

      if (index !== announced) {
        announced = index;
        handlers.onFrameStart?.(frames[index]!, index);
      }

      const frame = frames[index]!;
      const progress = Math.min(1, (elapsed - starts[index]!) / (frame.durationMs / speed));
      handlers.draw(frame, progress);
      handlers.onProgress?.(Math.min(1, elapsed / total));

      if (elapsed >= total) {
        handlers.signal?.removeEventListener("abort", onAbort);
        handlers.draw(frames[frames.length - 1]!, 1);
        resolve();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
