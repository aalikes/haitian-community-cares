import { DEFAULT_SETTINGS, type Drill, type GameRecord, type Settings } from "../types";
import {
  STORE_DRILLS,
  STORE_GAMES,
  STORE_SETTINGS,
  clear,
  get,
  getAll,
  put,
  putMany,
  remove,
} from "./db";

const SETTINGS_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await get<Partial<Settings>>(STORE_SETTINGS, SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await put(STORE_SETTINGS, settings, SETTINGS_KEY);
}

export async function loadGames(): Promise<GameRecord[]> {
  const games = await getAll<GameRecord>(STORE_GAMES);
  return games.sort((a, b) => b.playedAt - a.playedAt);
}

export async function loadGame(id: string): Promise<GameRecord | undefined> {
  return get<GameRecord>(STORE_GAMES, id);
}

export async function saveGame(game: GameRecord): Promise<void> {
  await put(STORE_GAMES, game);
}

/** Adds games, skipping any whose id we already hold. Returns the number added. */
export async function addGames(games: GameRecord[]): Promise<number> {
  const existing = new Set((await getAll<GameRecord>(STORE_GAMES)).map((game) => game.id));
  const fresh = games.filter((game) => !existing.has(game.id));
  await putMany(STORE_GAMES, fresh);
  return fresh.length;
}

export async function deleteGame(id: string): Promise<void> {
  await remove(STORE_GAMES, id);
  const drills = await getAll<Drill>(STORE_DRILLS);
  await Promise.all(
    drills.filter((drill) => drill.gameId === id).map((drill) => remove(STORE_DRILLS, drill.id)),
  );
}

export async function loadDrills(): Promise<Drill[]> {
  return getAll<Drill>(STORE_DRILLS);
}

export async function saveDrills(drills: Drill[]): Promise<void> {
  await putMany(STORE_DRILLS, drills);
}

export async function saveDrill(drill: Drill): Promise<void> {
  await put(STORE_DRILLS, drill);
}

export async function clearEverything(): Promise<void> {
  await clear(STORE_GAMES);
  await clear(STORE_DRILLS);
}
