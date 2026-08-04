import { useEffect, useMemo, useRef, useState } from "react";
import { speak, speechSupported, stopSpeaking } from "../coach/voice";
import { describeError } from "../data/importers";
import type { AnalysedMove, Color, Settings } from "../types";
import { drawFrame, preferredHeight } from "../video/render";
import {
  downloadBlob,
  exportStoryboard,
  playStoryboard,
  videoExportSupported,
} from "../video/player";
import { buildStoryboard, storyboardDuration } from "../video/storyboard";

interface ExplainClipProps {
  move: AnalysedMove;
  hero: Color;
  title: string;
  settings: Settings;
  onError: (message: string) => void;
}

const WIDTH = 720;
const HEIGHT = preferredHeight(WIDTH, true);

/**
 * The "show me" view: an animated replay of the mistake, the refutation, and
 * the move that should have been played — narrated by the device voice, and
 * exportable as a video file.
 */
export function ExplainClip({ move, hero, title, settings, onError }: ExplainClipProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<"idle" | "playing" | "recording">("idle");
  const [progress, setProgress] = useState(0);
  const [caption, setCaption] = useState<string | null>(null);

  const frames = useMemo(() => buildStoryboard(move, move.color === hero), [move, hero]);
  const layout = useMemo(
    () => ({ width: WIDTH, height: HEIGHT, flipped: hero === "b", title }),
    [hero, title],
  );
  const seconds = Math.round(storyboardDuration(frames) / 100) / 10;

  // Paint the opening frame so the panel is never blank.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    if (ctx) drawFrame(ctx, frames[0]!, 0, layout);
  }, [frames, layout]);

  // Never leave a voice talking to an unmounted component.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopSpeaking();
    };
  }, []);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeaking();
    setState("idle");
    setProgress(0);
    setCaption(null);
  };

  const play = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    stop();
    const controller = new AbortController();
    abortRef.current = controller;
    setState("playing");

    const narrate = settings.voiceEnabled && speechSupported();
    try {
      await playStoryboard(canvas, frames, {
        layout,
        signal: controller.signal,
        onProgress: setProgress,
        onFrame: (frame) => {
          setCaption(frame.subCaption ?? frame.caption);
          if (narrate && frame.say) {
            speak(frame.say, { voiceUri: settings.voiceUri, rate: settings.voiceRate });
          }
        },
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        onError(describeError(error));
      }
    } finally {
      stopSpeaking();
      abortRef.current = null;
      setState("idle");
      setProgress(0);
    }
  };

  const record = async () => {
    stop();
    const controller = new AbortController();
    abortRef.current = controller;
    setState("recording");
    try {
      const result = await exportStoryboard(frames, {
        layout,
        signal: controller.signal,
        onProgress: setProgress,
      });
      const label = `${move.moveNumber}${move.color === "w" ? "w" : "b"}-${move.san.replace(
        /[^a-z0-9]/gi,
        "",
      )}`;
      downloadBlob(result.blob, `chess-coach-${label}.${result.extension}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        onError(describeError(error));
      }
    } finally {
      abortRef.current = null;
      setState("idle");
      setProgress(0);
    }
  };

  return (
    <div className="clip">
      <canvas ref={canvasRef} className="clip-canvas" aria-label="Move explanation replay" />

      {state !== "idle" && (
        <div className="clip-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
          <div className="clip-progress-bar" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {/* The canvas text is invisible to assistive tech, so mirror it here. */}
      <p className="sr-only" aria-live="polite">
        {caption ?? ""}
      </p>

      <div className="button-row">
        {state === "idle" ? (
          <button type="button" className="button" onClick={() => void play()}>
            ▶ Play explanation ({seconds}s)
          </button>
        ) : (
          <button type="button" className="button ghost" onClick={stop}>
            Stop
          </button>
        )}
        <button
          type="button"
          className="button ghost"
          disabled={state !== "idle" || !videoExportSupported()}
          onClick={() => void record()}
          title={
            videoExportSupported()
              ? "Records in real time, so this takes about as long as the clip"
              : "This browser cannot record canvas video"
          }
        >
          {state === "recording" ? "Recording…" : "Save as video"}
        </button>
      </div>

      <p className="muted small">
        The saved file carries the on-screen captions. Browsers do not let a page capture the
        system voice, so the exported video has no audio track — the narration plays live here.
      </p>
    </div>
  );
}
