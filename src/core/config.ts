import type {
  AIProfile,
  ArmorDef,
  AttackDir,
  GuardDir,
  HelmetDef,
  Loadout,
  ShieldDef,
  WeaponDef,
} from './types';

/* ------------------------------------------------------------------ */
/* Arena / identity                                                    */
/* ------------------------------------------------------------------ */

export const GAME_TITLE = 'BLADE & MOUNT';
export const GAME_SUBTITLE = 'TOURNAMENT OF THE REALM';
export const ARENA_NAME = 'The Old Lists of Aldermere';

export const TEAM_PALETTE = [
  { id: 0, name: 'House Valdric', color: 0x9d2f2b, colorName: 'Crimson', secondary: 0xd9c9a3, css: '#b8453f' },
  { id: 1, name: 'House Corvane', color: 0x2f4f87, colorName: 'Azure', secondary: 0xd6cba5, css: '#4f78bb' },
  { id: 2, name: 'House Thornwood', color: 0x3d6b3a, colorName: 'Verdant', secondary: 0xcbbf92, css: '#5f9457' },
  { id: 3, name: 'House Aurelian', color: 0xbf9530, colorName: 'Gold', secondary: 0x5a3b2a, css: '#d3ae4f' },
] as const;

export const MELEE_TUNIC_COLORS = [
  0x7a4a32, 0x5c5c4a, 0x6a3b35, 0x465a5c, 0x6b5a2f, 0x57415c, 0x3f4f38, 0x74513a,
];

/* ------------------------------------------------------------------ */
/* Weapons                                                             */
/* ------------------------------------------------------------------ */

export const WEAPONS: Record<string, WeaponDef> = {
  arming_sword: {
    id: 'arming_sword', name: 'Arming Sword', kind: 'sword', damage: 24, speed: 1.0, reach: 2.55,
    weight: 1.1, armorPen: 0.15, twoHanded: false, length: 0.95, bladeColor: 0xd8dde2, hiltColor: 0x6b4a2b, headBias: 0.15,
  },
  short_sword: {
    id: 'short_sword', name: 'Short Sword', kind: 'sword', damage: 20, speed: 1.16, reach: 2.25,
    weight: 0.85, armorPen: 0.1, twoHanded: false, length: 0.75, bladeColor: 0xd2d7dd, hiltColor: 0x5b3c23, headBias: 0.1,
  },
  falchion: {
    id: 'falchion', name: 'Falchion', kind: 'saber', damage: 27, speed: 0.96, reach: 2.4,
    weight: 1.0, armorPen: 0.12, twoHanded: false, length: 0.88, bladeColor: 0xc9ccd2, hiltColor: 0x7a4a2a, headBias: 0.2,
  },
  war_axe: {
    id: 'war_axe', name: 'War Axe', kind: 'axe', damage: 32, speed: 0.84, reach: 2.45,
    weight: 1.7, armorPen: 0.32, twoHanded: false, length: 0.8, bladeColor: 0xb9bec4, hiltColor: 0x5a3d26, headBias: 0.3,
  },
  mace: {
    id: 'mace', name: 'Flanged Mace', kind: 'mace', damage: 30, speed: 0.88, reach: 2.4,
    weight: 1.9, armorPen: 0.45, twoHanded: false, length: 0.78, bladeColor: 0x9aa0a6, hiltColor: 0x4e3522, headBias: 0.35,
  },
  greatsword: {
    id: 'greatsword', name: 'Greatsword', kind: 'greatsword', damage: 42, speed: 0.72, reach: 3.15,
    weight: 2.5, armorPen: 0.25, twoHanded: true, length: 1.45, bladeColor: 0xdde2e8, hiltColor: 0x5c4028, headBias: 0.2,
  },
  spear: {
    id: 'spear', name: 'War Spear', kind: 'spear', damage: 29, speed: 1.02, reach: 3.3,
    weight: 1.3, armorPen: 0.35, twoHanded: false, length: 2.3, bladeColor: 0xc9ced4, hiltColor: 0x6b4c2c, headBias: 0.0,
  },
  boar_spear: {
    id: 'boar_spear', name: 'Boar Spear', kind: 'spear', damage: 35, speed: 0.9, reach: 3.1,
    weight: 1.8, armorPen: 0.4, twoHanded: true, length: 2.1, bladeColor: 0xc2c7cd, hiltColor: 0x543a24, headBias: 0.0,
  },
  quarterstaff: {
    id: 'quarterstaff', name: 'Quarterstaff', kind: 'staff', damage: 21, speed: 1.1, reach: 2.85,
    weight: 1.2, armorPen: 0.2, twoHanded: true, length: 1.9, bladeColor: 0x7a5b38, hiltColor: 0x4a3520, headBias: 0.25,
  },
};

export const SHIELDS: Record<string, ShieldDef> = {
  kite: {
    id: 'kite', name: 'Kite Shield', width: 0.62, height: 0.95, armor: 26, coverage: 0.72,
    color: 0x8e2f2b, color2: 0xd9c9a3, emblem: 'cross',
  },
  heater: {
    id: 'heater', name: 'Heater Shield', width: 0.58, height: 0.72, armor: 22, coverage: 0.62,
    color: 0x2f4f87, color2: 0xd6cba5, emblem: 'chevron',
  },
  round: {
    id: 'round', name: 'Round Shield', width: 0.66, height: 0.66, armor: 18, coverage: 0.55,
    color: 0x7a5a2e, color2: 0x3c2c1c, emblem: 'sun',
  },
  tower: {
    id: 'tower', name: 'Tower Shield', width: 0.52, height: 1.1, armor: 32, coverage: 0.85,
    color: 0x3d6b3a, color2: 0xcec197, emblem: 'bars',
  },
};

export const ARMORS: Record<string, ArmorDef> = {
  gambeson: {
    id: 'gambeson', name: 'Padded Gambeson', body: 12, head: 0, legs: 6, weight: 2.2, tier: 1,
    style: 'gambeson', color: 0x8a6b45, trim: 0x5a4329,
  },
  jerkin: {
    id: 'jerkin', name: 'Leather Jerkin', body: 20, head: 0, legs: 9, weight: 3.4, tier: 1,
    style: 'leather', color: 0x61452c, trim: 0x3b2919,
  },
  hauberk: {
    id: 'hauberk', name: 'Mail Hauberk', body: 36, head: 0, legs: 16, weight: 6.4, tier: 2,
    style: 'mail', color: 0x797a76, trim: 0x4a4b48,
  },
  scale: {
    id: 'scale', name: 'Scale Coat', body: 44, head: 0, legs: 19, weight: 8.0, tier: 3,
    style: 'scale', color: 0x80785f, trim: 0x574f3a,
  },
  plate: {
    id: 'plate', name: 'Plate Harness', body: 55, head: 0, legs: 26, weight: 10.5, tier: 4,
    style: 'plate', color: 0xa9adb2, trim: 0x70747a,
  },
};

export const HELMETS: Record<string, HelmetDef> = {
  none: { id: 'none', name: 'Bare Head', style: 'none', armor: 0, color: 0x000000 },
  skullcap: { id: 'skullcap', name: 'Skullcap', style: 'skullcap', armor: 8, color: 0x7e8288 },
  nasal: { id: 'nasal', name: 'Nasal Helm', style: 'nasal', armor: 14, color: 0x8b8f95 },
  spangen: { id: 'spangen', name: 'Spangenhelm', style: 'spangen', armor: 20, color: 0x969aa0 },
  great: { id: 'great', name: 'Great Helm', style: 'great', armor: 30, color: 0xa4a8ad },
  barbute: { id: 'barbute', name: 'Barbute', style: 'barbute', armor: 26, color: 0x9aa0a5 },
};

/* ------------------------------------------------------------------ */
/* Combat tuning                                                       */
/* ------------------------------------------------------------------ */

export const COMBAT = {
  baseHp: 120,
  maxLevelBonusHp: 30,
  stamina: 100,
  staminaRegen: 16,
  staminaRegenDelay: 0.55,
  sprintDrain: 7,
  attackCost: 14,
  blockImpactExtra: 0.35,
  guardBreakStagger: 0.95,
  hitStagger: 0.34,
  heavyHitThreshold: 24,
  hitStopHit: 0.055,
  hitStopBlock: 0.085,
  hitStopKill: 0.11,
  friendlyFireMultiplier: 0.6,
  armorFactor: 0.009,
  minDamage: 2,
  speedBonusMax: 0.35,
  speedBonusMove: 0.055,
  speedBonusSwing: 0.11,
  zone: { head: 1.7, torso: 1.0, legs: 0.75 } as const,
  blockArc: (Math.PI * 130) / 180, // total arc considered frontal
  blockStaminaShield: 0.55,
  blockStaminaWeapon: 0.9,
  weaponBlockAbsorb: 0.8,
  kick: { range: 2.7, arc: (Math.PI * 55) / 180, stamina: 18, cooldown: 4.0, stagger: 0.75 },
  dodge: { distance: 2.5, duration: 0.26, iframes: 0.3, stamina: 20, cooldown: 1.05 },
  attack: {
    active: 0.105,
    hitWindowScale: 1.0,
    maxHits: 1,
  },
  movement: {
    walk: 3.9,
    sprint: 6.15,
    strafeFactor: 0.86,
    backFactor: 0.72,
    accel: 30,
    decel: 22,
    turnRate: 13,
    playerTurnRate: 18,
  },
  camera: {
    distance: 3.8,
    height: 1.72,
    lookHeight: 1.58,
    minDistance: 1.6,
    maxDistance: 5.2,
    fov: 62,
    sprintFov: 68,
    pitchMin: -0.95,
    pitchMax: 0.62,
  },
  lockOn: { range: 14, breakRange: 18, cone: (Math.PI * 70) / 180 },
  aiMaxActive: 7,
  melee: {
    totalOpponents: 35,
    activeMin: 5,
    activeMax: 8,
    spawnInterval: 1.6,
    outOfCombatRegen: 4,
    regenDelay: 8,
  },
  guardBreakThreshold: 0.02,
  headKnockoutFrac: 0.55,
};

export interface AttackTiming {
  windup: number;
  active: number;
  recover: number;
  total: number;
}

/** Authoritative attack timing. The rig and the hit resolver both use this. */
export function attackTiming(weapon: WeaponDef, speedMul = 1): AttackTiming {
  const speed = Math.max(0.5, weapon.speed * speedMul);
  const weight = Math.max(0.6, weapon.weight);
  const windup = (0.20 + 0.055 * weight) / speed;
  const active = COMBAT.attack.active * (weapon.twoHanded ? 1.05 : 1);
  const recover = (0.25 + 0.035 * weight) / speed;
  return { windup, active, recover, total: windup + active + recover };
}

export function attackStaminaCost(weapon: WeaponDef): number {
  return COMBAT.attackCost + weapon.weight * 1.6;
}

/* ------------------------------------------------------------------ */
/* Folder of loadouts by tournament tier                               */
/* ------------------------------------------------------------------ */

const TIER_WEAPONS: Record<number, string[]> = {
  1: ['arming_sword', 'short_sword', 'falchion', 'spear', 'quarterstaff'],
  2: ['arming_sword', 'falchion', 'war_axe', 'spear', 'mace'],
  3: ['arming_sword', 'war_axe', 'mace', 'greatsword', 'boar_spear'],
  4: ['greatsword', 'arming_sword', 'mace', 'boar_spear'],
};

const TIER_SHIELDS: Record<number, (string | null)[]> = {
  1: ['kite', 'heater', 'round', null],
  2: ['kite', 'heater', 'round', 'tower', null],
  3: ['kite', 'heater', 'tower', null],
  4: ['kite', 'heater'],
};

const TIER_ARMORS: Record<number, string[]> = {
  1: ['gambeson', 'jerkin'],
  2: ['jerkin', 'hauberk'],
  3: ['hauberk', 'scale'],
  4: ['plate', 'scale'],
};

const TIER_HELMETS: Record<number, string[]> = {
  1: ['none', 'skullcap', 'nasal'],
  2: ['nasal', 'spangen', 'skullcap'],
  3: ['spangen', 'great', 'nasal'],
  4: ['great', 'barbute', 'spangen'],
};

export interface LoadoutOptions {
  tier: number;
  color1: number;
  color2: number;
  title: string;
  /** Prefer a shield for the player. */
  preferShield?: boolean;
  rng: () => number;
}

export function makeLoadout(opts: LoadoutOptions): Loadout {
  const { tier, color1, color2, rng } = opts;
  const t = Math.max(1, Math.min(4, tier));
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];

  let weaponId = pick(TIER_WEAPONS[t]);
  let shieldId: string | null = pick(TIER_SHIELDS[t]);
  if (opts.preferShield) {
    if (!shieldId) shieldId = t >= 4 ? 'heater' : 'kite';
    if (WEAPONS[weaponId].twoHanded) {
      weaponId = 'arming_sword';
    }
  }
  if (WEAPONS[weaponId].twoHanded) shieldId = null;

  const weapon = WEAPONS[weaponId];
  const shield = shieldId ? { ...SHIELDS[shieldId], color: color1, color2 } : null;
  const armor = { ...ARMORS[pick(TIER_ARMORS[t])] };
  const helmet = { ...HELMETS[pick(TIER_HELMETS[t])] };

  return { weapon, shield, armor, helmet, color1, color2, title: opts.title };
}

/** Equipment awarded to the player at the start of a round (curated progression, always viable). */
export function playerLoadoutForRound(round: number, color1: number, color2: number, _rng: () => number): Loadout {
  const r = Math.max(0, Math.min(3, round));
  const title = TOURNAMENT.rounds[r].loadoutTitle;
  const shield = (id: keyof typeof SHIELDS): ShieldDef => ({ ...SHIELDS[id], color: color1, color2 });
  if (r === 0) {
    return { weapon: WEAPONS.arming_sword, shield: shield('kite'), armor: { ...ARMORS.jerkin }, helmet: { ...HELMETS.nasal }, color1, color2, title };
  }
  if (r === 1) {
    return { weapon: WEAPONS.falchion, shield: shield('heater'), armor: { ...ARMORS.hauberk }, helmet: { ...HELMETS.spangen }, color1, color2, title };
  }
  if (r === 2) {
    return { weapon: WEAPONS.arming_sword, shield: shield('kite'), armor: { ...ARMORS.scale }, helmet: { ...HELMETS.great }, color1, color2, title };
  }
  return { weapon: WEAPONS.arming_sword, shield: shield('heater'), armor: { ...ARMORS.plate }, helmet: { ...HELMETS.barbute }, color1, color2, title };
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export const AI_PROFILES: Record<string, AIProfile> = {
  recruit: {
    id: 'recruit', name: 'Regular Fighter', skill: 0.24, aggression: 0.46, defense: 0.24, reaction: 0.56,
    mobility: 0.92, footwork: 0.12, archetype: 'recruit', favorite: 'right',
  },
  fighter: {
    id: 'fighter', name: 'Arena Fighter', skill: 0.45, aggression: 0.62, defense: 0.45, reaction: 0.4,
    mobility: 1.0, footwork: 0.3, archetype: 'fighter', favorite: 'overhead',
  },
  veteran: {
    id: 'veteran', name: 'Veteran Gladiator', skill: 0.68, aggression: 0.7, defense: 0.68, reaction: 0.27,
    mobility: 1.04, footwork: 0.5, archetype: 'veteran', favorite: 'left',
  },
  champion: {
    id: 'champion', name: 'Champion of the Lists', skill: 0.88, aggression: 0.78, defense: 0.84, reaction: 0.16,
    mobility: 1.08, footwork: 0.75, archetype: 'champion', favorite: 'thrust',
  },
  brute: {
    id: 'brute', name: 'Arena Bruiser', skill: 0.5, aggression: 0.88, defense: 0.28, reaction: 0.38,
    mobility: 0.9, footwork: 0.18, archetype: 'brute', favorite: 'overhead',
  },
  duelist: {
    id: 'duelist', name: 'Sand Duelist', skill: 0.76, aggression: 0.56, defense: 0.78, reaction: 0.21,
    mobility: 1.1, footwork: 0.68, archetype: 'duelist', favorite: 'thrust',
  },
};

export const TOURNAMENT_AI_POOLS: string[][] = [
  ['recruit', 'recruit', 'recruit', 'fighter', 'fighter'],
  ['fighter', 'fighter', 'veteran', 'brute', 'veteran'],
  ['veteran', 'veteran', 'duelist', 'champion'],
  ['champion', 'duelist', 'veteran', 'champion'],
];

export const MELEE_AI_POOLS: { pool: string[]; share: number }[] = [
  { pool: ['recruit', 'recruit', 'recruit', 'fighter'], share: 0.45 },
  { pool: ['fighter', 'fighter', 'brute', 'veteran'], share: 0.38 },
  { pool: ['veteran', 'duelist', 'champion', 'brute'], share: 0.17 },
];

/* ------------------------------------------------------------------ */
/* Tournament                                                          */
/* ------------------------------------------------------------------ */

export interface TournamentRoundDef {
  index: number;
  name: string;
  objective: string;
  teams: number;
  teamSize: number;
  survivors: number;
  advanceTeams: number;
  purse: number;
  killXp: number;
  killDenars: number;
  loadoutTier: number;
  loadoutTitle: string;
}

export const TOURNAMENT = {
  contestants: 16,
  maxBet: 150,
  betPayout: 2,
  championRenown: 6,
  runnerUpRenown: 2,
  rounds: [
    {
      index: 0, name: 'The Grand Melee', objective: 'Be among the last two houses standing.',
      teams: 4, teamSize: 4, survivors: 8, advanceTeams: 2, purse: 60, killXp: 8, killDenars: 4,
      loadoutTier: 1, loadoutTitle: 'Padded Arms',
    },
    {
      index: 1, name: "The Knights' Pass", objective: 'Your house must be the only one left standing.',
      teams: 2, teamSize: 4, survivors: 4, advanceTeams: 1, purse: 120, killXp: 12, killDenars: 6,
      loadoutTier: 2, loadoutTitle: 'Mail & Blade',
    },
    {
      index: 2, name: "The Duellists' Round", objective: 'Pairs are drawn. Win your pairing; only your house survives.',
      teams: 2, teamSize: 2, survivors: 2, advanceTeams: 1, purse: 200, killXp: 18, killDenars: 10,
      loadoutTier: 3, loadoutTitle: 'Scale & Steel',
    },
    {
      index: 3, name: 'The Championship', objective: 'Only one champion leaves the sand.',
      teams: 2, teamSize: 1, survivors: 1, advanceTeams: 1, purse: 500, killXp: 30, killDenars: 20,
      loadoutTier: 4, loadoutTitle: 'Harness of the Champion',
    },
  ] as TournamentRoundDef[],
};

export const RANKS = [
  'Serf', 'Squire', 'Man-at-Arms', 'Sergeant', 'Veteran', 'Knight', 'Banneret', 'Champion',
  'Lord of the Lists', 'Legend of the Sand',
];

export function rankForLevel(level: number): string {
  return RANKS[Math.min(RANKS.length - 1, Math.max(0, level - 1))];
}

export function xpForLevel(level: number): number {
  return Math.round(110 * Math.pow(level, 1.35));
}

export function levelFromXp(xp: number): number {
  let level = 1;
  let remaining = xp;
  while (level < 99 && remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return level;
}

export function xpProgress(xp: number): { level: number; into: number; needed: number } {
  let level = 1;
  let remaining = xp;
  while (level < 99 && remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, into: remaining, needed: xpForLevel(level) };
}

export function maxHpForLevel(level: number): number {
  return COMBAT.baseHp + Math.min(COMBAT.maxLevelBonusHp, (level - 1) * 2);
}

export function damageScaleForLevel(level: number): number {
  return 1 + Math.min(0.25, (level - 1) * 0.008);
}

/* ------------------------------------------------------------------ */
/* Melee rewards                                                       */
/* ------------------------------------------------------------------ */

export function meleeReward(beaten: number, cleared: boolean): { denars: number; xp: number; renown: number } {
  let denars = 0;
  let xp = 0;
  if (beaten >= 3 && beaten <= 5) { denars = 5; xp = 5; }
  else if (beaten >= 6 && beaten <= 9) { denars = 10; xp = 10; }
  else if (beaten >= 10 && beaten <= 19) { denars = 25; xp = 10; }
  else if (beaten >= 20) { denars = 60; xp = 10; }
  if (cleared) { denars += 250; xp += 200; }
  const renown = cleared ? 2 : beaten >= 20 ? 1 : 0;
  return { denars, xp, renown };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export const FIRST_NAMES = [
  'Aldric', 'Bran', 'Cedric', 'Doran', 'Edmund', 'Falk', 'Gareth', 'Harald', 'Ivar', 'Jorund',
  'Kael', 'Leofric', 'Magnus', 'Niall', 'Osric', 'Perrin', 'Quillon', 'Ragnar', 'Sigurd', 'Torvald',
  'Ulric', 'Vane', 'Wulfric', 'Yorick', 'Aethel', 'Borin', 'Corin', 'Dain', 'Eirik', 'Fendrel',
  'Gunther', 'Hadrian', 'Ingmar', 'Jarek', 'Kendrick', 'Lothar', 'Merek', 'Nikolai', 'Odo', 'Roderic',
  'Soren', 'Thane', 'Varek', 'Wendel', 'Anselm', 'Bertram', 'Caspar', 'Dietrich', 'Emrick', 'Gerald',
];

export const EPITHETS = [
  'the Bold', 'of the Marches', 'Ironhand', 'the Quiet', 'Longsword', 'the Wolf', 'of Greyhollow',
  'the Unbroken', 'Shieldbreaker', 'the Patient', 'Oathkeeper', 'the Red', 'of the Vale', 'Ashborn',
  'the Steadfast', 'Duskblade', 'the Hammer', 'Wyrmguard', 'the Loyal', 'Sandwalker',
];

export const HOUSE_NAMES = [
  'Valdric', 'Corvane', 'Thornwood', 'Aurelian', 'Blackmere', 'Ravenshold', 'Eastwatch', 'Dunmoor',
  'Highmarch', 'Wyrmclaw', 'Ashenford', 'Greyhollow', 'Stormcrag', 'Whitekeep', 'Oldbarrow', 'Redfen',
];

/* ------------------------------------------------------------------ */
/* Fighter visual scale defaults                                       */
/* ------------------------------------------------------------------ */

export const CHARACTER_HEIGHT = 1.8;
export const ARENA_CENTER = { x: 0, z: 0 };

export const DEFAULT_GUARD_DIRS: GuardDir[] = ['left', 'right', 'overhead', 'thrust'];
export const DEFAULT_ATTACK_DIRS: AttackDir[] = ['left', 'right', 'overhead', 'thrust'];
