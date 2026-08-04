import { useRef, useState } from "react";
import {
  describeError,
  importFromChessCom,
  importFromLichess,
  importPgnText,
} from "../data/importers";
import type { GameRecord } from "../types";
import { useAppState } from "./state";

export function GamesScreen({ onOpen }: { onOpen: (gameId: string) => void }) {
  const {
    games,
    settings,
    updateSettings,
    importGames,
    removeGame,
    runAnalysis,
    job,
    cancelAnalysis,
    setError,
    setNotice,
  } = useAppState();

  const [busy, setBusy] = useState<string | null>(null);
  const [pgnText, setPgnText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImport = async (
    label: string,
    load: () => Promise<{ games: GameRecord[]; skipped: { reason: string }[] }>,
  ) => {
    setBusy(label);
    setError(null);
    try {
      const result = await load();
      const added = await importGames(result.games);
      const parts = [`${added} new game${added === 1 ? "" : "s"} imported`];
      if (result.games.length > added) {
        parts.push(`${result.games.length - added} already stored`);
      }
      if (result.skipped.length > 0) {
        parts.push(`${result.skipped.length} skipped (${result.skipped[0]!.reason})`);
      }
      setNotice(`${parts.join(", ")}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (file: File) => {
    const text = await file.text();
    await handleImport("file", async () =>
      importPgnText(text, settings.chessComUser || settings.lichessUser),
    );
  };

  return (
    <div className="screen">
      <section className="card">
        <h2>Import games</h2>
        <p className="muted">
          Games are fetched straight from the public APIs and stored on this device only.
        </p>

        <div className="field-row">
          <label className="field">
            <span>Chess.com username</span>
            <input
              type="text"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={settings.chessComUser}
              placeholder="magnuscarlsen"
              onChange={(event) => void updateSettings({ chessComUser: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy !== null || !settings.chessComUser.trim()}
            onClick={() =>
              void handleImport("chess.com", () => importFromChessCom(settings.chessComUser, 20))
            }
          >
            {busy === "chess.com" ? "Fetching…" : "Fetch 20"}
          </button>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Lichess username</span>
            <input
              type="text"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={settings.lichessUser}
              placeholder="DrNykterstein"
              onChange={(event) => void updateSettings({ lichessUser: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy !== null || !settings.lichessUser.trim()}
            onClick={() =>
              void handleImport("lichess", () => importFromLichess(settings.lichessUser, 20))
            }
          >
            {busy === "lichess" ? "Fetching…" : "Fetch 20"}
          </button>
        </div>

        <div className="button-row">
          <button type="button" className="button ghost" onClick={() => fileRef.current?.click()}>
            Upload PGN file
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => setShowPaste((value) => !value)}
          >
            {showPaste ? "Hide paste box" : "Paste PGN"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pgn,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </div>

        {showPaste && (
          <div className="paste-box">
            <textarea
              value={pgnText}
              rows={6}
              placeholder="[Event &quot;Casual game&quot;]&#10;1. e4 e5 2. Nf3 …"
              onChange={(event) => setPgnText(event.target.value)}
            />
            <button
              type="button"
              className="button"
              disabled={!pgnText.trim() || busy !== null}
              onClick={() =>
                void handleImport("paste", async () => {
                  const result = importPgnText(
                    pgnText,
                    settings.chessComUser || settings.lichessUser,
                  );
                  setPgnText("");
                  return result;
                })
              }
            >
              Add games
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Your games</h2>
          <span className="muted">{games.length} stored</span>
        </div>

        {games.length === 0 ? (
          <p className="muted">
            Nothing here yet. Import from Chess.com or Lichess above, or upload a PGN.
          </p>
        ) : (
          <ul className="game-list">
            {games.map((game) => {
              const analysing = job?.gameId === game.id;
              return (
                <li key={game.id} className="game-row">
                  <button type="button" className="game-main" onClick={() => onOpen(game.id)}>
                    <div className="game-players">
                      <ResultDot result={game.heroResult} />
                      <span className="game-names">
                        {game.white} vs {game.black}
                      </span>
                    </div>
                    <div className="game-meta muted">
                      {formatDate(game.playedAt)} · {game.hero === "w" ? "White" : "Black"} ·{" "}
                      {game.moveCount} moves
                      {game.analysis ? ` · ${game.analysis.accuracy.toFixed(1)}%` : ""}
                    </div>
                  </button>

                  <div className="game-actions">
                    {analysing ? (
                      <button type="button" className="button small ghost" onClick={cancelAnalysis}>
                        {Math.round((job.done / Math.max(1, job.total)) * 100)}% · stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button small"
                        disabled={job !== null}
                        onClick={() => void runAnalysis(game.id)}
                      >
                        {game.analysis ? "Re-analyse" : "Analyse"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button small ghost danger"
                      aria-label={`Delete ${game.white} vs ${game.black}`}
                      onClick={() => void removeGame(game.id)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ResultDot({ result }: { result: GameRecord["heroResult"] }) {
  const label = result === "unknown" ? "unfinished" : result;
  return <span className={`result-dot ${result}`} title={label} aria-label={label} />;
}

function formatDate(stamp: number): string {
  return new Date(stamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
