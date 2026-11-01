/**
 * Weather system — seasons, temperature, rainfall, drought, storms, snow, soil moisture.
 *
 * 1 tick = 1 day. The world-level weather in `world.weather` is the single source of truth
 * for climate pressure: tile moisture (applied by ecology), farm/forage yields, disasters and
 * forecasts all read from it. Early game is deliberately gentle: the first ~3 weeks are mild,
 * then weather pressure ramps in over the first season.
 *
 * Determinism: only ctx.rng(); no wall clock, no Math.random.
 */
import type { SeasonId, SimSystem } from '../../types';
import { capitalOf, clamp, getFlag, setFlag, tileAt } from '../../core';
import {
  coldness,
  dayInSeasonForTick,
  forecastText,
  heatPressure,
  latitudeFactor,
  lerp,
  seasonAmplitude,
  seasonForTick,
  seasonalTempTarget,
  weatherSeverity,
  yearForTick,
} from '../../world/climate';

/** Seasonal base chance of a rainy day. */
const SEASON_RAIN: Record<SeasonId, number> = {
  spring: 0.44,
  summer: 0.2,
  autumn: 0.44,
  winter: 0.28,
};

/** How much of full weather pressure applies on a given day (gentle opening). */
export function weatherRamp(tick: number): number {
  return clamp((tick - 4) / 24, 0.3, 1);
}

/** 0..1 drought severity, convenience read for other systems (production/events/UI). */
export function droughtPressure(ctx: { s: { world: { weather: { drought: number } } } }): number {
  return ctx.s.world.weather.drought;
}

export const weatherSystem: SimSystem = (ctx) => {
  const s = ctx.s;
  const world = s.world;
  const w = world.weather;
  const tick = ctx.tick;
  const rng = ctx.rng;

  const season = seasonForTick(tick);
  w.season = season;
  w.dayInSeason = dayInSeasonForTick(tick);
  w.year = yearForTick(tick);

  const ramp = weatherRamp(tick);

  // ---- temperature -------------------------------------------------------
  const cap = capitalOf(s);
  const ax = cap ? cap.x : world.startX;
  const ay = cap ? cap.y : world.startY;
  const anchor = tileAt(world, ax, ay);
  const latitude = latitudeFactor(ay, world.height);
  const warming = world.climate.warming;
  const annualMean = (anchor?.temp ?? 15) + warming;
  const amplitude = seasonAmplitude(latitude);
  let target = seasonalTempTarget(annualMean, amplitude, tick);

  // Cold fronts: winter (and the shoulder seasons) can send a hard snap down from the north.
  let coldSnapUntil = getFlag(s, 'weather.coldSnapUntil');
  let coldSnapMag = getFlag(s, 'weather.coldSnapMag');
  if (tick >= coldSnapUntil) coldSnapMag = 0;
  const snapSeason =
    season === 'winter' ||
    (season === 'autumn' && w.dayInSeason > 11) ||
    (season === 'spring' && w.dayInSeason < 5);
  if (snapSeason && coldSnapMag <= 0 && tick > 24 && rng() < 0.022 * ramp) {
    coldSnapMag = 6 + rng() * 9;
    coldSnapUntil = tick + 3 + Math.floor(rng() * 3);
    ctx.notify(
      'A cold front is sweeping down from the north. Expect hard frost, snow, and frozen water within the day.',
      'warn',
      'snow',
    );
  }
  target -= coldSnapMag;
  setFlag(s, 'weather.coldSnapUntil', coldSnapUntil);
  setFlag(s, 'weather.coldSnapMag', coldSnapMag);

  const dayNoise = (rng() - 0.5) * 2.2;
  w.temperature = round1(w.temperature + (target + dayNoise - w.temperature) * 0.55);

  // ---- wet / dry spells (Markov-ish) -------------------------------------
  let wetSpell = getFlag(s, 'weather.wetSpell');
  let drySpell = getFlag(s, 'weather.drySpell');
  let rainChance =
    SEASON_RAIN[season] *
    (0.55 + 0.45 * ramp) *
    (1 - w.drought * 0.6) *
    (1 - w.snow * 0.1);
  if (wetSpell > 0) rainChance += 0.34;
  if (w.storm > 0.3) rainChance += 0.22;
  rainChance = clamp(rainChance, 0.02, 0.96);

  if (rng() < rainChance) {
    w.rainfall = clamp(0.28 + rng() * 0.72, 0, 1);
    wetSpell = Math.min(8, wetSpell + 1);
    drySpell = 0;
  } else {
    w.rainfall = 0;
    wetSpell = 0;
    drySpell = Math.min(90, drySpell + 1);
  }
  setFlag(s, 'weather.wetSpell', wetSpell);
  setFlag(s, 'weather.drySpell', drySpell);

  // ---- drought -----------------------------------------------------------
  const heat = heatPressure(w.temperature);
  const wasDrought = getFlag(s, 'weather.wasDrought') === 1;
  if (w.rainfall < 0.15) {
    const gain = (0.02 + heat * 0.032 + (drySpell > 8 ? 0.012 : 0)) * ramp;
    w.drought = clamp(w.drought + gain, 0, 1);
  } else {
    // rain breaks a drought, but a deep one needs a wet season, not a shower
    w.drought = clamp(w.drought - 0.035 * (0.2 + w.rainfall) * (1 + w.rainfall), 0, 1);
  }
  w.drought = clamp(w.drought - 0.0015, 0, 1); // slow natural recovery

  // ---- storms ------------------------------------------------------------
  let stormChance = 0.035 + (season === 'autumn' ? 0.06 : 0) + (season === 'spring' ? 0.02 : 0);
  stormChance *= ramp;
  if (w.storm > 0.3) {
    // storms decay over a few days
    w.storm = rng() < 0.4 ? clamp(w.storm + (rng() - 0.35) * 0.3, 0, 1) : w.storm * 0.6;
  } else if (rng() < stormChance) {
    w.storm = clamp(0.35 + rng() * 0.6, 0, 1);
  } else {
    w.storm *= 0.9;
  }
  if (w.storm > 0.45) {
    w.rainfall = Math.max(w.rainfall, 0.55);
    w.drought = clamp(w.drought - 0.16 * w.storm, 0, 1);
  }

  // ---- snow --------------------------------------------------------------
  if (w.temperature <= 2) {
    const snowfall = ((2 - w.temperature) / 20) * (0.25 + w.rainfall * 1.4);
    w.snow = clamp(w.snow + snowfall * 0.55, 0, 1);
  } else {
    const melt = ((w.temperature - 2) / 12) * (0.15 + w.rainfall * 0.5);
    w.snow = clamp(w.snow - melt, 0, 1);
  }

  // ---- wind + regional soil moisture ------------------------------------
  w.wind = clamp(w.wind * 0.72 + rng() * 0.22 + w.storm * 0.3, 0, 1);

  const moistureTarget = clamp(
    0.32 +
      w.rainfall * 0.45 -
      w.drought * 0.4 +
      (season === 'spring' ? 0.07 : 0) -
      (season === 'summer' ? 0.04 : 0) +
      w.snow * 0.05,
    0.05,
    1,
  );
  w.soilMoisture = clamp(lerp(w.soilMoisture, moistureTarget, 0.35), 0, 1);

  // ---- forecast ----------------------------------------------------------
  const forecastRainChance = clamp(
    SEASON_RAIN[season] * (1 - w.drought * 0.6) + (wetSpell > 0 ? 0.3 : 0) + w.storm * 0.2,
    0.02,
    0.95,
  );
  const trend: -1 | 0 | 1 =
    target < w.temperature - 1.5 ? -1 : target > w.temperature + 1.5 ? 1 : 0;
  w.forecast = forecastText(w, forecastRainChance, trend);

  // ---- telegraphing / notifications -------------------------------------
  const lastNotify = (key: string): number => getFlag(s, key);
  const cooldownOk = (key: string, days: number): boolean => tick - lastNotify(key) >= days;

  if (w.drought > 0.4 && !wasDrought) {
    setFlag(s, 'weather.wasDrought', 1);
    ctx.notify(
      'The rains have failed. Streams are shrinking and the fields are cracking — wells and stored water matter now.',
      'warn',
      'sun',
    );
    ctx.chronicle(
      'The Dry Time',
      'A season of hard skies began. The elders watched the riverbed show its stones and spoke of years their grandparents had only half believed.',
      'nature',
      2,
    );
  } else if (wasDrought && w.drought < 0.08 && w.rainfall > 0.3) {
    setFlag(s, 'weather.wasDrought', 0);
    ctx.notify('The drought has broken. Rain returns to the valley.', 'good', 'cloud');
  } else if (w.drought > 0.2 && w.drought < 0.4 && cooldownOk('weather.dryWarn', 18) && rng() < 0.35) {
    setFlag(s, 'weather.dryWarn', tick);
    ctx.notify('The river runs low and the wells are light. A dry spell is settling in.', 'info', 'droplet');
  }

  if (w.storm > 0.5 && cooldownOk('weather.stormWarn', 6)) {
    setFlag(s, 'weather.stormWarn', tick);
    setFlag(s, 'weather.stormTick', tick);
    ctx.notify(
      'Storm winds rise over the hills. Roofs are lashed, and low ground will flood if this holds.',
      'warn',
      'storm',
    );
  }

  const year = w.year;
  if (w.snow > 0.3 && getFlag(s, 'weather.snowYear') !== year) {
    setFlag(s, 'weather.snowYear', year);
    ctx.notify('The first snow falls over the valley.', 'info', 'snow');
  }
  if (w.temperature < -8 && cooldownOk('weather.freezeWarn', 15)) {
    setFlag(s, 'weather.freezeWarn', tick);
    ctx.notify('Hard frost. The old and the ill will suffer; see that the hearths are fed.', 'warn', 'snow');
  }
  if (w.temperature > 31 && heat < 0.9 && w.drought > 0.5 && cooldownOk('weather.heatWarn', 20)) {
    setFlag(s, 'weather.heatWarn', tick);
    ctx.notify('A heat haze hangs over the fields; work slows and tempers fray.', 'info', 'sun');
  }

  // Numeric flags for other systems / metrics (cheap, deterministic reads).
  setFlag(s, 'weather.drought01', Math.round(w.drought * 100));
  setFlag(s, 'weather.soilMoisture01', Math.round(w.soilMoisture * 100));
  setFlag(s, 'weather.severity01', Math.round(weatherSeverity(w) * 100));
  setFlag(s, 'weather.tempC', Math.round(w.temperature));
  setFlag(s, 'weather.snow01', Math.round(w.snow * 100));
  setFlag(s, 'weather.coldness01', Math.round(coldness(w.temperature) * 100));
};

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
