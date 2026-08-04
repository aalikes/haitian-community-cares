import { useEffect, useState } from "react";
import { getEngine } from "./engine/engine";
import { DrillsScreen } from "./ui/DrillsScreen";
import { GamesScreen } from "./ui/GamesScreen";
import { InsightsScreen } from "./ui/InsightsScreen";
import { ReviewScreen } from "./ui/ReviewScreen";
import { SettingsScreen } from "./ui/SettingsScreen";
import { useAppState } from "./ui/state";

type Tab = "games" | "drills" | "insights" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "games", label: "Games", icon: "♟" },
  { id: "drills", label: "Drills", icon: "◎" },
  { id: "insights", label: "Insights", icon: "▤" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function App() {
  const { ready, error, notice, setError, setNotice, job, drills } = useAppState();
  const [tab, setTab] = useState<Tab>("games");
  const [openGame, setOpenGame] = useState<string | null>(null);

  // Start downloading the 7 MB engine as soon as the app opens, so the first
  // "Analyse" tap is not also a download wait.
  useEffect(() => {
    void getEngine()
      .init()
      .catch(() => {
        /* surfaced when analysis is actually requested */
      });
  }, []);

  // Auto-dismiss transient messages.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  if (!ready) {
    return (
      <div className="boot">
        <p>Loading your games…</p>
      </div>
    );
  }

  const dueDrills = drills.filter((drill) => drill.dueAt <= Date.now()).length;

  return (
    <div className="app">
      <main className="main">
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        {job && (
          <div className="banner working" role="status">
            Analysing… {job.done}/{job.total} positions
          </div>
        )}

        {openGame ? (
          <ReviewScreen gameId={openGame} onBack={() => setOpenGame(null)} />
        ) : tab === "games" ? (
          <GamesScreen onOpen={setOpenGame} />
        ) : tab === "drills" ? (
          <DrillsScreen />
        ) : tab === "insights" ? (
          <InsightsScreen />
        ) : (
          <SettingsScreen />
        )}
      </main>

      <nav className="tabbar">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tab ${!openGame && tab === entry.id ? "active" : ""}`}
            onClick={() => {
              setOpenGame(null);
              setTab(entry.id);
            }}
          >
            <span className="tab-icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="tab-label">{entry.label}</span>
            {entry.id === "drills" && dueDrills > 0 && <span className="badge">{dueDrills}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
