/**
 * Game tuning data: timing, vehicle specs, track layouts and art palettes.
 *
 * Everything that a designer would want to tweak lives here so the simulation
 * modules stay pure logic. Colours are 0..1 RGB triples (they are authored as
 * sRGB-ish values and converted by the renderer where it matters).
 */

import { hexToRgb } from '../core/math.js';

/* --------------------------------------------------------------- timing -- */

export const FIXED_STEP = 1 / 120;
export const MAX_SUBSTEPS = 8;
export const MAX_FRAME_DT = 0.1;

/* ---------------------------------------------------------------- track -- */

export const ROAD_WIDTH = 15;
export const SHOULDER_WIDTH = 2.5;
export const KERB_WIDTH = 1.4;
export const LAPS = 3;
export const OPPONENT_COUNT = 5;
export const GRID_SPACING = 9;
export const GRID_ROWS = 3;

export const NITRO = {
  capacity: 100,
  drainPerSecond: 42,
  regenPerSecond: 6,
  driftRegen: 24,
  minToFire: 10,
  thrust: 3400,
  topSpeedBonus: 1.18,
};

export const SURFACE_GRIP = {
  road: 1,
  kerb: 0.82,
  grass: 0.5,
};

export const CAR_SPECS = {
  vanko: {
    id: 'vanko',
    name: 'VANKO GT-R',
    blurb: 'All-wheel drive grip monster. Forgiving, planted, quick out of corners.',
    mass: 1420,
    power: 268, // kW at the wheels
    topSpeed: 281 / 3.6, // ~78.06 m/s
    grip: 1.06,
    steerLock: 0.56,
    brakePower: 15.5,
    aero: 0.65,
    drift: 0.5,
    drive: 'awd',
    kw: 268,
    topKph: 281,
    gearCount: 6,
    shiftTime: 0.16,
    stats: { speed: 7, accel: 8, grip: 9, brakes: 8 },
    palette: {
      paint: hexToRgb('#2fd6c8'),
      accent: hexToRgb('#0b2b30'),
      stripe: hexToRgb('#f2f7ff'),
      glass: hexToRgb('#0b141c'),
      rim: hexToRgb('#c9d3dd'),
      tyre: hexToRgb('#12151a'),
      headlight: hexToRgb('#e8f6ff'),
      taillight: hexToRgb('#ff2f4d'),
    },
  },
  rhino: {
    id: 'rhino',
    name: 'RHINO 440',
    blurb: 'Big-block muscle. Blistering top end, lazy front end, drinks nitrous.',
    mass: 1690,
    power: 312,
    topSpeed: 317 / 3.6, // ~88.06 m/s, 317 km/h
    grip: 0.9,
    steerLock: 0.5,
    brakePower: 13.2,
    aero: 0.78,
    drift: 0.72,
    drive: 'rwd',
    kw: 312,
    topKph: 317,
    gearCount: 5,
    shiftTime: 0.24,
    stats: { speed: 10, accel: 7, grip: 6, brakes: 6 },
    palette: {
      paint: hexToRgb('#ff8a2b'),
      accent: hexToRgb('#2a1206'),
      stripe: hexToRgb('#231510'),
      glass: hexToRgb('#0c1014'),
      rim: hexToRgb('#2c2f36'),
      tyre: hexToRgb('#101318'),
      headlight: hexToRgb('#fff1d0'),
      taillight: hexToRgb('#ff3b30'),
    },
  },
  kira: {
    id: 'kira',
    name: 'KIRA S1',
    blurb: 'Lightweight rear-drive drift build. Twitchy, fast hands, huge slide angle.',
    mass: 1180,
    power: 244,
    topSpeed: 288 / 3.6, // 288 km/h
    grip: 0.94,
    steerLock: 0.64,
    brakePower: 14.6,
    aero: 0.58,
    drift: 0.95,
    drive: 'rwd',
    kw: 244,
    topKph: 288,
    gearCount: 6,
    shiftTime: 0.14,
    stats: { speed: 8, accel: 9, grip: 8, brakes: 9 },
    palette: {
      paint: hexToRgb('#c04dff'),
      accent: hexToRgb('#1a0a26'),
      stripe: hexToRgb('#ffe066'),
      glass: hexToRgb('#0d0f16'),
      rim: hexToRgb('#ff4fa3'),
      tyre: hexToRgb('#0f1116'),
      headlight: hexToRgb('#f0e6ff'),
      taillight: hexToRgb('#ff2d7a'),
    },
  },
};

export const CAR_ORDER = ['vanko', 'rhino', 'kira'];

/* Rivals share the car models but get their own paint so the field is readable. */
export const OPPONENT_PALETTES = [
  hexToRgb('#e63c3c'),
  hexToRgb('#3c6fe6'),
  hexToRgb('#f5c542'),
  hexToRgb('#3ec46d'),
  hexToRgb('#c8c8d0'),
];

export const OPPONENT_NAMES = ['VEGA', 'NOVA', 'DIESEL', 'SPECTRE', 'BRICK'];

/** Skill 0..1 per opponent slot; folded into pace and corner confidence. */
export const OPPONENT_SKILLS = [0.92, 0.88, 0.84, 0.79, 0.74];

/** Handicaps applied to every AI driver so the player can win with a clean run. */
export const AI_TUNING = {
  pace: 0.9,
  cornering: 0.86,
  rubberBand: 0.12,
  laneChangeRate: 0.35,
  avoidRadius: 7.5,
};

/* -------------------------------------------------------------- palettes -- */

const NEON_BAY_PALETTE = {
  sky: {
    top: [0.015, 0.02, 0.055],
    horizon: [0.12, 0.07, 0.2],
    bottom: [0.02, 0.02, 0.035],
    sunGlow: 0.16,
    sunSize: 0.001,
    stars: 0.7,
  },
  sun: { direction: [-0.35, 0.5, 0.78], color: [0.5, 0.62, 1.0], intensity: 0.55 },
  ambient: { sky: [0.3, 0.34, 0.5], ground: [0.07, 0.08, 0.11], intensity: 1.15 },
  fog: { color: [0.035, 0.045, 0.085], near: 70, far: 620 },
  road: {
    asphalt: [0.1, 0.105, 0.125],
    asphaltAlt: [0.115, 0.12, 0.14],
    shoulder: [0.075, 0.08, 0.095],
    line: [0.82, 0.85, 0.9],
    kerbA: [0.72, 0.11, 0.14],
    kerbB: [0.86, 0.88, 0.9],
    paintEmissive: 0.06,
  },
  ground: [0.045, 0.05, 0.06],
  groundAlt: [0.06, 0.065, 0.075],
  props: {
    buildingBase: [0.085, 0.095, 0.135],
    buildingAlt: [0.11, 0.12, 0.17],
    window: [0.55, 0.75, 1.0],
    windowWarm: [1.0, 0.78, 0.42],
    neonA: [0.15, 0.95, 1.0],
    neonB: [1.0, 0.2, 0.7],
    neonC: [1.0, 0.85, 0.25],
    barrier: [0.19, 0.2, 0.25],
    rail: [0.5, 0.55, 0.62],
    plantA: [0.14, 0.22, 0.17],
    plantB: [0.1, 0.16, 0.13],
    rockA: [0.09, 0.095, 0.11],
    rockB: [0.07, 0.075, 0.09],
    pillar: [0.14, 0.15, 0.18],
  },
  lamps: { color: [1.0, 0.72, 0.38], height: 8.5, spacing: 42, intensity: 1 },
  glow: { headlight: [1.0, 0.96, 0.86], taillight: [1.0, 0.18, 0.25], nitro: [0.35, 0.75, 1.0] },
  shadow: [0.01, 0.01, 0.02],
  minimap: { road: '#7c8ba6', line: '#9fe8ff', player: '#2fd6c8' },
};

const SUNSET_CANYON_PALETTE = {
  sky: {
    top: [0.11, 0.09, 0.24],
    horizon: [0.95, 0.42, 0.24],
    bottom: [0.24, 0.12, 0.16],
    sunGlow: 0.85,
    sunSize: 0.03,
    stars: 0.05,
  },
  sun: { direction: [-0.7, 0.16, 0.7], color: [1.0, 0.6, 0.34], intensity: 1.05 },
  ambient: { sky: [0.42, 0.34, 0.44], ground: [0.22, 0.14, 0.12], intensity: 1.0 },
  fog: { color: [0.34, 0.2, 0.24], near: 90, far: 900 },
  road: {
    asphalt: [0.16, 0.145, 0.15],
    asphaltAlt: [0.18, 0.16, 0.165],
    shoulder: [0.26, 0.2, 0.16],
    line: [0.92, 0.88, 0.72],
    kerbA: [0.72, 0.2, 0.16],
    kerbB: [0.9, 0.86, 0.8],
    paintEmissive: 0.02,
  },
  ground: [0.36, 0.24, 0.17],
  groundAlt: [0.42, 0.28, 0.19],
  props: {
    buildingBase: [0.4, 0.26, 0.19],
    buildingAlt: [0.5, 0.32, 0.22],
    window: [1.0, 0.82, 0.5],
    windowWarm: [1.0, 0.65, 0.3],
    neonA: [1.0, 0.55, 0.25],
    neonB: [0.95, 0.3, 0.35],
    neonC: [1.0, 0.85, 0.4],
    barrier: [0.55, 0.5, 0.44],
    rail: [0.72, 0.68, 0.6],
    plantA: [0.2, 0.26, 0.14],
    plantB: [0.16, 0.22, 0.12],
    rockA: [0.52, 0.34, 0.24],
    rockB: [0.46, 0.29, 0.21],
    pillar: [0.58, 0.42, 0.3],
  },
  lamps: { color: [1.0, 0.85, 0.55], height: 8, spacing: 58, intensity: 0.8 },
  glow: { headlight: [1.0, 0.95, 0.8], taillight: [1.0, 0.25, 0.2], nitro: [0.3, 0.7, 1.0] },
  shadow: [0.06, 0.03, 0.02],
  minimap: { road: '#d8b48a', line: '#ffd9a0', player: '#ff8a2b' },
};

export const TRACK_DEFS = {
  'neon-bay': {
    id: 'neon-bay',
    name: 'NEON BAY',
    subtitle: 'Downtown loop · 1.75 km · night',
    blurb:
      'Wide boulevards, glass towers and hard kerbs. Late-braking into turn one is the only real overtaking spot.',
    width: ROAD_WIDTH,
    shoulderWidth: SHOULDER_WIDTH,
    kerbWidth: KERB_WIDTH,
    theme: 'city',
    seed: 0x1f3a,
    skyline: 1,
    lampSpacing: 44,
    palette: NEON_BAY_PALETTE,
    points: [
      { x: -110, y: 0.0, z: -152 },
      { x: -60, y: 0.2, z: -150 },
      { x: -20, y: 0.5, z: -166 },
      { x: 20, y: 0.7, z: -134 },
      { x: 60, y: 0.8, z: -150 },
      { x: 150, y: 1.0, z: -152 },
      { x: 240, y: 1.4, z: -140 },
      { x: 310, y: 1.8, z: -90 },
      { x: 345, y: 2.0, z: -10 },
      { x: 345, y: 2.2, z: 90 },
      { x: 320, y: 2.4, z: 175 },
      { x: 265, y: 2.6, z: 235 },
      { x: 180, y: 2.6, z: 268 },
      { x: 80, y: 2.4, z: 272 },
      { x: -30, y: 2.2, z: 268 },
      { x: -140, y: 1.8, z: 245 },
      { x: -215, y: 1.4, z: 190 },
      { x: -238, y: 1.0, z: 105 },
      { x: -238, y: 0.6, z: 20 },
      { x: -228, y: 0.3, z: -70 },
      { x: -205, y: 0.1, z: -120 },
      { x: -160, y: 0.0, z: -145 },
    ],
  },
  'sunset-canyon': {
    id: 'sunset-canyon',
    name: 'SUNSET CANYON',
    subtitle: 'Canyon run · 1.88 km · dusk',
    blurb:
      'Long climbs, blind crests and a 180-degree hairpin over the ridge. Respect the outside line or eat the rock.',
    width: ROAD_WIDTH + 1.5,
    shoulderWidth: SHOULDER_WIDTH + 1.5,
    kerbWidth: KERB_WIDTH,
    theme: 'canyon',
    seed: 0x7c11,
    skyline: 0.35,
    lampSpacing: 62,
    palette: SUNSET_CANYON_PALETTE,
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 12, y: 1.5, z: 120 },
      { x: -8, y: 5, z: 240 },
      { x: 4, y: 9.5, z: 360 },
      { x: 0, y: 14, z: 470 },
      { x: 26, y: 18.5, z: 570 },
      { x: 96, y: 22, z: 645 },
      { x: 186, y: 24, z: 668 },
      { x: 268, y: 23, z: 628 },
      { x: 306, y: 20.5, z: 540 },
      { x: 306, y: 17, z: 448 },
      { x: 300, y: 13.5, z: 340 },
      { x: 306, y: 9.5, z: 230 },
      { x: 300, y: 5.5, z: 120 },
      { x: 296, y: 2.5, z: 26 },
      { x: 266, y: 0.5, z: -52 },
      { x: 196, y: 0, z: -92 },
      { x: 110, y: 0, z: -84 },
      { x: 42, y: 0, z: -32 },
    ],
  },
};

export const TRACK_ORDER = ['neon-bay', 'sunset-canyon'];

/** Camera tuning shared by every track; `speedPull` widens FOV with velocity. */
export const CAMERA = {
  distance: 8.4,
  height: 3.1,
  lookAhead: 6.5,
  stiffness: 9.5,
  pitch: -0.055,
  fovBase: 0.95,
  fovSpeed: 0.22,
  fovBoost: 0.16,
  shake: 0.35,
  near: 0.3,
  far: 1600,
  drift: 0.55,
};

/** Rendering tiers; the renderer picks draw distance and extras from these. */
export const QUALITY = {
  low: { drawDistance: 420, glows: 0, shadows: false, dpr: 0.75, skyDetail: 0 },
  medium: { drawDistance: 650, glows: 0.7, shadows: true, dpr: 1, skyDetail: 1 },
  high: { drawDistance: 1000, glows: 1, shadows: true, dpr: 1.5, skyDetail: 2 },
};

export const STORAGE_KEY = 'apex-drift.records';

/** Compute the grid slot transform for a car index (used at race start). */
export function gridSlotTransform(index) {
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  return {
    back: 6 + row * GRID_SPACING,
    lateral: side * (ROAD_WIDTH * 0.18),
  };
}
