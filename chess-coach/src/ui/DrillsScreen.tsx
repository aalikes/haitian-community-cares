import { Chess } from "chess.js";
import { useEffect, useMemo, useState } from "react";
import { isDrillSolved, recordAttempt, selectDrills } from "../coach/drills";
import { sanToSpeech } from "../coach/notation";
import { speak, speechSupported } from "../coach/voice";
import { uciToSan } from "../chess/util";
import { WEAKNESS_LABELS } from "../types";
import { Board } from "./Board";
import { useAppState } from "./state";

type Verdict = { correct: boolean; playedSan: string } | null;

/**
 * Practice built from your own blunders: the exact positions where you went
 * wrong, shown back to you with the clock stopped.
 */
export function DrillsScreen() {
  const { drills, profile, settings, updateDrill } = useAppState();

  const [sessionIds, setSessionIds] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState({ right: 0, total: 0 });

  const selection = useMemo(() => selectDrills(drills, profile, 8), [drills, profile]);

  // Freeze the queue for the session so answering does not reshuffle it.
  const session = useMemo(() => {
    if (!sessionIds) return selection.drills;
    return sessionIds
      .map((id) => drills.find((drill) => drill.id === id))
      .filter((drill): drill is NonNullable<typeof drill> => Boolean(drill));
  }, [sessionIds, selection.drills, drills]);

  const drill = session[index];

  useEffect(() => {
    setVerdict(null);
    setRevealed(false);
  }, [drill?.id]);

  if (drills.length === 0) {
    return (
      <div className="screen">
        <section className="card">
          <h2>No drills yet</h2>
          <p className="muted">
            Drills are generated from the mistakes in your analysed games. Analyse a game and the
            blunders and mistakes in it turn up here as practice positions.
          </p>
        </section>
      </div>
    );
  }

  if (!drill) {
    return (
      <div className="screen">
        <section className="card">
          <h2>Session complete</h2>
          <p>
            {score.right} of {score.total} correct.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setSessionIds(null);
              setIndex(0);
              setScore({ right: 0, total: 0 });
            }}
          >
            New session
          </button>
        </section>
      </div>
    );
  }

  const handleMove = async (uci: string) => {
    if (verdict) return;
    const correct = isDrillSolved(drill, uci);
    const playedSan = uciToSan(drill.fen, uci) ?? uci;
    setVerdict({ correct, playedSan });
    setScore((value) => ({ right: value.right + (correct ? 1 : 0), total: value.total + 1 }));
    if (settings.voiceEnabled && speechSupported()) {
      speak(
        correct
          ? `Correct. ${sanToSpeech(drill.bestSan)}.`
          : `Not this time. The move was ${sanToSpeech(drill.bestSan)}.`,
        { voiceUri: settings.voiceUri, rate: settings.voiceRate },
      );
    }
    await updateDrill(recordAttempt(drill, correct));
  };

  const advance = () => {
    if (sessionIds === null) setSessionIds(session.map((entry) => entry.id));
    setIndex((value) => value + 1);
  };

  const solutionFen = revealed || verdict ? positionAfter(drill.fen, drill.bestUci) : drill.fen;

  return (
    <div className="screen">
      <section className="card tight">
        <div className="card-head">
          <h2>
            Drill {index + 1} of {session.length}
          </h2>
          <span className="muted small">
            {score.right}/{score.total} this session
          </span>
        </div>
        {selection.focusLabel && (
          <p className="muted small">Focus: {selection.focusLabel}</p>
        )}
        <p className="drill-prompt">{drill.prompt}</p>
        <p className="muted small">
          {drill.sideToMove === "w" ? "White" : "Black"} to move
          {drill.tags.length > 0 ? ` · ${drill.tags.map((tag) => WEAKNESS_LABELS[tag]).join(", ")}` : ""}
        </p>
      </section>

      <Board
        fen={solutionFen}
        flipped={drill.sideToMove === "b"}
        interactive={!verdict && !revealed}
        onMove={(uci) => void handleMove(uci)}
        overlay={
          verdict || revealed
            ? { lastMove: squaresOf(drill.bestUci), suggestedMove: squaresOf(drill.bestUci) }
            : undefined
        }
      />

      {verdict ? (
        <section className={`card verdict ${verdict.correct ? "good" : "bad"}`}>
          <h2>{verdict.correct ? "Correct" : "Not this time"}</h2>
          <p>
            {verdict.correct
              ? `${drill.bestSan} was the move.`
              : `You played ${verdict.playedSan}. The move was ${drill.bestSan}.`}
          </p>
          <p className="muted small">In the game you played {drill.playedSan}.</p>
          <button type="button" className="button" onClick={advance}>
            Next drill
          </button>
        </section>
      ) : (
        <div className="button-row">
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setRevealed(true);
              void updateDrill(recordAttempt(drill, false));
              setScore((value) => ({ ...value, total: value.total + 1 }));
            }}
          >
            Show me
          </button>
          <button type="button" className="button ghost" onClick={advance}>
            Skip
          </button>
        </div>
      )}

      {revealed && !verdict && (
        <section className="card verdict bad">
          <h2>{drill.bestSan}</h2>
          <p className="muted small">In the game you played {drill.playedSan}.</p>
          <button type="button" className="button" onClick={advance}>
            Next drill
          </button>
        </section>
      )}
    </div>
  );
}

function squaresOf(uci: string): { from: string; to: string } | null {
  if (uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function positionAfter(fen: string, uci: string): string {
  const board = new Chess(fen);
  try {
    board.move({
      from: uci.slice(0, 2) as never,
      to: uci.slice(2, 4) as never,
      promotion: uci.length > 4 ? (uci[4] as never) : undefined,
    });
  } catch {
    return fen;
  }
  return board.fen();
}
