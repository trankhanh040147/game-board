/**
 * Collision response for Apex Drift.
 *
 * Two independent solvers:
 * - `resolveCarTrack` keeps cars inside the barrier line: it pushes the body
 *   back inside, reflects the outward part of the velocity with a little
 *   restitution, scrubs forward speed and reports a `scrape` event. It also
 *   reports when a car has been wedged long enough to need a recovery teleport.
 * - `resolveCarCar` runs a two-circle proxy (front/rear at ±1.2 m, r≈0.95) for
 *   every pair of cars: it separates the bodies, exchanges a small velocity
 *   impulse along the contact normal and adds the matching yaw kick. A
 *   `contact` event is emitted with a per-car cooldown so audio does not spam.
 *
 * Both are deterministic and order-stable: pairs are always visited in array
 * order and there is no randomness. Everything here only mutates position /
 * velocity, never the tyre model state.
 */

import { clamp, clamp01 } from '../core/math.js';

/* --------------------------------------------------------------- tuning -- */

/** How far inside `track.boundary` the car body is kept. */
const WALL_CLEARANCE = 1.0;
/** Fraction of the outward velocity returned by a wall hit. */
const WALL_RESTITUTION = 0.25;
/** Outward speed (m/s) below which a wall touch is silent. */
const WALL_SCRAPE_THRESHOLD = 0.8;
/** Minimum seconds between two scrape events for one car. */
const SCRAPE_COOLDOWN = 0.18;
/** Seconds pinned against a barrier before the race should recover the car. */
const STUCK_TIME = 1.5;
/** Forward speed (m/s) under which a wall contact counts towards "stuck". */
const STUCK_SPEED = 1.6;

/** Two-circle collision proxy. */
const CIRCLE_OFFSET = 1.2; // metres fore/aft of the car origin
const CIRCLE_RADIUS = 0.95;
const CAR_RESTITUTION = 0.15;
/** Closing speed (m/s) below which a car-car touch is silent. */
const CONTACT_THRESHOLD = 0.4;
/** Minimum seconds between two contact events for one car. */
const CONTACT_COOLDOWN = 0.25;

/**
 * Contact response budget. A bump must never spin a car that was driving
 * straight: the velocity and yaw rate transferred to one car are capped, and
 * the caps only grow for genuinely heavy impacts.
 *
 * `cap = clamp(min + closingSpeed * perMps, min, max)`
 */
const CONTACT_DV_MIN = 0.45; // m/s of sideways velocity at a walking-pace touch
const CONTACT_DV_PER_MPS = 0.12;
const CONTACT_DV_MAX = 2.4;
const CONTACT_DYAW_MIN = 0.15; // rad/s of yaw at a walking-pace touch
const CONTACT_DYAW_PER_MPS = 0.03;
const CONTACT_DYAW_MAX = 1.0;
/** Softer lever arm so side swipes scrub rather than spin. */
const CONTACT_YAW_LEVER = 0.55;
/**
 * |normal · forward| above this means the hit is essentially longitudinal
 * (rear-end): the impulse goes straight through the CG, so no yaw kick.
 */
const CONTACT_LONGITUDINAL = 0.8;
/** Per-pass cap on positional separation so contacts never teleport a car. */
const MAX_SEPARATION_PER_PASS = 0.05;
const SEPARATION_PASSES = 2;
/** Total positional correction one car may receive from contacts per step (m). */
const MAX_SEPARATION_PER_STEP = 0.09;
/** Hard ceiling for any yaw rate edit made here. */
const COLLISION_MAX_YAW_RATE = 3.4;

/** Yaw inertia as a multiple of mass; keep in sync with car.js. */
const YAW_INERTIA_FACTOR = 1.7;

/** @param {number} value @param {number} fallback */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Recompute the cached forward/lateral speed and slip after a velocity edit.
 * @param {object} car
 */
function refreshCarSpeeds(car) {
  const sinH = Math.sin(car.heading);
  const cosH = Math.cos(car.heading);
  const speed = car.vx * sinH + car.vz * cosH;
  const latSpeed = car.vx * cosH - car.vz * sinH;
  car.speed = speed;
  car.latSpeed = latSpeed;
  car.slip = clamp01(Math.abs(latSpeed) / Math.max(4, Math.abs(speed)));
}

/* ---------------------------------------------------------- walls / kerbs -- */

/**
 * @typedef {{
 *   collided: boolean, intensity: number, stuck: boolean,
 *   events: {type:'scrape', intensity:number}[],
 * }} TrackCollision
 */

/**
 * Keep a car inside the track barrier, reflecting and scrubbing velocity.
 *
 * @param {object} car CarState (mutated)
 * @param {object} track built track from `buildTrack`
 * @param {number} dt fixed timestep in seconds
 * @returns {TrackCollision}
 */
export function resolveCarTrack(car, track, dt) {
  const events = [];
  const result = { collided: false, intensity: 0, stuck: false, events };
  if (!car || !track || typeof track.query !== 'function') return result;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 120;

  if (Number.isFinite(car._scrapeCooldown) && car._scrapeCooldown > 0) {
    car._scrapeCooldown = Math.max(0, car._scrapeCooldown - step);
  }

  const query = track.query(car.x, car.z, car.humpIndex);
  car.humpIndex = query.index;
  const limit = Math.max(2, track.boundary - WALL_CLEARANCE);
  const lateral = finiteOr(query.lateral, 0);
  const absLateral = Math.abs(lateral);

  if (absLateral <= limit) {
    // Away from the barrier: let the stuck timer decay.
    car._stuckTime = Math.max(0, finiteOr(car._stuckTime, 0) - step * 2);
    return result;
  }

  const side = lateral > 0 ? 1 : -1;
  const excess = absLateral - limit;

  // 1. Push the body back inside along the track's right vector.
  car.x -= side * query.rx * excess;
  car.z -= side * query.rz * excess;

  // 2. Split velocity into track-tangent and track-lateral components.
  const vLong = car.vx * query.tx + car.vz * query.tz;
  let vLat = car.vx * query.rx + car.vz * query.rz;
  const outward = vLat * side;
  const impact = Math.max(0, outward);
  const intensity = clamp01(impact / 16);

  // Reflect only the outward part, keeping any already-inward motion.
  if (outward > 0) vLat -= (1 + WALL_RESTITUTION) * outward * side;

  // Scrub forward speed: a glancing hit barely costs anything, a square one a
  // lot. Keep a floor so the car can always drive away from the barrier.
  const keep = 1 - 0.4 * clamp01(impact / 22);
  const longAfter = vLong * keep;

  car.vx = longAfter * query.tx + vLat * query.rx;
  car.vz = longAfter * query.tz + vLat * query.rz;
  car.yawRate = finiteOr(car.yawRate, 0) * (1 - 0.35 * clamp01(impact / 18));
  refreshCarSpeeds(car);

  // 3. Report the hit for audio (throttled per car).
  const cooldown = finiteOr(car._scrapeCooldown, 0);
  if (intensity > 0.02 && impact > WALL_SCRAPE_THRESHOLD && cooldown <= 0) {
    events.push({ type: 'scrape', intensity: Math.max(0.15, intensity) });
    car._scrapeCooldown = SCRAPE_COOLDOWN;
  }

  // 4. Stuck against the barrier with no speed: ask the race to recover it.
  const speed = Math.abs(finiteOr(car.speed, 0));
  car._stuckTime = speed < STUCK_SPEED ? finiteOr(car._stuckTime, 0) + step : 0;
  result.collided = true;
  result.intensity = intensity;
  result.stuck = car._stuckTime > STUCK_TIME;
  return result;
}

/* ---------------------------------------------------------------- car/car -- */

/**
 * World-space state of one collision circle.
 * @param {object} car
 * @param {number} offset longitudinal offset in metres (+ = front)
 */
function circleState(car, offset) {
  const sinH = Math.sin(car.heading);
  const cosH = Math.cos(car.heading);
  // Velocity at a body point offset along forward: v + yawRate * offset * right.
  return {
    x: car.x + sinH * offset,
    z: car.z + cosH * offset,
    vx: car.vx + finiteOr(car.yawRate, 0) * offset * cosH,
    vz: car.vz + finiteOr(car.yawRate, 0) * offset * -sinH,
    offset,
    sinH,
    cosH,
  };
}

/**
 * True when the two-car two-circle proxies overlap.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function carHitsCar(a, b) {
  if (!a || !b) return false;
  const minDistance = CIRCLE_RADIUS * 2;
  for (const offsetA of [CIRCLE_OFFSET, -CIRCLE_OFFSET]) {
    const ca = circleState(a, offsetA);
    for (const offsetB of [CIRCLE_OFFSET, -CIRCLE_OFFSET]) {
      const cb = circleState(b, offsetB);
      const dx = ca.x - cb.x;
      const dz = ca.z - cb.z;
      if (dx * dx + dz * dz < minDistance * minDistance) return true;
    }
  }
  return false;
}

/**
 * Deepest overlapping circle pair between two cars.
 *
 * @param {object} a
 * @param {object} b
 * @returns {null|{overlap:number, nx:number, nz:number, ca:object, cb:object}}
 */
function deepestContact(a, b) {
  const minDistance = CIRCLE_RADIUS * 2;
  const offsets = [CIRCLE_OFFSET, -CIRCLE_OFFSET];
  let best = null;
  for (let oa = 0; oa < 2; oa += 1) {
    const ca = circleState(a, offsets[oa]);
    for (let ob = 0; ob < 2; ob += 1) {
      const cb = circleState(b, offsets[ob]);
      const dx = ca.x - cb.x;
      const dz = ca.z - cb.z;
      const distance = Math.hypot(dx, dz);
      const overlap = minDistance - distance;
      if (overlap <= 0 || (best && overlap <= best.overlap)) continue;
      if (distance > 1e-5) {
        best = { overlap, nx: dx / distance, nz: dz / distance, ca, cb };
      } else {
        // Coincident centres: push along the car's own heading.
        best = { overlap, nx: Math.sin(a.heading), nz: Math.cos(a.heading), ca, cb };
      }
    }
  }
  return best;
}

/**
 * Resolve every overlapping car pair.
 *
 * The response is deliberately gentle and budgeted:
 * - bodies are separated in small steps (a car never teleports through a
 *   contact; deep overlaps resolve over a few frames),
 * - at most one velocity impulse is exchanged per pair per step,
 * - both the velocity and the yaw transfer are capped against the closing
 *   speed, and each car has a per-step budget so a car surrounded by several
 *   neighbours still cannot receive more than one bump's worth of sideways
 *   velocity or yaw,
 * - longitudinal hits (rear-ends) get no yaw kick because an impulse through
 *   the centre of gravity must not rotate the car.
 *
 * Deterministic: pairs are visited in array order and nothing here uses random
 * numbers.
 *
 * @param {object[]} cars CarState[] (mutated in place)
 * @returns {{type:'contact', carId:string, otherId:string, intensity:number}[]}
 */
export function resolveCarCar(cars) {
  const events = [];
  if (!Array.isArray(cars) || cars.length < 2) return events;
  const count = cars.length;

  // Snapshot + per-car budgets for this step.
  const start = new Array(count);
  const yawBudget = new Array(count).fill(0);
  const dvBudget = new Array(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    const car = cars[i];
    start[i] = car
      ? {
          x: car.x,
          z: car.z,
          vx: car.vx,
          vz: car.vz,
          yaw: finiteOr(car.yawRate, 0),
        }
      : null;
  }

  for (let i = 0; i < count; i += 1) {
    const a = cars[i];
    if (!a) continue;
    for (let j = i + 1; j < count; j += 1) {
      const b = cars[j];
      if (!b) continue;

      const massA = Math.max(200, finiteOr(a.spec && a.spec.mass, 1400));
      const massB = Math.max(200, finiteOr(b.spec && b.spec.mass, 1400));
      const invMassA = 1 / massA;
      const invMassB = 1 / massB;
      const invTotal = invMassA + invMassB;

      let impulseApplied = false;
      let closingSpeed = 0;
      let intensity = 0;

      for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
        const contact = deepestContact(a, b);
        if (!contact) break;

        // 1. Separate the bodies by a small, capped amount.
        const push = Math.min(contact.overlap, MAX_SEPARATION_PER_PASS);
        a.x += contact.nx * push * (invMassA / invTotal);
        a.z += contact.nz * push * (invMassA / invTotal);
        b.x -= contact.nx * push * (invMassB / invTotal);
        b.z -= contact.nz * push * (invMassB / invTotal);

        if (impulseApplied) continue;
        const { nx, nz, ca, cb } = contact;

        // 2. One velocity impulse per pair per step, only while closing.
        const relVx = ca.vx - cb.vx;
        const relVz = ca.vz - cb.vz;
        const closing = relVx * nx + relVz * nz; // negative = approaching
        if (closing >= 0) continue;
        closingSpeed = -closing;
        impulseApplied = true;

        // Cap the sideways velocity each car can receive from this contact.
        const dvCap = clamp(
          CONTACT_DV_MIN + closingSpeed * CONTACT_DV_PER_MPS,
          CONTACT_DV_MIN,
          CONTACT_DV_MAX,
        );
        dvBudget[i] = Math.max(dvBudget[i], dvCap);
        dvBudget[j] = Math.max(dvBudget[j], dvCap);

        const impulseMax = dvCap / Math.max(invMassA, invMassB);
        const impulse = Math.min((1 + CAR_RESTITUTION) * closingSpeed / invTotal, impulseMax);

        a.vx += nx * impulse * invMassA;
        a.vz += nz * impulse * invMassA;
        b.vx -= nx * impulse * invMassB;
        b.vz -= nz * impulse * invMassB;

        // 3. Yaw kick, only when the contact normal is substantially sideways.
        const forwardA = Math.abs(nx * Math.sin(a.heading) + nz * Math.cos(a.heading));
        if (forwardA < CONTACT_LONGITUDINAL) {
          const dyawCap = clamp(
            CONTACT_DYAW_MIN + closingSpeed * CONTACT_DYAW_PER_MPS,
            CONTACT_DYAW_MIN,
            CONTACT_DYAW_MAX,
          );
          yawBudget[i] = Math.max(yawBudget[i], dyawCap);
          yawBudget[j] = Math.max(yawBudget[j], dyawCap);

          const leverA = ca.offset * (ca.cosH * nx - ca.sinH * nz);
          const leverB = cb.offset * (cb.cosH * nx - cb.sinH * nz);
          const kickA = clamp(
            (leverA * impulse * CONTACT_YAW_LEVER) / (massA * YAW_INERTIA_FACTOR),
            -dyawCap,
            dyawCap,
          );
          const kickB = clamp(
            (leverB * impulse * CONTACT_YAW_LEVER) / (massB * YAW_INERTIA_FACTOR),
            -dyawCap,
            dyawCap,
          );
          a.yawRate = clamp(
            finiteOr(a.yawRate, 0) + kickA,
            -COLLISION_MAX_YAW_RATE,
            COLLISION_MAX_YAW_RATE,
          );
          b.yawRate = clamp(
            finiteOr(b.yawRate, 0) - kickB,
            -COLLISION_MAX_YAW_RATE,
            COLLISION_MAX_YAW_RATE,
          );
        }

        intensity = clamp01(closingSpeed / 12);
      }

      // 4. Throttled contact event for audio/HUD.
      if (impulseApplied && closingSpeed > CONTACT_THRESHOLD) {
        const cooldownA = finiteOr(a._contactCooldown, 0);
        const cooldownB = finiteOr(b._contactCooldown, 0);
        if (cooldownA <= 0 || cooldownB <= 0) {
          events.push({
            type: 'contact',
            carId: a.id,
            otherId: b.id,
            intensity: Math.max(0.2, intensity),
          });
          a._contactCooldown = CONTACT_COOLDOWN;
          b._contactCooldown = CONTACT_COOLDOWN;
        }
      }
    }
  }

  // Enforce the per-car budgets: one step of contacts can never stack into a
  // spin or a teleport, no matter how many neighbours are touching.
  for (let i = 0; i < count; i += 1) {
    const car = cars[i];
    const before = start[i];
    if (!car || !before) continue;
    let moved = false;

    const yawCap = yawBudget[i];
    if (yawCap > 0) {
      const delta = finiteOr(car.yawRate, 0) - before.yaw;
      if (Math.abs(delta) > yawCap) {
        car.yawRate = clamp(
          before.yaw + Math.sign(delta) * yawCap,
          -COLLISION_MAX_YAW_RATE,
          COLLISION_MAX_YAW_RATE,
        );
        moved = true;
      }
    }

    const dvCap = dvBudget[i];
    if (dvCap > 0) {
      const dx = finiteOr(car.vx, 0) - before.vx;
      const dz = finiteOr(car.vz, 0) - before.vz;
      const magnitude = Math.hypot(dx, dz);
      if (magnitude > dvCap) {
        const scale = dvCap / magnitude;
        car.vx = before.vx + dx * scale;
        car.vz = before.vz + dz * scale;
        moved = true;
      }
    }

    const pushX = finiteOr(car.x, before.x) - before.x;
    const pushZ = finiteOr(car.z, before.z) - before.z;
    const pushMagnitude = Math.hypot(pushX, pushZ);
    if (pushMagnitude > MAX_SEPARATION_PER_STEP) {
      const scale = MAX_SEPARATION_PER_STEP / pushMagnitude;
      car.x = before.x + pushX * scale;
      car.z = before.z + pushZ * scale;
      moved = true;
    }

    if (moved) refreshCarSpeeds(car);
    else if (dvCap === 0) {
      // Nothing touched this car; leave it exactly as the sim left it.
    }
  }

  // Age the contact cooldowns once per call (not per pair) for stability.
  for (let i = 0; i < count; i += 1) {
    const car = cars[i];
    if (!car) continue;
    const cooldown = finiteOr(car._contactCooldown, 0);
    if (cooldown > 0) {
      car._contactCooldown = Math.max(0, cooldown - 1 / 120);
    } else if (cooldown !== 0) {
      car._contactCooldown = 0;
    }
  }

  return events;
}
