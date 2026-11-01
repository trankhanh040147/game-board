import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultProfile,
  grantDenars,
  grantRenown,
  grantXp,
  loadProfile,
  loadSettings,
  recordMelee,
  recordTournament,
  saveProfile,
  saveSettings,
} from '../src/game/profile';
import { DEFAULT_SETTINGS } from '../src/game/profile';
import { levelFromXp, xpForLevel } from '../src/core/config';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
});

describe('profile persistence', () => {
  it('starts with the default wanderer profile', () => {
    const profile = loadProfile();
    expect(profile.name).toBe('The Wanderer');
    expect(profile.denars).toBe(120);
    expect(profile.level).toBe(1);
  });

  it('round-trips profile data', () => {
    const profile = defaultProfile();
    profile.denars = 777;
    profile.renown = 12;
    profile.tournamentsWon = 2;
    saveProfile(profile);
    const loaded = loadProfile();
    expect(loaded.denars).toBe(777);
    expect(loaded.renown).toBe(12);
    expect(loaded.tournamentsWon).toBe(2);
  });

  it('grants xp and levels up', () => {
    const profile = defaultProfile();
    const result = grantXp(profile, xpForLevel(1) + xpForLevel(2) + 5);
    expect(result.levelsGained).toBe(2);
    expect(profile.level).toBe(3);
    expect(levelFromXp(profile.xp)).toBe(3);
  });

  it('never lets denars go negative', () => {
    const profile = defaultProfile();
    grantDenars(profile, -100000);
    expect(profile.denars).toBe(0);
  });

  it('tracks renown, tournaments and melee bests', () => {
    const profile = defaultProfile();
    grantRenown(profile, 6);
    recordTournament(profile, true);
    recordMelee(profile, 17);
    recordMelee(profile, 9);
    expect(profile.renown).toBe(6);
    expect(profile.tournamentsPlayed).toBe(1);
    expect(profile.tournamentsWon).toBe(1);
    expect(profile.bestMelee).toBe(17);
  });

  it('sanitises corrupt stored data', () => {
    localStorage.setItem('blade-and-mount.profile.v1', '{"denars": -50, "level": "x"}');
    const profile = loadProfile();
    expect(profile.denars).toBe(0);
    expect(profile.level).toBe(1);
  });
});

describe('settings persistence', () => {
  it('falls back to defaults', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves and loads valid settings', () => {
    const settings = { ...DEFAULT_SETTINGS, quality: 'low' as const, sensitivity: 1.7, language: 'vi' as const };
    saveSettings(settings);
    expect(loadSettings()).toMatchObject({ quality: 'low', sensitivity: 1.7, language: 'vi' });
  });

  it('rejects invalid quality values', () => {
    localStorage.setItem('blade-and-mount.settings.v1', JSON.stringify({ quality: 'ultra', sensitivity: 2 }));
    expect(loadSettings().quality).toBe('high');
    expect(loadSettings().sensitivity).toBe(2);
  });
});
