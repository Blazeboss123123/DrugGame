/**
 * Persistent saves in IndexedDB (falls back to localStorage if IndexedDB is unavailable).
 * Saves are versioned so later updates can migrate older data.
 */

export const SAVE_VERSION = 3;
const DB = 'underworld-empire';
const STORE = 'saves';

export interface SaveSlotInfo {
  slot: number;
  savedAt: number;
  day: number;
  cash: number;
}

export interface SaveData {
  version: number;
  savedAt: number;
  [key: string]: unknown;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export class SaveSystem {
  private db: Promise<IDBDatabase | null> = openDb();

  async write(slot: number, data: SaveData): Promise<boolean> {
    const db = await this.db;
    if (db) {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(data, `slot${slot}`);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    }
    try {
      localStorage.setItem(`${DB}.slot${slot}`, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  async read(slot: number): Promise<SaveData | null> {
    const db = await this.db;
    if (db) {
      const v = await new Promise<SaveData | null>((resolve) => {
        try {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(`slot${slot}`);
          req.onsuccess = () => resolve((req.result as SaveData) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (v) return v;
    }
    try {
      const raw = localStorage.getItem(`${DB}.slot${slot}`);
      return raw ? (JSON.parse(raw) as SaveData) : null;
    } catch {
      return null;
    }
  }

  async remove(slot: number): Promise<void> {
    const db = await this.db;
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(`slot${slot}`);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    try {
      localStorage.removeItem(`${DB}.slot${slot}`);
    } catch {
      /* ignore */
    }
  }

  async list(): Promise<SaveSlotInfo[]> {
    const out: SaveSlotInfo[] = [];
    for (const slot of [1, 2, 3]) {
      const d = await this.read(slot);
      if (d && d.version <= SAVE_VERSION) {
        const econ = d.economy as { cash: number } | undefined;
        const time = d.time as { day: number } | undefined;
        out.push({ slot, savedAt: d.savedAt, day: time?.day ?? 1, cash: econ?.cash ?? 0 });
      }
    }
    return out;
  }
}
