/**
 * Disasters system — the world pushing back.
 *
 * Every disaster is FAIR: it telegraphs through ctx.notify + world/state flags at least one
 * to two days ahead, its cause is visible in world.weather / world.climate / tile state, it
 * respects the `disasterResist` modifier (mitigation), and it never deletes citizens — it
 * damages buildings/stock/soil and lets the society + population systems handle health.
 * The opening weeks are protected: no destructive event before day 25.
 *
 * Disasters: wildfire, flood, blight, locusts, earthquake. Headline events are spaced by a
 * global cooldown so the game never stacks crises.
 */
import type { SimSystem, Tile } from '../../types';
import { addFlag, capitalOf, clamp, getFlag, modOf, removeStock, setFlag } from '../../core';
import { heatPressure } from '../../world/climate';
import { isWaterTile } from '../../world/terrain';

const OPENING_PROTECTION_DAYS = 25;

export const disastersSystem: SimSystem = (ctx) => {
  const s = ctx.s;
  const c = ctx.c;
  const w = s.world;
  const weather = w.weather;
  const climate = w.climate;
  const tick = ctx.tick;
  const cap = capitalOf(s);
  if (!cap) return;
  const rng = ctx.rng;

  const difficulty = s.difficulty === 'harsh' ? 1.35 : s.difficulty === 'gentle' ? 0.65 : 1;
  const resist = clamp(modOf(ctx, cap.id, 'disasterResist') + modOf(ctx, -1, 'disasterResist'), -0.6, 1.6);
  const protectedOpening = tick < OPENING_PROTECTION_DAYS;
  const lastMajor = getFlag(s, 'disaster.lastMajorTick');
  const canMajor = tick - lastMajor >= 10;

  // ---------------------------------------------------------------------
  // Wildfire — dry + hot + windy + forest near the hearth, warned 2 days out.
  // ---------------------------------------------------------------------
  const fireRisk = clamp(
    weather.drought * 0.5 +
      (1 - weather.soilMoisture) * 0.2 +
      heatPressure(weather.temperature) * 0.22 +
      weather.wind * 0.08,
    0,
    1,
  ) * (1 - resist * 0.45);
  const firePending = getFlag(s, 'disaster.fire.pendingTick');
  const lastFire = getFlag(s, 'disaster.fire.last');
  if (
    tick > 45 &&
    fireRisk > 0.33 &&
    firePending === 0 &&
    tick - lastFire > 30 &&
    canMajor &&
    rng() < 0.42 * difficulty
  ) {
    setFlag(s, 'disaster.fire.pendingTick', tick + 2);
    ctx.notify(
      'The woods are tinder: leaf litter bone-dry, wind from the ridge. A careless spark could take the whole hillside.',
      'warn',
      'fire',
    );
    setFlag(s, 'disaster.fire.warnTick', tick);
  } else if (firePending > 0 && tick >= firePending) {
    setFlag(s, 'disaster.fire.pendingTick', 0);
    if (fireRisk > 0.28) {
      igniteWildfire(ctx, cap.x, cap.y, clamp(fireRisk, 0.25, 1), resist);
      setFlag(s, 'disaster.fire.last', tick);
      setFlag(s, 'disaster.lastMajorTick', tick);
    } else {
      ctx.notify('The wind turned and damp air came up from the river. The fire danger has passed.', 'good', 'cloud');
    }
  }

  // ---------------------------------------------------------------------
  // Flood — storm surge + low river ground, warned one day ahead.
  // ---------------------------------------------------------------------
  const floodRisk = clamp(
    weather.storm * 0.6 + weather.rainfall * 0.3 + (weather.season === 'autumn' ? 0.08 : 0),
    0,
    1,
  ) * (1 - resist * 0.4);
  const floodPending = getFlag(s, 'disaster.flood.pendingTick');
  const lastFlood = getFlag(s, 'disaster.flood.last');
  if (
    !protectedOpening &&
    floodRisk > 0.55 &&
    floodPending === 0 &&
    tick - lastFlood > 46 &&
    canMajor &&
    rng() < 0.105 * difficulty
  ) {
    setFlag(s, 'disaster.flood.pendingTick', tick + 1);
    ctx.notify(
      'The river is rising fast. Low ground and anything built near the water should be emptied tonight.',
      'warn',
      'water',
    );
  } else if (floodPending > 0 && tick >= floodPending) {
    setFlag(s, 'disaster.flood.pendingTick', 0);
    if (weather.storm > 0.35 || weather.rainfall > 0.35) {
      floodHearth(ctx, resist);
      setFlag(s, 'disaster.flood.last', tick);
      setFlag(s, 'disaster.lastMajorTick', tick);
    } else {
      ctx.notify('The water crested below the banks. The valley is safe.', 'good', 'droplet');
    }
  }

  // ---------------------------------------------------------------------
  // Blight — dense monoculture + humid warmth + low biodiversity.
  // ---------------------------------------------------------------------
  const farms = countFarmBuildings(s, c);
  const lastBlight = getFlag(s, 'disaster.blight.last');
  if (
    !protectedOpening &&
    tick - lastBlight > 34 &&
    farms >= 4 &&
    weather.soilMoisture > 0.55 &&
    weather.temperature > 12 &&
    weather.temperature < 32 &&
    canMajor
  ) {
    const risk = (0.05 + farms * 0.006 + (1 - climate.biodiversity) * 0.24) * difficulty;
    if (rng() < risk) {
      const dropped = blightFarms(ctx, cap.x, cap.y, resist);
      if (dropped) {
        setFlag(s, 'disaster.blight.last', tick);
        setFlag(s, 'disaster.blight.until', tick + 6);
        setFlag(s, 'disaster.lastMajorTick', tick);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Locusts — summer, plenty of fields, poor biodiversity.
  // ---------------------------------------------------------------------
  const lastLocusts = getFlag(s, 'disaster.locusts.last');
  if (
    !protectedOpening &&
    weather.season === 'summer' &&
    tick - lastLocusts > 40 &&
    farms >= 3 &&
    climate.biodiversity < 0.62 &&
    canMajor
  ) {
    if (rng() < 0.06 * difficulty) {
      locustSwarm(ctx, resist);
      setFlag(s, 'disaster.locusts.last', tick);
      setFlag(s, 'disaster.locusts.until', tick + 5);
      setFlag(s, 'disaster.lastMajorTick', tick);
    }
  }

  // ---------------------------------------------------------------------
  // Earthquake — rare, everywhere, no forecast possible (but not lethal).
  // ---------------------------------------------------------------------
  if (tick > 46 && rng() < 0.0005 * difficulty) {
    earthquake(ctx, resist);
    setFlag(s, 'disaster.quake.last', tick);
    setFlag(s, 'disaster.lastMajorTick', tick);
  }
};

// ---------------------------------------------------------------------------
// Disaster implementations
// ---------------------------------------------------------------------------

function record(ctx: Parameters<SimSystem>[0], kind: string): void {
  const s = ctx.s;
  addFlag(s, 'disaster.total', 1);
  addFlag(s, `disaster.${kind}.count`, 1);
  s.stats.disasters += 1;
}

function settleCap(ctx: Parameters<SimSystem>[0]) {
  return capitalOf(ctx.s);
}

/** Best burnable tile near a point: mature forest, dry, close enough to matter. */
function findBurnTile(
  ctx: Parameters<SimSystem>[0],
  cx: number,
  cy: number,
): number {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  let best = -1;
  let bestScore = -Infinity;
  for (let dy = -10; dy <= 10; dy++) {
    for (let dx = -10; dx <= 10; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      const idx = y * w.width + x;
      const t = w.tiles[idx];
      if (!t) continue;
      const b = c.biomes[t.biome];
      if (!b || isWaterTile(c, t) || b.walkCost >= 8) continue;
      if (t.forest < 0.3) continue;
      const d = Math.hypot(dx, dy);
      const score =
        t.forest * 2 +
        t.fertility * 0.4 +
        (1 - t.moisture) * 0.8 +
        w.weather.drought * 0.6 -
        Math.abs(d - 6.5) * 0.12; // not right on top of the hearth, but near
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      } else if (score === bestScore && best >= 0 && idx < best) {
        best = idx;
      }
    }
  }
  return best;
}

function igniteWildfire(
  ctx: Parameters<SimSystem>[0],
  cx: number,
  cy: number,
  intensity: number,
  resist: number,
): void {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  const tileIdx = findBurnTile(ctx, cx, cy);
  if (tileIdx < 0) {
    ctx.notify('A spark caught in the dry grass and was beaten out before it spread.', 'info', 'fire');
    return;
  }
  const fx = tileIdx % w.width;
  const fy = (tileIdx / w.width) | 0;
  const burnRadius = 2 + Math.round(intensity * 2);
  let burned = 0;
  let buildingsHit = 0;
  for (let dy = -burnRadius; dy <= burnRadius; dy++) {
    for (let dx = -burnRadius; dx <= burnRadius; dx++) {
      const x = fx + dx;
      const y = fy + dy;
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      const d = Math.hypot(dx, dy);
      if (d > burnRadius) continue;
      const t = w.tiles[y * w.width + x];
      if (!t) continue;
      const b = c.biomes[t.biome];
      if (!b || isWaterTile(c, t)) continue;
      const falloff = 1 - d / (burnRadius + 0.5);
      t.forest = round3(clamp(t.forest * (1 - intensity * 0.65 * falloff), 0, 1));
      t.forage = round3(clamp(t.forage * (1 - 0.45 * falloff), 0, 1));
      t.wildlife = round3(clamp(t.wildlife * (1 - 0.35 * falloff), 0, 1));
      t.fertility = round3(clamp(t.fertility * (1 - 0.06 * falloff), 0, 1));
      t.beauty = round3(clamp(t.beauty * (1 - 0.25 * falloff), 0, 1));
      t.pollution = round3(clamp(t.pollution + 0.03 * falloff, 0, 1));
      burned++;
    }
  }
  // buildings in the burn scar
  for (const b of s.buildings) {
    if (Math.hypot(b.x - fx, b.y - fy) > burnRadius + 1.5) continue;
    b.condition = round3(clamp(b.condition - 0.22 * intensity * (1 - clamp(resist, 0, 1) * 0.6), 0, 1));
    buildingsHit++;
  }
  record(ctx, 'fire');
  setFlag(s, 'disaster.fire.severity', Math.round(intensity * 100));
  const cap = settleCap(ctx);
  if (cap && buildingsHit > 0) {
    removeStock(cap, 'wood', (cap.stock['wood'] ?? 0) * 0.06);
  }
  ctx.notify(
    `Wildfire! ${burned} acres of the ${s.world.weather.season === 'summer' ? 'summer' : 'near'} woods burned before the wind fell${buildingsHit ? `, and ${buildingsHit} buildings were scorched` : ''}.`,
    'bad',
    'fire',
  );
  ctx.chronicle(
    'The Fire Year',
    'The hillside went up in an afternoon. Buckets passed hand to hand until the wells were mud, and afterwards the black ground smelled of rain for a week.',
    'disaster',
    3,
  );
}

function floodHearth(ctx: Parameters<SimSystem>[0], resist: number): void {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  const cap = capitalOf(s);
  if (!cap) return;
  // lowlying tiles: near the settlement and close to water / low elevation
  const affected: { x: number; y: number }[] = [];
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const x = cap.x + dx;
      const y = cap.y + dy;
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      const t = w.tiles[y * w.width + x];
      if (!t) continue;
      if (isWaterTile(c, t)) continue;
      const nearWater = t.water > 0.55;
      if (!nearWater && t.elev > 0.47) continue;
      affected.push({ x, y });
    }
  }
  let damaged = 0;
  for (const b of s.buildings) {
    if (Math.abs(b.x - cap.x) > 8 || Math.abs(b.y - cap.y) > 8) continue;
    b.condition = round3(clamp(b.condition - 0.3 * (1 - clamp(resist, 0, 1) * 0.65), 0, 1));
    damaged++;
  }
  // silt enriches the floodplain
  for (const a of affected) {
    const t = w.tiles[a.y * w.width + a.x];
    if (!t) continue;
    t.fertility = round3(clamp(t.fertility + 0.055, 0, 1));
    t.moisture = round3(clamp(t.moisture + 0.12, 0, 1));
    t.forest = round3(clamp(t.forest - 0.03, 0, 1));
  }
  // stored goods wash away
  if (cap) {
    for (const res of Object.keys(cap.stock)) {
      const def = c.resources[res];
      if (!def || (!def.tags?.includes('raw') && !def.edible && def.category !== 'raw')) continue;
      removeStock(cap, res, (cap.stock[res] ?? 0) * 0.07 * (1 - clamp(resist, 0, 1) * 0.5));
    }
  }
  record(ctx, 'flood');
  ctx.notify(
    damaged > 0
      ? `Flood! The river broke its banks and ${damaged} buildings took water. The floodplain will be richer for it, if we can dry out.`
      : 'Flood! The river broke its banks across the low fields. No buildings lost, but the harvest is swimming.',
    'bad',
    'water',
  );
  ctx.chronicle(
    'The Water Came',
    'Rain fell for days without pause, and then the river was in the lanes. Families spent the night moving grain to the roofs. When it went down it left silt, frogs, and a year of repairs.',
    'disaster',
    2,
  );
}

function countFarmBuildings(s: Parameters<SimSystem>[0]['s'], c: Parameters<SimSystem>[0]['c']): number {
  let farms = 0;
  for (const b of s.buildings) {
    if (b.progress < 0.999) continue;
    const def = c.buildings[b.typeId];
    if (def && def.category === 'food') farms++;
  }
  return farms;
}

function blightFarms(ctx: Parameters<SimSystem>[0], cx: number, cy: number, resist: number): boolean {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  let hit = 0;
  for (const b of s.buildings) {
    if (b.progress < 0.999) continue;
    const def = c.buildings[b.typeId];
    if (!def || def.category !== 'food') continue;
    if (Math.abs(b.x - cx) > 10 || Math.abs(b.y - cy) > 10) continue;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const t = tileAtSafe(w, b.x + dx, b.y + dy);
        if (!t) continue;
        t.fertility = round3(clamp(t.fertility - 0.12 * (1 - clamp(resist, 0, 1) * 0.6), 0, 1));
        t.forage = round3(clamp(t.forage - 0.05, 0, 1));
      }
    }
    hit++;
  }
  if (hit === 0) return false;
  record(ctx, 'blight');
  ctx.notify(
    'Blight in the fields. Whole rows yellowed overnight; the harvest will be thin unless the crop is burned back.',
    'warn',
    'leaf',
  );
  ctx.chronicle(
    'The Yellow Rows',
    'The wheat went yellow from the roots up. The farmers burned what they could not save and buried the ash deep, and swore the fields were never the same shape again.',
    'disaster',
    2,
  );
  return true;
}

function locustSwarm(ctx: Parameters<SimSystem>[0], resist: number): void {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  const cap = capitalOf(s);
  if (!cap) return;
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const t = tileAtSafe(w, cap.x + dx, cap.y + dy);
      if (!t) continue;
      const b = c.biomes[t.biome];
      if (!b || isWaterTile(c, t)) continue;
      t.forage = round3(clamp(t.forage - 0.16 * (1 - clamp(resist, 0, 1) * 0.5), 0, 1));
      t.fertility = round3(clamp(t.fertility - 0.07, 0, 1));
      t.forest = round3(clamp(t.forest - 0.02, 0, 1));
    }
  }
  record(ctx, 'locusts');
  ctx.notify(
    'A locust swarm darkens the sky over the fields. We can save the stored grain, but the standing crop is lost.',
    'warn',
    'bug',
  );
  ctx.chronicle(
    'The Cloud With Wings',
    'They came from the south at noon and the light went brown. By evening the fields were stems. The children caught them in baskets, out of some need to do anything at all.',
    'disaster',
    2,
  );
}

function earthquake(ctx: Parameters<SimSystem>[0], resist: number): void {
  const s = ctx.s;
  const w = s.world;
  let damaged = 0;
  for (const b of s.buildings) {
    const shake = 0.06 + ctx.rng() * 0.22;
    b.condition = round3(clamp(b.condition - shake * (1 - clamp(resist, 0, 1) * 0.7), 0, 1));
    damaged++;
  }
  // shake loose some stone into the nearest hills
  for (let i = 0; i < 3; i++) {
    const x = clamp(Math.round(w.startX + ctx.rng() * 6 - 3), 0, w.width - 1);
    const y = clamp(Math.round(w.startY + ctx.rng() * 6 - 3), 0, w.height - 1);
    const t = tileAtSafe(w, x, y);
    if (t && !t.deposit) {
      const amount = 40 + Math.round(ctx.rng() * 40);
      t.deposit = { resource: 'stone', amount, initial: amount, quality: 0.6, kind: 'surface' };
    }
  }
  record(ctx, 'quake');
  ctx.notify(
    damaged > 0
      ? 'The earth shook. Chimneys cracked and walls settled crooked — repairs will be needed before winter.'
      : 'The earth shook, and the valley held its breath until it passed.',
    'bad',
    'quake',
  );
  ctx.chronicle(
    'The Shaking',
    'A low sound came up through the ground, then the ground moved like a frightened animal. Afterwards people stood in the street counting the roofs still standing.',
    'disaster',
    2,
  );
}

function tileAtSafe(w: Parameters<SimSystem>[0]['s']['world'], x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= w.width || y >= w.height) return null;
  return w.tiles[y * w.width + x] ?? null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
