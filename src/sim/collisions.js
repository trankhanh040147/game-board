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
 * Resolve every overlapping car pair. Deterministic: pairs are visited in
 * array order and the deepest circle pair of each contact is handled once.
 *
 * @param {object[]} cars CarState[] (mutated in place)
 * @returns {{type:'contact', carId:string, otherId:string, intensity:number}[]}
 */
export function resolveCarCar(cars) {
  const events = [];
  if (!Array.isArray(cars) || cars.length < 2) return events;

  const minDistance = CIRCLE_RADIUS * 2;
  const offsets = [CIRCLE_OFFSET, -CIRCLE_OFFSET];

  for (let i = 0; i < cars.length; i += 1) {
    const a = cars[i];
    if (!a) continue;
    for (let j = i + 1; j < cars.length; j += 1) {
      const b = cars[j];
      if (!b) continue;

      // Find the deepest overlap among the four circle pairs. Two separation
      // passes are used so a deep (spawn/teleport) overlap still resolves.
      for (let pass = 0; pass < 2; pass += 1) {
      let bestOverlap = 0;
      let nx = 0;
      let nz = 0;
      let ca = null;
      let cb = null;
      for (let oa = 0; oa < 2; oa += 1) {
        const circleA = circleState(a, offsets[oa]);
        for (let ob = 0; ob < 2; ob += 1) {
          const circleB = circleState(b, offsets[ob]);
          const dx = circleA.x - circleB.x;
          const dz = circleA.z - circleB.z;
          const distance = Math.hypot(dx, dz);
          const overlap = minDistance - distance;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            if (distance > 1e-5) {
              nx = dx / distance;
              nz = dz / distance;
            } else {
              nx = Math.sin(a.heading);
              nz = Math.cos(a.heading);
            }
            ca = circleA;
            cb = circleB;
          }
        }
      }
      if (!ca || !cb || bestOverlap <= 0) continue;

      // 1. Separate the bodies, weighted by mass.
      const invMassA = 1 / Math.max(200, finiteOr(a.spec && a.spec.mass, 1400));
      const invMassB = 1 / Math.max(200, finiteOr(b.spec && b.spec.mass, 1400));
      const invTotal = invMassA + invMassB;
      const pushA = bestOverlap * (invMassA / invTotal);
      const pushB = bestOverlap * (invMassB / invTotal);
      a.x += nx * pushA;
      a.z += nz * pushA;
      b.x -= nx * pushB;
      b.z -= nz * pushB;
      if (pass === 0) {
      // 2. Exchange a velocity impulse if they are still closing.
      const relVx = ca.vx - cb.vx;
      const relVz = ca.vz - cb.vz;
      const closing = relVx * nx + relVz * nz; // negative = approaching
      let intensity = 0;
      if (closing < 0) {
        const impulse = (-(1 + CAR_RESTITUTION) * closing) / invTotal;
        a.vx += nx * impulse * invMassA;
        a.vz += nz * impulse * invMassA;
        b.vx -= nx * impulse * invMassB;
        b.vz -= nz * impulse * invMassB;

        // Yaw kick: the impulse lands off-centre, so it spins both cars a bit.
        const leverA = ca.offset * (ca.cosH * nz - ca.sinH * nx);
        const leverB = cb.offset * (cb.cosH * nz - cb.sinH * nx);
        const inertiaA = Math.max(200, finiteOr(a.spec && a.spec.mass, 1400)) * YAW_INERTIA_FACTOR;
        const inertiaB = Math.max(200, finiteOr(b.spec && b.spec.mass, 1400)) * YAW_INERTIA_FACTOR;
        a.yawRate = clamp(
          finiteOr(a.yawRate, 0) + (leverA * impulse) / inertiaA,
          -3.4,
          3.4,
        );
        b.yawRate = clamp(
          finiteOr(b.yawRate, 0) - (leverB * impulse) / inertiaB,
          -3.4,
          3.4,
        );
        intensity = clamp01(-closing / 12);
      }

      refreshCarSpeeds(a);
      refreshCarSpeeds(b);

      // 3. Emit a throttled contact event off the most significant car.
      if (-closing > CONTACT_THRESHOLD) {
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
    }
  }

  // Age the contact cooldowns once per call (not per pair) for stability.
  for (let i = 0; i < cars.length; i += 1) {
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
