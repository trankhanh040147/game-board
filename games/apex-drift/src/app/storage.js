/**
 * Local persistence: best laps per track, plus the player's last choices.
 *
 * Everything degrades to an in-memory store when `localStorage` is unavailable
 * (private windows, Node tests), so the game never breaks over a failed write.
 */

import { STORAGE_KEY } from '../sim/config.js';

/** In-memory fallback that satisfies the Storage subset we use. */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

/** Return `localStorage` when usable, otherwise the memory fallback. */
export function getDefaultStorage() {
  try {
    if (typeof localStorage === 'undefined') return createMemoryStorage();
    const probe = '__apex_drift_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return createMemoryStorage();
  }
}

const DEFAULT_RECORDS = {
  bestLaps: {},
  bestTotal: {},
  car: 'vanko',
  track: 'neon-bay',
  quality: 'medium',
  camera: 'chase',
  muted: false,
  races: 0,
  wins: 0,
};

function sanitise(raw) {
  const records = { ...DEFAULT_RECORDS, bestLaps: {}, bestTotal: {} };
  if (!raw || typeof raw !== 'object') return records;
  if (raw.bestLaps && typeof raw.bestLaps === 'object') {
    for (const [track, value] of Object.entries(raw.bestLaps)) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 5 && seconds < 3600) {
        records.bestLaps[track] = seconds;
      }
    }
  }
  if (raw.bestTotal && typeof raw.bestTotal === 'object') {
    for (const [track, value] of Object.entries(raw.bestTotal)) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 5 && seconds < 36000) {
        records.bestTotal[track] = seconds;
      }
    }
  }
  for (const key of ['car', 'track', 'quality', 'camera']) {
    if (typeof raw[key] === 'string') records[key] = raw[key];
  }
  records.muted = Boolean(raw.muted);
  records.races = Number.isFinite(raw.races) ? Math.max(0, Math.round(raw.races)) : 0;
  records.wins = Number.isFinite(raw.wins) ? Math.max(0, Math.round(raw.wins)) : 0;
  return records;
}

/**
 * @param {{storage?:Storage, key?:string}} [options]
 */
export function createRecordStore(options = {}) {
  const storage = options.storage ?? getDefaultStorage();
  const key = options.key ?? STORAGE_KEY;
  let records = sanitise(read());

  function read() {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function write() {
    try {
      storage.setItem(key, JSON.stringify(records));
    } catch {
      /* quota or private mode: keep the in-memory copy */
    }
  }

  return {
    get all() {
      return records;
    },
    get(key2) {
      return records[key2];
    },
    set(key2, value) {
      records[key2] = value;
      write();
      return records;
    },
    bestLap(trackId) {
      return records.bestLaps[trackId] ?? null;
    },
    /** Store a lap time if it beats the record; returns true when it did. */
    submitLap(trackId, seconds) {
      if (!Number.isFinite(seconds) || seconds <= 5) return false;
      const current = records.bestLaps[trackId];
      if (current !== undefined && current <= seconds) return false;
      records.bestLaps[trackId] = seconds;
      write();
      return true;
    },
    submitTotal(trackId, seconds) {
      if (!Number.isFinite(seconds) || seconds <= 5) return false;
      const current = records.bestTotal[trackId];
      records.bestTotal[trackId] = seconds;
      write();
      return true;
    },
    incrementRaces(won) {
      records.races += 1;
      if (won) records.wins += 1;
      write();
      return records.races;
    },
    reset() {
      records = { ...DEFAULT_RECORDS, bestLaps: {}, bestTotal: {} };
      write();
      return records;
    },
  };
}

export { DEFAULT_RECORDS };
