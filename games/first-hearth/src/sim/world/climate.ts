/**
 * Shared climate model helpers.
 *
 * Used by `worldgen.ts` to seed the initial weather and by the weather system each tick so
 * that generation and simulation agree on seasons, temperature curves and forecast phrasing.
 */
import { DAYS_PER_SEASON, DAYS_PER_YEAR, SEASONS } from '../types';
import type { SeasonId, WeatherState } from '../types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 1-based year number for a tick. */
export function yearForTick(tick: number): number {
  return Math.floor(tick / DAYS_PER_YEAR) + 1;
}

/** 0-based index into SEASONS. */
export function seasonIndexForTick(tick: number): number {
  return Math.floor((tick % DAYS_PER_YEAR) / DAYS_PER_SEASON);
}

/** 1-based day within the current season (1..16). */
export function dayInSeasonForTick(tick: number): number {
  return (tick % DAYS_PER_SEASON) + 1;
}

export function seasonForTick(tick: number): SeasonId {
  return SEASONS[seasonIndexForTick(tick)];
}

/** Position within the year, 0..1. */
export function yearPhase(tick: number): number {
  const t = ((tick % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return t / DAYS_PER_YEAR;
}

/** Latitude factor: 0 at the equator (map centre row), 1 at the poles (map edge rows). */
export function latitudeFactor(y: number, height: number): number {
  return Math.abs((y + 0.5) / Math.max(1, height) - 0.5) * 2;
}

/** Annual mean temperature for a place at a given latitude and elevation. */
export function annualMeanTemp(latitude: number, elev01: number, startTemp = 15): number {
  const latDrop = latitude * 19;
  // Real lapse only matters above the lowlands: pseudo-height ~2400m at the highest peak.
  const h = Math.max(0, elev01);
  const lapse = Math.pow(h, 1.5) * 2400 * 0.0062;
  return startTemp - latDrop - lapse;
}

/** Seasonal swing amplitude (°C) grows toward the poles. */
export function seasonAmplitude(latitude: number): number {
  return 2.6 + latitude * 9.5;
}

/**
 * Seasonal temperature target for a tick.
 * Warmest around late summer (~72% of the way through the year after a lag), coldest in winter.
 */
export function seasonalTempTarget(annualMean: number, amp: number, tick: number): number {
  const warm = Math.cos((yearPhase(tick) - 0.28) * Math.PI * 2);
  return annualMean + amp * warm;
}

/** How "wintery" conditions are: 0 warm, 1 deep winter. */
export function coldness(temp: number): number {
  return clamp((8 - temp) / 18, 0, 1);
}

/** Drought pressure from drought severity and temperature. */
export function heatPressure(temp: number): number {
  return clamp((temp - 20) / 16, 0, 1);
}

/** Human-readable forecast. `rainChance` is 0..1, `trend` shifts the wording. */
export function forecastText(
  w: WeatherState,
  rainChance: number,
  trend: -1 | 0 | 1,
): string {
  const turning =
    trend > 0 ? ', turning warmer' : trend < 0 ? ', turning colder' : '';
  if (w.storm > 0.55) {
    return trend < 0 ? 'Storm winds, but clearing by dusk' : 'Storm winds and driving rain';
  }
  if (w.snow > 0.35) {
    return rainChance > 0.5 ? 'Snow, easing later' : 'Snow lying, still and cold';
  }
  if (w.drought > 0.55 && rainChance < 0.3) {
    return trend < 0 ? 'Parched haze, a cool edge at night' : 'Dry heat, not a cloud in sight';
  }
  if (rainChance > 0.66) {
    return trend < 0 ? 'Rain turning to sleet' : 'Rain sweeping in from the west';
  }
  if (rainChance > 0.38) {
    return w.temperature > 22 ? 'Close and showery' : 'Cloudy with scattered rain';
  }
  if (w.temperature < 3) {
    return `Clear and bitterly cold${turning}`;
  }
  if (w.temperature < 10) {
    return `Clear and cold${turning}`;
  }
  if (w.temperature > 29) {
    return 'Hot and dry, hazy at noon';
  }
  if (w.wind > 0.6) {
    return 'Bright and windy';
  }
  return trend < 0 ? 'Clear, turning colder' : trend > 0 ? 'Mild and bright' : 'Clear and mild';
}

/** Aggregate severity of the current weather, 0..1. */
export function weatherSeverity(w: WeatherState): number {
  return clamp(
    Math.max(w.storm, w.drought * 0.85, w.snow * 0.6, w.rainfall * 0.5) +
      Math.abs(w.temperature - 16) / 60,
    0,
    1,
  );
}
