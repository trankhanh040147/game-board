import type { Profile, Settings } from '../core/types';
import { levelFromXp, xpForLevel } from '../core/config';

const PROFILE_KEY = 'blade-and-mount.profile.v1';
const SETTINGS_KEY = 'blade-and-mount.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  sensitivity: 1.0,
  invertY: false,
  masterVolume: 0.85,
  musicVolume: 0.5,
  sfxVolume: 0.85,
  cameraShake: 1.0,
  showHints: true,
  language: 'en',
  fov: 62,
};

export function defaultProfile(): Profile {
  const now = Date.now();
  return {
    version: 1,
    name: 'The Wanderer',
    denars: 120,
    xp: 0,
    level: 1,
    renown: 0,
    tournamentsWon: 0,
    tournamentsPlayed: 0,
    meleeRuns: 0,
    bestMelee: 0,
    totalKills: 0,
    createdAt: now,
    lastPlayed: now,
  };
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadProfile(): Profile {
  const base = defaultProfile();
  const stored = safeParse<Partial<Profile>>(localStorage.getItem(PROFILE_KEY));
  if (!stored || typeof stored !== 'object') return base;
  const profile: Profile = { ...base, ...stored, version: 1 };
  profile.denars = Math.max(0, Number(profile.denars) || 0);
  profile.xp = Math.max(0, Number(profile.xp) || 0);
  profile.renown = Math.max(0, Number(profile.renown) || 0);
  profile.level = Math.max(1, Math.min(99, Number(profile.level) || levelFromXp(profile.xp)));
  profile.tournamentsWon = Math.max(0, Number(profile.tournamentsWon) || 0);
  profile.tournamentsPlayed = Math.max(0, Number(profile.tournamentsPlayed) || 0);
  profile.bestMelee = Math.max(0, Number(profile.bestMelee) || 0);
  return profile;
}

export function saveProfile(profile: Profile): void {
  profile.lastPlayed = Date.now();
  profile.version = 1;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage unavailable — game still works for the session */
  }
}

export function loadSettings(): Settings {
  const stored = safeParse<Partial<Settings>>(localStorage.getItem(SETTINGS_KEY));
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    quality: stored.quality === 'low' || stored.quality === 'medium' || stored.quality === 'high'
      ? stored.quality : DEFAULT_SETTINGS.quality,
    language: stored.language === 'vi' ? 'vi' : 'en',
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export interface XpGainResult {
  levelsGained: number;
  newLevel: number;
  xpToNext: number;
}

export function grantXp(profile: Profile, amount: number): XpGainResult {
  const previous = profile.level;
  profile.xp += Math.max(0, Math.round(amount));
  profile.level = levelFromXp(profile.xp);
  const newLevel = profile.level;
  return {
    levelsGained: Math.max(0, newLevel - previous),
    newLevel,
    xpToNext: xpForLevel(newLevel),
  };
}

export function grantRenown(profile: Profile, amount: number): void {
  profile.renown = Math.max(0, profile.renown + Math.round(amount));
}

export function grantDenars(profile: Profile, amount: number): number {
  const before = profile.denars;
  profile.denars = Math.max(0, profile.denars + Math.round(amount));
  return profile.denars - before;
}

export function recordTournament(profile: Profile, won: boolean): void {
  profile.tournamentsPlayed++;
  if (won) profile.tournamentsWon++;
}

export function recordMelee(profile: Profile, beaten: number): boolean {
  profile.meleeRuns++;
  const best = beaten > profile.bestMelee;
  if (best) profile.bestMelee = beaten;
  return best;
}

export function resetProfile(): Profile {
  const profile = defaultProfile();
  saveProfile(profile);
  return profile;
}
