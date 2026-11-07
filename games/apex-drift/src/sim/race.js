/**
 * Race director: grid, countdown, laps, timing, standings and results.
 *
 * `stepRace` owns the per-substep order of operations:
 * 1. `stepCar` for every car (player input / AI decisions),
 * 2. `resolveCarTrack` wall response per car (+ stuck recovery for AI),
 * 3. `resolveCarCar` car-to-car contacts,
 * 4. race bookkeeping: monotonic lap progress, lap/finish events, standings.
 *
 * Everything is deterministic: the seed drives the AI rng streams only, and all
 * iteration is in fixed array order.
 */

import { clamp } from '../core/math.js';
import { hashString } from '../core/rng.js';
import {
  CAR_ORDER,
  CAR_SPECS,
  GRID_SPACING,
  LAPS,
  OPPONENT_COUNT,
  OPPONENT_NAMES,
  OPPONENT_PALETTES,
  OPPONENT_SKILLS,
} from './config.js';
import { createCarState, resetCar, stepCar } from './car.js';
import { createAiDriver, aiInput } from './ai.js';
import { resolveCarCar, resolveCarTrack } from './collisions.js';

/** Estimated average pace (m/s) used to turn a distance gap into seconds. */
const GAP_PACE = 34;
/** How long the sim keeps running after the player crosses the line. */
const RESULTS_GRACE = 2.0;
/** Safety net: a race this long is force-finished with projected times. */
const MAX_RACE_SECONDS = 600;
/** How often standings are recomputed inside `stepRace` (seconds). */
const STANDINGS_INTERVAL = 0.05;

const NEUTRAL_INPUT = Object.freeze({ throttle: 0, steer: 0, handbrake: false, nitro: false });

/** @param {number} value @param {number} fallback */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve an entrant's spec: an id string, a CarSpec object, or nothing.
 * @param {string|object|undefined} spec
 */
function resolveSpec(spec) {
  if (typeof spec === 'string' && CAR_SPECS[spec]) return CAR_SPECS[spec];
  if (spec && typeof spec === 'object' && Number.isFinite(spec.mass)) return spec;
  return CAR_SPECS[CAR_ORDER[0]];
}

/**
 * Palette handling: accept a full palette object or a bare RGB triple.
 * @param {object|number[]|undefined} palette
 * @param {object} spec
 */
function resolvePalette(palette, spec) {
  if (Array.isArray(palette) && palette.length >= 3) {
    return { ...(spec.palette || {}), paint: palette.slice(0, 3) };
  }
  if (palette && typeof palette === 'object') return palette;
  return spec.palette ?? null;
}

/** @param {object} entrant */
function normalizeEntrant(entrant) {
  const source = entrant || {};
  const spec = resolveSpec(source.spec);
  return {
    spec,
    palette: resolvePalette(source.palette, spec),
    isPlayer: source.isPlayer === true,
    skill: clamp(finiteOr(source.skill, 0.82), 0.2, 1),
    name: source.name ?? spec.name ?? 'RIVAL',
    id: typeof source.id === 'string' && source.id.length > 0 ? source.id : null,
  };
}

/**
 * Default six-car grid: one player plus the five opponents from config.
 * @returns {object[]}
 */
function defaultEntrants() {
  const entrants = [{ spec: CAR_SPECS[CAR_ORDER[0]], isPlayer: true, name: 'YOU' }];
  for (let i = 0; i < OPPONENT_COUNT; i += 1) {
    const spec = CAR_SPECS[CAR_ORDER[(i + 1) % CAR_ORDER.length]];
    entrants.push({
      id: `ai${i + 1}`,
      spec,
      palette: resolvePalette(OPPONENT_PALETTES[i % OPPONENT_PALETTES.length], spec),
      name: OPPONENT_NAMES[i % OPPONENT_NAMES.length],
      skill: OPPONENT_SKILLS[i % OPPONENT_SKILLS.length],
    });
  }
  return entrants;
}

/**
 * @typedef {{
 *   carId:string, position:number, lap:number, progress:number, gap:number,
 *   isPlayer:boolean, name:string, palette:object|null,
 * }} Standing
 */

/**
 * Build a race.
 *
 * The player always starts at the back of the grid; `race.cars` is in grid
 * order (front of the grid first, player last).
 *
 * @param {{
 *   track: object, entrants?: object[], laps?: number, seed?: number, countdown?: number,
 * }} options
 * @returns {object} Race
 */
export function createRace(options = {}) {
  const track = options.track;
  if (!track || typeof track.query !== 'function' || !(track.length > 0)) {
    throw new TypeError('createRace needs a built track (see buildTrack)');
  }
  const laps = Math.max(1, Math.round(finiteOr(options.laps, LAPS)));
  const seed = Number.isFinite(options.seed) ? options.seed >>> 0 : 1;
  const countdownTotal = Math.max(0, Math.round(finiteOr(options.countdown, 3)));
  const entrantsRaw =
    Array.isArray(options.entrants) && options.entrants.length > 0
      ? options.entrants
      : defaultEntrants();
  const entrants = entrantsRaw.map(normalizeEntrant);

  // Grid order: everyone else first, players at the back.
  const gridOrder = entrants.filter((e) => !e.isPlayer).concat(entrants.filter((e) => e.isPlayer));

  const cars = [];
  const ais = [];
  let player = null;
  const laneBiases = [-0.55, -0.25, 0.15, 0.45, 0, -0.4];

  for (let i = 0; i < gridOrder.length; i += 1) {
    const entrant = gridOrder[i];
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const slot = track.gridTransform(6 + row * GRID_SPACING, side * track.width * 0.18);
    const id = entrant.id ?? (entrant.isPlayer ? 'player' : `ai${i + 1}`);
    const car = createCarState({
      id,
      spec: entrant.spec,
      palette: entrant.palette,
      position: { x: slot.x, y: slot.y, z: slot.z },
      heading: slot.heading,
      isPlayer: entrant.isPlayer,
    });
    // Extras used by the race director, HUD and standings.
    car.name = entrant.name;
    car._laps = laps;
    car._lapTimes = [];
    car._lapIndex = 0;
    car._lapStart = 0;
    car._started = false;
    car._finished = false;
    car._finishTime = null;
    car._finishPosition = 0;
    car._contactCooldown = 0;

    // Progress starts *behind* the start line (negative), so the first crossing
    // starts lap 1 rather than completing it.
    const startQuery = track.query(car.x, car.z, -1);
    car.humpIndex = startQuery.index;
    car._sPrev = startQuery.s;
    car._totalDistance =
      startQuery.s > track.length * 0.6 ? startQuery.s - track.length : startQuery.s;

    if (entrant.isPlayer && !player) {
      player = car;
    } else {
      const ai = createAiDriver({
        id: car.id,
        spec: entrant.spec,
        skill: entrant.skill,
        laneBias: laneBiases[i % laneBiases.length],
        seed: (seed ^ hashString(car.id)) >>> 0,
      });
      car._ai = ai;
      ais.push(ai);
    }
    cars.push(car);
  }

  /** @type {object} */
  const race = {
    track,
    laps,
    cars,
    ais,
    player,
    state: 'countdown',
    time: 0,
    countdown: countdownTotal,
    standings: [],
    results: null,
    playerLapTimes: [],
    playerBestLap: null,
    // Convenience mirrors for the HUD's live lap timer.
    playerLap: 1,
    playerLapStart: 0,
    playerLapTime: 0,
    seed,

    // Internals (prefixed with _; free to change).
    _countdownTotal: countdownTotal,
    _countdownElapsed: 0,
    _countdownStarted: false,
    _standingsTimer: 0,
    _finishTimer: 0,
    _playerFinished: false,
    _finishedCount: 0,
  };

  race.standings = computeStandings(race);
  if (countdownTotal === 0) {
    race.state = 'running';
    race.countdown = 0;
  }
  return race;
}

/* ------------------------------------------------------------ countdown -- */

/**
 * Emit the 3-2-1-GO sequence, one tick per second, then switch to running.
 * @param {object} race
 * @param {number} dt
 * @param {object[]} events
 */
function stepCountdown(race, dt, events) {
  if (!race._countdownStarted) {
    race._countdownStarted = true;
    if (race._countdownTotal > 0) {
      race.countdown = race._countdownTotal;
      events.push({ type: 'countdown', value: race.countdown });
    } else {
      race.state = 'running';
      race.countdown = 0;
      events.push({ type: 'go' });
      return;
    }
  }
  race._countdownElapsed += dt;
  while (race._countdownElapsed >= 1 && race.state === 'countdown') {
    race._countdownElapsed -= 1;
    race.countdown -= 1;
    if (race.countdown > 0) {
      events.push({ type: 'countdown', value: race.countdown });
    } else {
      race.countdown = 0;
      race.state = 'running';
      events.push({ type: 'go' });
    }
  }
}

/* -------------------------------------------------------------- progress -- */

/**
 * Lap + progress for one car, monotonic and clamped to 0..laps.
 * Works on a bare CarState (falls back to the track query when the car has not
 * been through `createRace`).
 *
 * @param {object} car
 * @param {object} track
 * @returns {{lap:number, progress:number}}
 */
export function raceProgress(car, track) {
  if (!car) return { lap: 1, progress: 0 };
  const length = track && track.length > 0 ? track.length : 1;
  let total = car._totalDistance;
  if (!Number.isFinite(total)) {
    const query = track && typeof track.query === 'function' ? track.query(car.x, car.z, car.humpIndex) : null;
    total = query ? query.s : 0;
  }
  const laps = Number.isFinite(car._laps) ? car._laps : Infinity;
  const progress = clamp(total / length, 0, laps);
  const lap = Math.max(1, Math.floor(Math.max(0, total) / length) + 1);
  return { lap: Math.min(lap, Number.isFinite(laps) ? laps : lap), progress };
}

/**
 * Advance one car's lap bookkeeping from its position.
 *
 * @param {object} race
 * @param {object} car
 * @param {object[]} events
 */
function updateCarProgress(race, car, events) {
  const track = race.track;
  const length = track.length;
  const query = track.query(car.x, car.z, car.humpIndex);
  car.humpIndex = query.index;
  if (car._sPrev == null) car._sPrev = query.s;

  let deltaS = query.s - car._sPrev;
  if (deltaS < -length / 2) deltaS += length;
  else if (deltaS > length / 2) deltaS -= length;
  car._sPrev = query.s;

  // Ignore teleports/resets; small backwards movement is tolerated.
  if (Math.abs(deltaS) < 40) car._totalDistance += deltaS;

  if (!car._started) {
    if (car._totalDistance >= 0) {
      car._started = true;
      car._lapStart = race.time;
    }
    return;
  }

  const completed = Math.floor(car._totalDistance / length);
  if (completed <= car._lapIndex) return;

  if (completed - car._lapIndex > 1) {
    // Jumped more than a lap (teleport): resync silently.
    car._lapIndex = completed;
    car._lapStart = race.time;
    return;
  }

  car._lapIndex = completed;
  const lapTime = Math.max(0.001, race.time - car._lapStart);
  car._lapStart = race.time;
  car._lapTimes.push(lapTime);

  let bestLap = Infinity;
  for (let i = 0; i < car._lapTimes.length; i += 1) bestLap = Math.min(bestLap, car._lapTimes[i]);
  const isBest = Math.abs(lapTime - bestLap) < 1e-9;

  if (car === race.player) {
    race.playerLapTimes.push(lapTime);
    race.playerBestLap =
      race.playerBestLap == null ? lapTime : Math.min(race.playerBestLap, lapTime);
  }

  if (completed <= race.laps && !car._finished) {
    events.push({
      type: 'lap',
      carId: car.id,
      lap: completed,
      lapTime,
      isBest,
      isPlayer: car === race.player,
    });
  }

  if (car._lapIndex >= race.laps && !car._finished) {
    finishCar(race, car, events);
  }
}

/**
 * Record a car crossing the finish line.
 * @param {object} race
 * @param {object} car
 * @param {object[]} events
 */
function finishCar(race, car, events) {
  car._finished = true;
  car._finishTime = race.time;
  race._finishedCount += 1;
  car._finishPosition = race._finishedCount;
  events.push({
    type: 'finish',
    carId: car.id,
    position: car._finishPosition,
    isPlayer: car === race.player,
  });
  if (car === race.player) race._playerFinished = true;
}

/* -------------------------------------------------------------- standings -- */

/**
 * Sorted standings. Ordering uses monotonic race progress, so positions only
 * swap when cars actually change order on the road. `gap` is the estimated
 * number of seconds behind the leader (distance / GAP_PACE), or the real finish
 * time difference once the leader has finished.
 *
 * @param {object} race
 * @returns {Standing[]}
 */
export function computeStandings(race) {
  /** @type {Standing[]} */
  const standings = [];
  if (!race || !Array.isArray(race.cars) || race.cars.length === 0) return standings;
  const length = race.track && race.track.length > 0 ? race.track.length : 1;
  const laps = Math.max(1, Math.round(finiteOr(race.laps, LAPS)));

  const entries = [];
  for (let i = 0; i < race.cars.length; i += 1) {
    const car = race.cars[i];
    if (!car) continue;
    const finished = car._finished === true;
    const total = clamp(finiteOr(car._totalDistance, 0), -length, laps * length);
    const progressMetres = finished ? laps * length : total;
    entries.push({
      car,
      index: i,
      finished,
      finishTime: finished ? finiteOr(car._finishTime, 0) : Infinity,
      progressMetres,
      progress: clamp(progressMetres / length, 0, laps),
    });
  }

  entries.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) {
      return a.finishTime - b.finishTime || a.index - b.index;
    }
    return b.progressMetres - a.progressMetres || a.index - b.index;
  });

  const leader = entries[0];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const car = entry.car;
    let gap = 0;
    if (i > 0 && leader) {
      if (leader.finished && entry.finished) {
        gap = Math.max(0, entry.finishTime - leader.finishTime);
      } else {
        gap = Math.max(0, (leader.progressMetres - entry.progressMetres) / GAP_PACE);
      }
    }
    standings.push({
      carId: car.id,
      position: i + 1,
      lap: clamp(
        entry.finished ? laps : Math.max(1, (finiteOr(car._lapIndex, 0) | 0) + 1),
        1,
        laps,
      ),
      progress: entry.progress,
      gap,
      isPlayer: !!car.isPlayer,
      name: car.name ?? (car.spec && car.spec.name) ?? car.id,
      palette: car.palette ?? null,
    });
  }
  return standings;
}

/* --------------------------------------------------------------- results -- */

/**
 * Fill `race.results` for every car. Unfinished cars get a projected total time
 * from their average pace so the table is always complete.
 *
 * @param {object} race
 * @returns {object[]}
 */
function buildResults(race) {
  const track = race.track;
  const length = track.length;
  const laps = race.laps;
  const totalDistance = laps * length;
  const elapsed = Math.max(0.5, race.time);
  const rows = [];

  for (let i = 0; i < race.cars.length; i += 1) {
    const car = race.cars[i];
    if (!car) continue;
    let totalTime;
    if (car._finished && Number.isFinite(car._finishTime)) {
      totalTime = car._finishTime;
    } else {
      const covered = Math.max(0, finiteOr(car._totalDistance, 0));
      const pace = clamp(covered > 1 ? covered / elapsed : 22, 12, 90);
      const remaining = Math.max(0, totalDistance - covered);
      totalTime = elapsed + remaining / pace;
    }
    const lapTimes = Array.isArray(car._lapTimes) ? car._lapTimes.slice() : [];
    let bestLap = null;
    for (let l = 0; l < lapTimes.length; l += 1) {
      if (bestLap == null || lapTimes[l] < bestLap) bestLap = lapTimes[l];
    }
    rows.push({
      carId: car.id,
      name: car.name ?? (car.spec && car.spec.name) ?? car.id,
      position: 0,
      totalTime,
      bestLap,
      laps: lapTimes.map((time, index) => ({ lap: index + 1, time })),
      isPlayer: !!car.isPlayer,
      palette: car.palette ?? null,
    });
  }

  rows.sort((a, b) => a.totalTime - b.totalTime || a.carId.localeCompare(b.carId));
  for (let i = 0; i < rows.length; i += 1) rows[i].position = i + 1;
  return rows;
}

/**
 * Close out the race: build results, mark finished, emit `race-end`.
 * @param {object} race
 * @param {object[]} events
 */
function finalizeRace(race, events) {
  if (race.state === 'finished') return;
  race.results = buildResults(race);
  race.state = 'finished';
  race._standingsTimer = 0;
  race.standings = computeStandings(race);
  events.push({ type: 'race-end' });
}

/* ------------------------------------------------------------ recovery -- */

/**
 * Teleport a wedged AI car back onto the centreline, facing down the track.
 * @param {object} race
 * @param {object} car
 */
function recoverCar(race, car) {
  const track = race.track;
  const query = track.query(car.x, car.z, car.humpIndex);
  const point = track.pointAt(query.s + 3);
  resetCar(car, { x: point.x, y: point.y, z: point.z }, point.heading);
  car._stuckTime = 0;
  car._sPrev = null;
}

/* ------------------------------------------------------------- main step -- */

/** @param {object|null} input */
function sanitizeInput(input) {
  if (!input || typeof input !== 'object') return NEUTRAL_INPUT;
  return {
    throttle: clamp(finiteOr(input.throttle, 0), -1, 1),
    steer: clamp(finiteOr(input.steer, 0), -1, 1),
    handbrake: !!input.handbrake,
    nitro: !!input.nitro,
  };
}

/**
 * Advance the whole race by one fixed step.
 *
 * @param {object} race
 * @param {number} dt fixed timestep in seconds
 * @param {object|null} playerInput `{throttle, steer, handbrake, nitro}`
 * @returns {object[]} small array of race events
 */
export function stepRace(race, dt, playerInput) {
  /** @type {object[]} */
  const events = [];
  if (!race || !Array.isArray(race.cars) || race.cars.length === 0) return events;
  if (race.state === 'finished') return events;
  if (!(dt > 0) || !Number.isFinite(dt)) return events;
  if (race.state === 'countdown') {
    stepCountdown(race, dt, events);
    return events;
  }

  race.time += dt;
  const track = race.track;

  /* -- 1. vehicle physics ------------------------------------------------- */
  for (let i = 0; i < race.cars.length; i += 1) {
    const car = race.cars[i];
    if (!car) continue;
    let input;
    if (car._finished) {
      input = NEUTRAL_INPUT; // freewheel after the flag
    } else if (car === race.player) {
      input = sanitizeInput(playerInput);
    } else if (car._ai) {
      input = aiInput(car._ai, car, track, race, dt);
    } else {
      input = NEUTRAL_INPUT;
    }
    const carEvents = stepCar(car, input, dt, track);
    for (let e = 0; e < carEvents.length; e += 1) {
      const event = carEvents[e];
      if (event.type === 'nitro') {
        events.push({ type: 'nitro', carId: car.id, isPlayer: car === race.player });
      } else if (event.type === 'shift' && car === race.player) {
        events.push({ type: 'shift', carId: car.id, intensity: event.intensity, isPlayer: true });
      } else if (event.type === 'offtrack' && car === race.player) {
        events.push({
          type: 'offtrack',
          carId: car.id,
          intensity: event.intensity,
          isPlayer: true,
        });
      }
    }
  }

  /* -- 2. walls ----------------------------------------------------------- */
  for (let i = 0; i < race.cars.length; i += 1) {
    const car = race.cars[i];
    if (!car) continue;
    const result = resolveCarTrack(car, track, dt);
    for (let e = 0; e < result.events.length; e += 1) {
      events.push({
        type: 'scrape',
        carId: car.id,
        intensity: result.events[e].intensity,
        isPlayer: car === race.player,
      });
    }
    if (result.stuck && car !== race.player && !car._finished) {
      recoverCar(race, car);
    }
  }

  /* -- 3. car-to-car ------------------------------------------------------ */
  const contacts = resolveCarCar(race.cars);
  for (let i = 0; i < contacts.length; i += 1) {
    const contact = contacts[i];
    events.push({
      type: 'contact',
      carId: contact.carId,
      otherId: contact.otherId,
      intensity: contact.intensity,
      isPlayer: race.player != null && (contact.carId === race.player.id || contact.otherId === race.player.id),
    });
  }

  /* -- 4. bookkeeping ----------------------------------------------------- */
  for (let i = 0; i < race.cars.length; i += 1) {
    const car = race.cars[i];
    if (car) updateCarProgress(race, car, events);
  }

  race._standingsTimer -= dt;
  if (race._standingsTimer <= 0 || events.length > 0) {
    race.standings = computeStandings(race);
    race._standingsTimer = STANDINGS_INTERVAL;
  }
  if (race.player) {
    race.playerLap = Math.min(race.laps, clamp((finiteOr(race.player._lapIndex, 0) | 0) + 1, 1, race.laps));
    race.playerLapStart = finiteOr(race.player._lapStart, 0);
    race.playerLapTime = Math.max(0, race.time - race.playerLapStart);
  }

  /* -- 5. end conditions -------------------------------------------------- */
  if (race._finishedCount >= race.cars.length) {
    finalizeRace(race, events);
  } else if (race._playerFinished) {
    race._finishTimer += dt;
    if (race._finishTimer >= RESULTS_GRACE) finalizeRace(race, events);
  } else if (race.time > MAX_RACE_SECONDS) {
    finalizeRace(race, events);
  }

  return events;
}
