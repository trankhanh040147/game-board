import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TUNING,
  CAMERA,
  CAR_ORDER,
  CAR_SPECS,
  FIXED_STEP,
  GRID_ROWS,
  GRID_SPACING,
  KERB_WIDTH,
  LAPS,
  MAX_FRAME_DT,
  MAX_SUBSTEPS,
  NITRO,
  OPPONENT_COUNT,
  OPPONENT_NAMES,
  OPPONENT_PALETTES,
  OPPONENT_SKILLS,
  QUALITY,
  ROAD_WIDTH,
  SHOULDER_WIDTH,
  STORAGE_KEY,
  SURFACE_GRIP,
  TRACK_DEFS,
  TRACK_ORDER,
  gridSlotTransform,
} from '../src/sim/config.js';

const CAR_FIELDS = [
  'id',
  'name',
  'blurb',
  'mass',
  'power',
  'topSpeed',
  'grip',
  'steerLock',
  'brakePower',
  'aero',
  'drift',
  'drive',
  'stats',
  'palette',
];

function assertColor(color, label) {
  assert.ok(Array.isArray(color) && color.length === 3, `${label}: expected an [r,g,b] array, got ${JSON.stringify(color)}`);
  for (const channel of color) {
    assert.ok(Number.isFinite(channel), `${label}: non-finite channel ${channel}`);
    assert.ok(channel >= 0 && channel <= 1, `${label}: channel ${channel} outside 0..1`);
  }
}

test('timing and field constants match the contract', () => {
  assert.equal(FIXED_STEP, 1 / 120, 'FIXED_STEP should be 1/120 s');
  assert.equal(MAX_SUBSTEPS, 8, 'MAX_SUBSTEPS should be 8');
  assert.equal(MAX_FRAME_DT, 0.1, 'MAX_FRAME_DT should be 0.1 s');
  assert.equal(LAPS, 3, 'races are 3 laps');
  assert.equal(OPPONENT_COUNT, 5, 'five rivals per race');
  assert.ok(ROAD_WIDTH >= 10 && ROAD_WIDTH <= 24, `ROAD_WIDTH ${ROAD_WIDTH} should be a sane multi-lane width`);
  assert.ok(SHOULDER_WIDTH > 0, 'SHOULDER_WIDTH must be positive');
  assert.ok(KERB_WIDTH > 0, 'KERB_WIDTH must be positive');
  assert.ok(typeof STORAGE_KEY === 'string' && STORAGE_KEY.length > 0, 'STORAGE_KEY must be a non-empty string');
  assert.equal(GRID_ROWS * 2 >= OPPONENT_COUNT + 1, true, 'GRID_ROWS/GRID_SPACING should fit the whole field');
  assert.ok(GRID_SPACING > 4, `GRID_SPACING ${GRID_SPACING} must leave room between rows`);
});

test('there are exactly three cars, in CAR_ORDER, with every documented field', () => {
  assert.equal(CAR_ORDER.length, 3, `expected 3 cars, got ${CAR_ORDER.length}`);
  assert.deepEqual(Object.keys(CAR_SPECS).sort(), [...CAR_ORDER].sort(), 'CAR_ORDER must match CAR_SPECS keys');

  for (const id of CAR_ORDER) {
    const spec = CAR_SPECS[id];
    assert.ok(spec, `CAR_SPECS.${id} missing`);
    assert.equal(spec.id, id, `CAR_SPECS.${id}.id must match its key`);
    for (const field of CAR_FIELDS) {
      assert.ok(spec[field] !== undefined && spec[field] !== null, `CAR_SPECS.${id} is missing required field '${field}'`);
    }
    // docs/CONTRACT.md documents these derived display fields on every CarSpec.
    assert.ok(
      Number.isFinite(spec.topKph),
      `CAR_SPECS.${id} must expose topKph (km/h) per docs/CONTRACT.md, got ${spec.topKph}`,
    );
    assert.ok(
      Number.isFinite(spec.kw),
      `CAR_SPECS.${id} must expose kw (power) per docs/CONTRACT.md, got ${spec.kw}`,
    );
    assert.ok(
      Math.abs(spec.topSpeed - spec.topKph / 3.6) < 0.05,
      `CAR_SPECS.${id}: topSpeed ${spec.topSpeed} m/s should be topKph ${spec.topKph}/3.6 = ${(spec.topKph / 3.6).toFixed(3)}`,
    );
    assert.ok(
      Math.abs(spec.kw - spec.power) < 1 || Math.abs(spec.kw - spec.power * 0.7355) < 1,
      `CAR_SPECS.${id}: kw ${spec.kw} should agree with power ${spec.power} (metric or mechanical)`,
    );
    assert.ok(typeof spec.name === 'string' && spec.name.length > 0, `CAR_SPECS.${id}.name must be a non-empty string`);
    assert.ok(typeof spec.blurb === 'string' && spec.blurb.length > 10, `CAR_SPECS.${id}.blurb should describe the car`);
    assert.ok(['rwd', 'awd'].includes(spec.drive), `CAR_SPECS.${id}.drive must be 'rwd' or 'awd', got ${spec.drive}`);
    assert.ok(spec.mass > 700 && spec.mass < 2200, `CAR_SPECS.${id}.mass ${spec.mass} kg out of range`);
    assert.ok(spec.power > 80 && spec.power < 800, `CAR_SPECS.${id}.power ${spec.power} out of range`);
    assert.ok(spec.topSpeed > 50 && spec.topSpeed < 120, `CAR_SPECS.${id}.topSpeed ${spec.topSpeed} m/s out of range`);
    assert.ok(spec.grip > 0.5 && spec.grip < 1.5, `CAR_SPECS.${id}.grip ${spec.grip} out of range`);
    assert.ok(spec.steerLock > 0.3 && spec.steerLock < 0.9, `CAR_SPECS.${id}.steerLock ${spec.steerLock} rad out of range`);
    assert.ok(spec.brakePower > 5 && spec.brakePower < 30, `CAR_SPECS.${id}.brakePower ${spec.brakePower} out of range`);
    assert.ok(spec.aero >= 0 && spec.aero < 2, `CAR_SPECS.${id}.aero ${spec.aero} out of range`);
    assert.ok(spec.drift >= 0 && spec.drift <= 1, `CAR_SPECS.${id}.drift ${spec.drift} outside 0..1`);

    for (const stat of ['speed', 'accel', 'grip', 'brakes']) {
      const value = spec.stats[stat];
      assert.ok(Number.isFinite(value) && value >= 1 && value <= 10, `CAR_SPECS.${id}.stats.${stat} should be 1..10, got ${value}`);
    }

    for (const key of ['paint', 'accent', 'stripe', 'glass', 'rim', 'tyre', 'headlight', 'taillight']) {
      assertColor(spec.palette[key], `CAR_SPECS.${id}.palette.${key}`);
    }
  }
});

test('the three cars have distinct handling identities', () => {
  const stats = CAR_ORDER.map((id) => JSON.stringify(CAR_SPECS[id].stats));
  assert.equal(new Set(stats).size, 3, `every car needs a distinct stats row, got ${stats.join(' / ')}`);

  const speed = CAR_ORDER.map((id) => CAR_SPECS[id].topSpeed);
  assert.equal(new Set(speed).size, 3, `cars should not share a top speed: ${speed.join(', ')}`);

  const mass = CAR_ORDER.map((id) => CAR_SPECS[id].mass);
  assert.equal(new Set(mass).size, 3, `cars should not share a mass: ${mass.join(', ')}`);

  const drives = CAR_ORDER.map((id) => CAR_SPECS[id].drive);
  assert.ok(drives.includes('awd'), 'at least one car should be all-wheel drive');
  assert.ok(drives.includes('rwd'), 'at least one car should be rear-wheel drive');

  const paints = CAR_ORDER.map((id) => CAR_SPECS[id].palette.paint.join(','));
  assert.equal(new Set(paints).size, 3, 'each car needs its own paint colour');
});

test('there are two tracks, each with at least 18 control points', () => {
  assert.equal(TRACK_ORDER.length, 2, `expected 2 tracks, got ${TRACK_ORDER.length}`);
  assert.deepEqual(Object.keys(TRACK_DEFS).sort(), [...TRACK_ORDER].sort(), 'TRACK_ORDER must match TRACK_DEFS keys');

  for (const id of TRACK_ORDER) {
    const def = TRACK_DEFS[id];
    assert.equal(def.id, id, `TRACK_DEFS.${id}.id must match its key`);
    assert.ok(typeof def.name === 'string' && def.name.length > 0, `TRACK_DEFS.${id}.name`);
    assert.ok(typeof def.subtitle === 'string' && def.subtitle.length > 0, `TRACK_DEFS.${id}.subtitle`);
    assert.ok(typeof def.blurb === 'string' && def.blurb.length > 20, `TRACK_DEFS.${id}.blurb`);
    assert.ok(def.width >= 10, `TRACK_DEFS.${id}.width ${def.width} too narrow`);
    assert.ok(def.width <= 30, `TRACK_DEFS.${id}.width ${def.width} too wide`);
    assert.ok(def.points.length >= 18, `TRACK_DEFS.${id} needs >= 18 control points, got ${def.points.length}`);
    for (const [index, point] of def.points.entries()) {
      for (const axis of ['x', 'y', 'z']) {
        assert.ok(Number.isFinite(point[axis]), `TRACK_DEFS.${id}.points[${index}].${axis} is not finite`);
      }
      assert.ok(
        Math.abs(point.y) < 60,
        `TRACK_DEFS.${id}.points[${index}].y ${point.y} m is implausibly high`,
      );
    }
    assert.ok(def.theme === 'city' || def.theme === 'canyon', `TRACK_DEFS.${id}.theme must be 'city' or 'canyon'`);
    assert.ok(Number.isInteger(def.seed), `TRACK_DEFS.${id}.seed must be an integer seed`);
    assert.ok(def.palette, `TRACK_DEFS.${id}.palette missing`);
  }
});

test('track palettes provide every colour and light the renderer reads', () => {
  for (const id of TRACK_ORDER) {
    const palette = TRACK_DEFS[id].palette;
    for (const key of ['top', 'horizon', 'bottom']) assertColor(palette.sky[key], `${id}.sky.${key}`);
    assert.ok(Number.isFinite(palette.sky.sunGlow), `${id}.sky.sunGlow`);
    assert.ok(Number.isFinite(palette.sky.sunSize), `${id}.sky.sunSize`);
    assert.ok(Number.isFinite(palette.sky.stars), `${id}.sky.stars`);

    assert.ok(
      Array.isArray(palette.sun.direction) && palette.sun.direction.length === 3,
      `${id}.sun.direction must be a direction vector`,
    );
    for (const component of palette.sun.direction) {
      assert.ok(Number.isFinite(component) && component >= -1 && component <= 1, `${id}.sun.direction component ${component} out of range`);
    }
    assertColor(palette.sun.color, `${id}.sun.color`);
    assert.ok(Number.isFinite(palette.sun.intensity) && palette.sun.intensity > 0, `${id}.sun.intensity`);
    const sunLength = Math.hypot(...palette.sun.direction);
    assert.ok(Math.abs(sunLength - 1) < 0.1, `${id}.sun.direction should be roughly unit length, got ${sunLength}`);

    assertColor(palette.ambient.sky, `${id}.ambient.sky`);
    assertColor(palette.ambient.ground, `${id}.ambient.ground`);
    assert.ok(Number.isFinite(palette.ambient.intensity), `${id}.ambient.intensity`);

    assertColor(palette.fog.color, `${id}.fog.color`);
    assert.ok(palette.fog.near > 0 && palette.fog.far > palette.fog.near, `${id}.fog distances`);

    for (const key of ['asphalt', 'asphaltAlt', 'shoulder', 'line', 'kerbA', 'kerbB']) {
      assertColor(palette.road[key], `${id}.road.${key}`);
    }
    assert.ok(Number.isFinite(palette.road.paintEmissive), `${id}.road.paintEmissive`);

    assertColor(palette.ground, `${id}.ground`);
    assertColor(palette.groundAlt, `${id}.groundAlt`);
    assertColor(palette.shadow, `${id}.shadow`);

    for (const key of [
      'buildingBase', 'buildingAlt', 'window', 'windowWarm', 'neonA', 'neonB', 'neonC',
      'barrier', 'rail', 'plantA', 'plantB', 'rockA', 'rockB', 'pillar',
    ]) {
      assertColor(palette.props[key], `${id}.props.${key}`);
    }

    assertColor(palette.lamps.color, `${id}.lamps.color`);
    assert.ok(palette.lamps.height > 0, `${id}.lamps.height`);
    assert.ok(palette.lamps.spacing > 0, `${id}.lamps.spacing`);
    assert.ok(Number.isFinite(palette.lamps.intensity), `${id}.lamps.intensity`);

    for (const key of ['headlight', 'taillight', 'nitro']) assertColor(palette.glow[key], `${id}.glow.${key}`);
    for (const key of ['road', 'line', 'player']) {
      assert.ok(
        typeof palette.minimap[key] === 'string' && palette.minimap[key].startsWith('#'),
        `${id}.minimap.${key} should be a CSS colour, got ${palette.minimap[key]}`,
      );
    }
  }
});

test('opponent configuration covers the full five-car field', () => {
  assert.ok(OPPONENT_PALETTES.length >= OPPONENT_COUNT, `need >= ${OPPONENT_COUNT} opponent palettes, got ${OPPONENT_PALETTES.length}`);
  assert.ok(OPPONENT_NAMES.length >= OPPONENT_COUNT, `need >= ${OPPONENT_COUNT} opponent names, got ${OPPONENT_NAMES.length}`);
  assert.ok(OPPONENT_SKILLS.length >= OPPONENT_COUNT, `need >= ${OPPONENT_COUNT} opponent skills, got ${OPPONENT_SKILLS.length}`);
  for (const palette of OPPONENT_PALETTES) assertColor(palette, 'opponent palette');
  for (const skill of OPPONENT_SKILLS) {
    assert.ok(Number.isFinite(skill) && skill >= 0 && skill <= 1, `opponent skill ${skill} outside 0..1`);
  }
  assert.equal(new Set(OPPONENT_NAMES.slice(0, OPPONENT_COUNT)).size, OPPONENT_COUNT, 'opponent names must be unique');

  assert.ok(AI_TUNING.pace > 0 && AI_TUNING.pace <= 1, `AI_TUNING.pace ${AI_TUNING.pace}`);
  assert.ok(AI_TUNING.cornering > 0, `AI_TUNING.cornering ${AI_TUNING.cornering}`);
  assert.ok(AI_TUNING.rubberBand >= 0, `AI_TUNING.rubberBand ${AI_TUNING.rubberBand}`);
});

test('nitro and surface grip tuning values are sane', () => {
  assert.equal(NITRO.capacity, 100, 'NITRO.capacity should be 100');
  assert.ok(NITRO.drainPerSecond > 0, 'nitro must drain while boosting');
  assert.ok(NITRO.regenPerSecond > 0, 'nitro must slowly regenerate');
  assert.ok(
    NITRO.driftRegen > NITRO.regenPerSecond,
    `drifting should recharge faster (${NITRO.driftRegen}) than idle regen (${NITRO.regenPerSecond})`,
  );
  assert.ok(NITRO.minToFire > 0 && NITRO.minToFire < NITRO.capacity, 'NITRO.minToFire must be inside 0..capacity');
  assert.ok(NITRO.drainPerSecond > NITRO.regenPerSecond, 'nitro cannot be self-sustaining');
  assert.ok(NITRO.topSpeedBonus >= 1, 'nitro must not slow the car down');

  assert.equal(SURFACE_GRIP.road, 1, 'road is the 1.0 grip reference surface');
  assert.ok(SURFACE_GRIP.kerb > SURFACE_GRIP.grass, 'kerb must have more grip than grass');
  assert.ok(SURFACE_GRIP.grass > 0, 'grass must still have some grip');
  for (const [surface, grip] of Object.entries(SURFACE_GRIP)) {
    assert.ok(Number.isFinite(grip) && grip > 0 && grip <= 1.2, `SURFACE_GRIP.${surface} ${grip} out of range`);
  }
});

test('quality tiers are ordered and complete', () => {
  assert.deepEqual(Object.keys(QUALITY).sort(), ['high', 'low', 'medium'], 'QUALITY must expose low/medium/high');
  assert.ok(
    QUALITY.low.drawDistance < QUALITY.medium.drawDistance
      && QUALITY.medium.drawDistance < QUALITY.high.drawDistance,
    `draw distance must increase with quality: ${QUALITY.low.drawDistance}/${QUALITY.medium.drawDistance}/${QUALITY.high.drawDistance}`,
  );
  assert.ok(QUALITY.low.dpr <= QUALITY.medium.dpr && QUALITY.medium.dpr <= QUALITY.high.dpr, 'render scale must increase with quality');
  assert.ok(QUALITY.low.glows <= QUALITY.medium.glows && QUALITY.medium.glows <= QUALITY.high.glows, 'glow budget must increase with quality');
  for (const [tier, config] of Object.entries(QUALITY)) {
    assert.ok(typeof config.shadows === 'boolean', `${tier}.shadows must be boolean`);
    assert.ok(Number.isFinite(config.skyDetail), `${tier}.skyDetail must be numeric`);
    assert.ok(config.dpr > 0, `${tier}.dpr must be positive`);
  }
});

test('camera tuning is safe for a near plane', () => {
  assert.ok(CAMERA.near > 0.05 && CAMERA.near < 2, `CAMERA.near ${CAMERA.near} out of range`);
  assert.ok(CAMERA.far > CAMERA.near, 'CAMERA.far must be beyond CAMERA.near');
  assert.ok(CAMERA.distance > 2, 'chase camera distance should be behind the car');
  assert.ok(CAMERA.fovBase > 0.5 && CAMERA.fovBase < 1.5, 'base FOV should be in radians');
});

test('gridSlotTransform yields a widening, alternating grid', () => {
  const slots = [];
  for (let i = 0; i < OPPONENT_COUNT + 1; i += 1) slots.push(gridSlotTransform(i));
  for (let i = 0; i < slots.length; i += 1) {
    assert.ok(slots[i].back > 0, `grid slot ${i} should be behind the line`);
    assert.ok(Math.abs(slots[i].lateral) < ROAD_WIDTH / 2, `grid slot ${i} lateral ${slots[i].lateral} outside the road`);
  }
  assert.ok(slots[0].lateral < 0 && slots[1].lateral > 0, 'odd/even grid slots should alternate sides');
  assert.ok(slots[2].back > slots[0].back, 'later rows should be further back');
});
