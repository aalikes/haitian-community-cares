import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { analyseGame, rescopeAnalysis } from "../engine/analysis";
import { drillsFromGame } from "../coach/drills";
import { buildProfile, type Profile } from "../coach/profile";
import { describeError, heroResultFrom } from "../data/importers";
import {
  addGames,
  clearEverything,
  deleteGame as deleteGameRecord,
  loadDrills,
  loadGames,
  loadSettings,
  saveDrill,
  saveDrills,
  saveGame,
  saveSettings,
} from "../data/store";
import {
  DEFAULT_SETTINGS,
  type Color,
  type Drill,
  type GameRecord,
  type Settings,
} from "../types";

export interface AnalysisJob {
  gameId: string;
  done: number;
  total: number;
}

interface AppState {
  ready: boolean;
  games: GameRecord[];
  drills: Drill[];
  settings: Settings;
  profile: Profile;
  job: AnalysisJob | null;
  error: string | null;
  notice: string | null;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  importGames: (games: GameRecord[]) => Promise<number>;
  removeGame: (id: string) => Promise<void>;
  runAnalysis: (gameId: string) => Promise<void>;
  cancelAnalysis: () => void;
  updateGame: (game: GameRecord) => Promise<void>;
  setHero: (gameId: string, hero: Color) => Promise<void>;
  updateDrill: (drill: Drill) => Promise<void>;
  resetEverything: () => Promise<void>;
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [games, setGames] = useState<GameRecord[]>([]);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [storedGames, storedDrills, storedSettings] = await Promise.all([
          loadGames(),
          loadDrills(),
          loadSettings(),
        ]);
        if (cancelled) return;
        setGames(storedGames);
        setDrills(storedDrills);
        setSettings(storedSettings);
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const profile = useMemo(() => buildProfile(games), [games]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      await saveSettings(next);
    },
    [settings],
  );

  const importGames = useCallback(async (incoming: GameRecord[]) => {
    const added = await addGames(incoming);
    setGames(await loadGames());
    return added;
  }, []);

  const removeGame = useCallback(async (id: string) => {
    await deleteGameRecord(id);
    setGames(await loadGames());
    setDrills(await loadDrills());
  }, []);

  const updateGame = useCallback(async (game: GameRecord) => {
    await saveGame(game);
    setGames((current) => current.map((entry) => (entry.id === game.id ? game : entry)));
  }, []);

  /**
   * Switches which player is "you". Cheap even for analysed games: the engine
   * output is side-independent, so only the commentary and the aggregates get
   * rebuilt.
   */
  const setHero = useCallback(
    async (gameId: string, hero: Color) => {
      const game = games.find((entry) => entry.id === gameId);
      if (!game || game.hero === hero) return;
      const updated: GameRecord = {
        ...game,
        hero,
        heroResult: heroResultFrom(game.result, hero),
        analysis: game.analysis ? rescopeAnalysis(game.analysis, hero) : undefined,
      };
      await saveGame(updated);
      setGames((current) => current.map((entry) => (entry.id === gameId ? updated : entry)));
      if (updated.analysis) {
        await saveDrills(drillsFromGame(updated));
        setDrills(await loadDrills());
      }
    },
    [games],
  );

  const updateDrill = useCallback(async (drill: Drill) => {
    await saveDrill(drill);
    setDrills((current) => current.map((entry) => (entry.id === drill.id ? drill : entry)));
  }, []);

  const runAnalysis = useCallback(
    async (gameId: string) => {
      const game = games.find((entry) => entry.id === gameId);
      if (!game) return;

      const abort = new AbortController();
      setController(abort);
      setJob({ gameId, done: 0, total: game.moveCount + 1 });
      setError(null);

      try {
        const analysis = await analyseGame(game, {
          depth: settings.depth,
          multiPv: settings.multiPv,
          signal: abort.signal,
          onProgress: (done, total) => setJob({ gameId, done, total }),
        });
        const analysed: GameRecord = { ...game, analysis };
        await saveGame(analysed);
        const newDrills = drillsFromGame(analysed);
        await saveDrills(newDrills);
        setGames((current) =>
          current.map((entry) => (entry.id === gameId ? analysed : entry)),
        );
        setDrills(await loadDrills());
        setNotice(
          `Analysis complete — ${analysis.accuracy.toFixed(1)}% accuracy, ${newDrills.length} drill${
            newDrills.length === 1 ? "" : "s"
          } added.`,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setNotice("Analysis cancelled.");
        } else {
          setError(describeError(err));
        }
      } finally {
        setJob(null);
        setController(null);
      }
    },
    [games, settings.depth, settings.multiPv],
  );

  const cancelAnalysis = useCallback(() => controller?.abort(), [controller]);

  const resetEverything = useCallback(async () => {
    await clearEverything();
    setGames([]);
    setDrills([]);
    setNotice("All stored games and drills removed.");
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      games,
      drills,
      settings,
      profile,
      job,
      error,
      notice,
      setError,
      setNotice,
      updateSettings,
      importGames,
      removeGame,
      runAnalysis,
      cancelAnalysis,
      updateGame,
      setHero,
      updateDrill,
      resetEverything,
    }),
    [
      ready,
      games,
      drills,
      settings,
      profile,
      job,
      error,
      notice,
      updateSettings,
      importGames,
      removeGame,
      runAnalysis,
      cancelAnalysis,
      updateGame,
      setHero,
      updateDrill,
      resetEverything,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState must be used inside AppStateProvider");
  return value;
}
