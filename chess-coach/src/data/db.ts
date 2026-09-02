/**
 * Minimal IndexedDB wrapper.
 *
 * Games with full analysis run 30–80 KB each, which blows past localStorage's
 * 5 MB budget after a couple of hundred games, so everything lives in IDB.
 * No dependency — the surface we need is four operations wide.
 */

const DB_NAME = "chess-coach";
const DB_VERSION = 1;

export const STORE_GAMES = "games";
export const STORE_DRILLS = "drills";
export const STORE_SETTINGS = "settings";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_GAMES)) {
        const games = db.createObjectStore(STORE_GAMES, { keyPath: "id" });
        games.createIndex("playedAt", "playedAt");
      }
      if (!db.objectStoreNames.contains(STORE_DRILLS)) {
        const drills = db.createObjectStore(STORE_DRILLS, { keyPath: "id" });
        drills.createIndex("dueAt", "dueAt");
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the database"));
  });
  return dbPromise;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Database request failed"));
      }),
  );
}

export function put<T>(store: string, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
  return run(store, "readwrite", (objectStore) =>
    key === undefined ? objectStore.put(value) : objectStore.put(value, key),
  );
}

export async function putMany<T>(store: string, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    for (const value of values) objectStore.put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Bulk write failed"));
  });
}

export function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (objectStore) => objectStore.get(key));
}

export function getAll<T>(store: string): Promise<T[]> {
  return run<T[]>(store, "readonly", (objectStore) => objectStore.getAll());
}

export function remove(store: string, key: IDBValidKey): Promise<undefined> {
  return run<undefined>(store, "readwrite", (objectStore) => objectStore.delete(key));
}

export function clear(store: string): Promise<undefined> {
  return run<undefined>(store, "readwrite", (objectStore) => objectStore.clear());
}
