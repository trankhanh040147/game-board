/**
 * Opponent drivers.
 *
 * Each AI is a tiny deterministic state machine around two ideas:
 * - **Pure pursuit steering** towards a point `12 + speed*0.35` m ahead on a
 *   racing line (lane bias + outside-in line through corners + car avoidance).
 *   The required road-wheel angle comes from the pursuit geometry, then gets
 *   divided by the car's current speed-sensitive lock so it can be fed back as
 *   the same `steer` input the player uses.
 * - **Speed planning** from `track.curvatureAhead`: for a handful of lookahead
 *   distances the corner speed `v = sqrt(aLat / |curvature|)` is lifted by the
 *   braking distance available (`v² = vc² + 2·b·d`); the minimum is the target.
 *
 * Mistakes and the occasional handbrake flick are driven by `createRng` seeded
 * from the driver id — never `Math.random` — so a race replays identically.
 */

import { clamp, clamp01, damp, wrapAngle } from '../core/math.js';
import { hashString, createRng } from '../core/rng.js';
import { AI_TUNING } from './config.js';
import { carSteerLimit } from './car.js';

const GRAVITY = 9.81;
const WHEELBASE = 2.7;

/** Pace of a perfect driver before `spec.topSpeed` is applied. */
const PACE_FLOOR = 0.45;
/** How far ahead corner speeds are sampled (m). */
const LOOKAHEAD_STEPS = 8;
const LOOKAHEAD_FIRST = 0;
const LOOKAHEAD_STEP = 13;
/** Deceleration assumed when planning braking points (m/s²). */
const PLAN_BRAKE_DECEL = 8.2;
/** Lateral grip usage for corner-speed planning, as a fraction of grip·g. */
const CORNER_GRIP_USE = 0.92;
/** Pure-pursuit steering gain (1 = pure kinematic pursuit, lower = calmer). */
const PURSUIT_GAIN = 0.85;
/** Time constant for the smoothed speed target (smooths brake/throttle sign). */
const TARGET_SPEED_DAMP = 2.4;
/** Rubber band is capped to this fraction of pace, so it never looks silly. */
const MAX_RUBBER_BAND = 0.08;
/** Lateral offset range kept inside the drivable road (m). */
const EDGE_MARGIN = 1.3;

/**
 * Launch etiquette: for this long after GO every AI holds the lane it starts
 * in instead of cutting to the racing line, so the grid does not converge into
 * the player's car in the first seconds of a race.
 */
const LAUNCH_HOLD_TIME = 2;
/** A car this far fore/aft and this far sideways counts as side-by-side. */
const SIDE_GUARD_ALONG = 6.5;
const SIDE_GUARD_WIDTH = 2.3;
/** Steering authority kept when a neighbour is alongside on that side. */
const SIDE_GUARD_CUT = 0.25;
/** Nudge applied away from a side-by-side neighbour (normalised steer). */
const SIDE_GUARD_NUDGE = 0.1;

/** @param {number} value @param {number} fallback */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * O(1) sample of the track centreline by arc length.
 *
 * `track.samples` is a public part of the track contract, so the AI indexes it
 * directly instead of going through `track.pointAt()`; the AI runs this many
 * times per car per step and `pointAt` is comparatively expensive.
 *
 * @param {object} track
 * @param {number} s arc length, wraps
 * @returns {{x:number,z:number,rx:number,rz:number,tx:number,tz:number,curvature:number,heading:number}}
 */
function sampleTrack(track, s) {
  const samples = track.samples;
  const count = samples.length;
  const length = track.length;
  let wrapped = s % length;
  if (wrapped < 0) wrapped += length;
  const exact = (count * wrapped) / length;
  const base = Math.floor(exact);
  const index = base % count;
  const t = exact - base;
  const a = samples[index];
  const b = samples[(index + 1) % count];
  const tx = a.tx + (b.tx - a.tx) * t;
  const tz = a.tz + (b.tz - a.tz) * t;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    rx: a.rx + (b.rx - a.rx) * t,
    rz: a.rz + (b.rz - a.rz) * t,
    tx,
    tz,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
    heading: Math.atan2(tx, tz),
  };
}

/**
 * Worst (largest magnitude) curvature over the next `metres`, using O(1)
 * centreline sampling.
 *
 * @param {object} track
 * @param {number} s
 * @param {number} metres
 * @returns {number} signed curvature with the largest magnitude
 */
function worstCurvature(track, s, metres) {
  const spacing = Math.max(1, track.spacing || 3.5);
  const steps = Math.max(1, Math.round(metres / spacing));
  let worst = 0;
  for (let i = 0; i <= steps; i += 1) {
    const curvature = sampleTrack(track, s + (i * metres) / steps).curvature;
    if (Math.abs(curvature) > Math.abs(worst)) worst = curvature;
  }
  return worst;
}

/**
 * @typedef {{
 *   id: string, spec: object, skill: number, laneBias: number,
 *   rng: ReturnType<typeof createRng>, seed: number,
 *   offset: number, mistakeTimer: number, mistakeAmp: number, mistakePhase: number,
 *   wobblePhase: number, handbrakeTimer: number, handbrakeCooldown: number,
 * }} AiDriver
 */

/**
 * Build an AI driver.
 *
 * @param {{spec: object, skill?: number, laneBias?: number, id?: string, seed?: number}} options
 * @returns {AiDriver}
 */
export function createAiDriver(options = {}) {
  const id = options.id ?? 'ai';
  const skill = clamp(finiteOr(options.skill, 0.8), 0.2, 1);
  const seed = Number.isFinite(options.seed)
    ? options.seed >>> 0
    : (hashString(`${id}:${Math.round(skill * 1000)}`) ^ 0x9e3779b9) >>> 0;
  const rng = createRng(seed);
  const ai = {
    id,
    spec: options.spec,
    skill,
    laneBias: clamp(finiteOr(options.laneBias, 0), -1, 1),
    rng,
    seed,
    /** Smoothed lateral offset target, metres from the centreline. */
    offset: 0,
    /** Lane captured at GO, held during the launch (metres from centreline). */
    launchLane: null,
    /** Smoothed speed target; keeps throttle/brake from sawtoothing. */
    targetSpeed: 0,
    mistakeTimer: 0,
    mistakeAmp: 0,
    mistakePhase: 0,
    wobblePhase: rng.range(0, Math.PI * 2),
    handbrakeTimer: 0,
    handbrakeCooldown: rng.range(2, 6),
    nitroHeld: false,
  };
  return ai;
}

/**
 * Convert a desired road-wheel angle into the normalised steering input the car
 * accepts (accounting for the car's speed-sensitive lock).
 *
 * @param {object} car
 * @param {number} steerAngle rad
 * @returns {number} -1..1
 */
function steerAngleToInput(car, steerAngle) {
  const limit = Math.max(1e-3, carSteerLimit(car));
  return clamp(steerAngle / limit, -1, 1);
}

/**
 * Planned speed for the next few dozen metres.
 *
 * @param {object} car
 * @param {object} track
 * @param {number} s current arc length
 * @param {number} speed m/s
 * @param {number} maxLat maximum lateral acceleration for this driver (m/s²)
 * @param {number} speedCap absolute cap (m/s)
 * @param {number} nowCurvature curvature under the car right now
 * @returns {number} target speed m/s
 */
function planSpeed(car, track, s, speed, maxLat, speedCap, nowCurvature) {
  let target = speedCap;
  // Look further ahead the faster we are going, so braking points scale up.
  for (let i = 0; i < LOOKAHEAD_STEPS; i += 1) {
    const distance = LOOKAHEAD_FIRST + i * LOOKAHEAD_STEP;
    const curvature = Math.abs(worstCurvature(track, s + distance, LOOKAHEAD_STEP));
    if (curvature < 1e-5) continue;
    const cornerSpeed = Math.sqrt(maxLat / curvature);
    const allowed = Math.sqrt(cornerSpeed * cornerSpeed + 2 * PLAN_BRAKE_DECEL * distance);
    if (allowed < target) target = allowed;
  }
  // Already in the middle of a corner: never target more than it can hold.
  const latCurv = Math.abs(nowCurvature);
  if (latCurv > 1e-5) {
    const now = Math.sqrt(maxLat / latCurv);
    if (now < target) target = Math.max(now, target * 0.4);
  }
  return clamp(target, 4, speedCap);
}

/**
 * One AI decision tick. Pure: reads state, returns an input struct.
 *
 * @param {AiDriver} ai
 * @param {object} car CarState (read only)
 * @param {object} track built track
 * @param {object|null} race race state (for rubber-banding and car avoidance)
 * @param {number} dt fixed timestep
 * @returns {{throttle:number, steer:number, handbrake:boolean, nitro:boolean}}
 */
export function aiInput(ai, car, track, race, dt) {
  /** @type {{throttle:number, steer:number, handbrake:boolean, nitro:boolean}} */
  const idle = { throttle: 0, steer: 0, handbrake: false, nitro: false };
  if (!ai || !car || !track || typeof track.query !== 'function') return idle;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 120;

  const spec = car.spec || ai.spec || {};
  const query = track.query(car.x, car.z, car.humpIndex);
  const speed = Math.abs(finiteOr(car.speed, 0));
  const halfWidth = finiteOr(track.halfWidth, 7.5);
  const drivable = Math.max(1, halfWidth - EDGE_MARGIN);
  const skill = clamp01(ai.skill);
  /** Grip available from the surface under the car right now (0..1). */
  const surfaceGrip = car.surface === 'grass' ? 0.55 : car.surface === 'kerb' ? 0.85 : 1;

  // Remember the lane this car starts in and hold it during the launch.
  if (!Number.isFinite(ai.launchLane)) {
    ai.launchLane = clamp(query.lateral, -drivable, drivable);
  }
  const launchHold =
    !!race && Number.isFinite(race.time) && race.time < LAUNCH_HOLD_TIME;

  /* -- racing line -------------------------------------------------------- */
  const lookahead = clamp(12 + speed * 0.35, 10, 46);
  const aheadS = query.s + lookahead * 0.5;
  const curvatureAtAhead = sampleTrack(track, aheadS).curvature;
  const curvatureAhead = worstCurvature(track, aheadS, 26);
  const cornerStrength = clamp01(Math.abs(curvatureAhead) * 55);
  // Sign comes from the curvature under the target point so the line does not
  // flip sides every sample; magnitude comes from the worst curvature ahead.
  const lineTarget = launchHold
    ? 0
    : Math.sign(curvatureAtAhead) * halfWidth * 0.34 * cornerStrength;

  // Traffic awareness:
  // - cars ahead bias the target line away from them,
  // - cars alongside suppress steering into them (so a launch cannot sideswipe),
  // - a slower car directly ahead caps our speed so we do not rear-end it.
  let avoid = 0;
  let sideGuard = 0;
  let followSpeed = Infinity;
  if (race && Array.isArray(race.cars)) {
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    for (let i = 0; i < race.cars.length; i += 1) {
      const other = race.cars[i];
      if (!other || other === car) continue;
      const dx = other.x - car.x;
      const dz = other.z - car.z;
      const along = dx * sinH + dz * cosH;
      const side = dx * cosH - dz * sinH;
      const absAlong = Math.abs(along);
      const absSide = Math.abs(side);

      if (absAlong < SIDE_GUARD_ALONG && absSide < SIDE_GUARD_WIDTH) {
        // Side-by-side: away = -1 to the left, +1 to the right.
        const away = side >= 0 ? -1 : 1;
        const proximity =
          (1 - absAlong / SIDE_GUARD_ALONG) * (1 - absSide / SIDE_GUARD_WIDTH);
        sideGuard += away * (0.35 + 0.65 * proximity);
      }

      if (along > 1 && along < AI_TUNING.avoidRadius * 1.6 && absSide < 1.5) {
        const otherSpeed = Math.abs(finiteOr(other.speed, 0));
        if (speed > otherSpeed + 1.5) {
          followSpeed = Math.min(followSpeed, otherSpeed + 2);
        }
      }

      if (launchHold) continue;
      if (along <= 0.5 || along > AI_TUNING.avoidRadius * 2.2) continue;
      if (absSide > 2.8) continue;
      const urgency = 1 - clamp01(along / (AI_TUNING.avoidRadius * 2.2));
      avoid -= Math.sign(side || 1) * 1.8 * urgency;
    }
  }

  const cruiseOffset = ai.laneBias * (halfWidth - 2) + lineTarget + avoid;
  const offsetTarget = clamp(
    launchHold ? ai.launchLane : cruiseOffset,
    -drivable,
    drivable,
  );
  ai.offset = damp(ai.offset, offsetTarget, launchHold ? 8 : AI_TUNING.laneChangeRate * 8, step);

  /* -- pure pursuit steering --------------------------------------------- */
  const targetPoint = sampleTrack(track, query.s + lookahead);
  const targetX = targetPoint.x + targetPoint.rx * ai.offset;
  const targetZ = targetPoint.z + targetPoint.rz * ai.offset;
  const dx = targetX - car.x;
  const dz = targetZ - car.z;
  const distance = Math.max(1, Math.hypot(dx, dz));
  const alpha = wrapAngle(Math.atan2(dx, dz) - car.heading);
  const sinAlpha = Math.sin(alpha);
  const steerAngle = Math.atan2(2 * WHEELBASE * sinAlpha, distance) * PURSUIT_GAIN;
  const kinematicInput = steerAngleToInput(car, steerAngle);

  // The kinematic bicycle angle under-steers badly once the tyres are near
  // their limit (which is where an arcade car spends its life), so also ask for
  // the fraction of the grip budget the pursuit curvature needs and take the
  // larger of the two demands.
  const curvatureDemand = (2 * sinAlpha) / distance;
  const lateralDemand = speed * speed * Math.abs(curvatureDemand);
  const usableLat = Math.max(2, finiteOr(spec.grip, 1) * GRAVITY * 0.85 * surfaceGrip);
  const gripInput = clamp(lateralDemand / usableLat, 0, 1);
  const magnitude = Math.max(Math.abs(kinematicInput), gripInput);
  let steer = (alpha >= 0 ? 1 : -1) * magnitude;

  // Never steer into a car that is alongside: cut steering towards it and add a
  // small nudge away, so grid launches cannot sideswipe the player.
  if (sideGuard !== 0) {
    const guard = clamp(sideGuard, -1, 1);
    if (steer * guard < 0) steer *= SIDE_GUARD_CUT;
    steer += guard * SIDE_GUARD_NUDGE;
  }

  // Heading error is also used to scrub speed if the car is pointed wrong.
  const headingError = Math.abs(alpha);

  /* -- speed planning ----------------------------------------------------- */
  const maxLat =
    finiteOr(spec.grip, 1) *
    GRAVITY *
    AI_TUNING.cornering *
    (0.55 + 0.45 * skill) *
    CORNER_GRIP_USE *
    surfaceGrip;

  // Rubber band: ±8% of pace based on progress relative to the player.
  let rubber = 1;
  if (race && Array.isArray(race.standings) && race.track) {
    const length = Math.max(1, race.track.length);
    let playerProgress = null;
    let selfProgress = null;
    for (let i = 0; i < race.standings.length; i += 1) {
      const entry = race.standings[i];
      if (!entry) continue;
      if (entry.isPlayer) playerProgress = finiteOr(entry.progress, 0) * length;
      else if (entry.carId === car.id) selfProgress = finiteOr(entry.progress, 0) * length;
    }
    if (playerProgress != null && selfProgress != null) {
      const ahead = selfProgress - playerProgress; // >0: AI is in front
      const band = clamp(ahead / 160, -1, 1) * MAX_RUBBER_BAND * clamp01(AI_TUNING.rubberBand / 0.12);
      rubber = 1 - band;
    }
  }

  const skillPace = PACE_FLOOR + (1 - PACE_FLOOR) * skill;
  const speedCap = finiteOr(spec.topSpeed, 70) * AI_TUNING.pace * skillPace * rubber;
  const nowCurvature = worstCurvature(track, query.s, 18);
  const planned = planSpeed(car, track, query.s, speed, maxLat, speedCap, nowCurvature);
  const smoothed =
    ai.targetSpeed > 0 ? damp(ai.targetSpeed, planned, TARGET_SPEED_DAMP, step) : planned;
  // Never smooth past the hard limit for the corner the car is in right now.
  const hardLimit = Math.sqrt(maxLat / Math.max(1e-4, Math.abs(nowCurvature) + 1e-4));
  let targetSpeed = Math.min(smoothed, Math.max(hardLimit * 1.35, planned * 0.6));
  if (followSpeed < targetSpeed) targetSpeed = followSpeed;
  ai.targetSpeed = targetSpeed;

  /* -- mistakes (seeded, deterministic) ----------------------------------- */
  ai.mistakeTimer -= step;
  let mistakeBrake = 0;
  if (ai.mistakeAmp > 0) {
    // Fumble in progress: a little steering wobble and an early brake.
    steer += Math.sin(ai.mistakePhase) * ai.mistakeAmp;
    mistakeBrake = 0.1;
    ai.mistakePhase += step * 12;
    if (ai.mistakeTimer <= 0) {
      ai.mistakeAmp = 0;
      ai.mistakeTimer = ai.rng.range(1.5, 3.5);
    }
  } else if (ai.mistakeTimer <= 0) {
    // The worse the driver, the more often it fumbles.
    if (ai.rng.next() < 0.35 * (1 - skill)) {
      ai.mistakeTimer = ai.rng.range(0.35, 0.9);
      ai.mistakeAmp = ai.rng.range(0.05, 0.16) * (1 - skill * 0.6);
      ai.mistakePhase = ai.rng.range(0, Math.PI * 2);
    } else {
      ai.mistakeTimer = 0.5; // roll again shortly
    }
  }

  // A permanent tiny wobble scaled by inexperience keeps the pack alive.
  const wobble = Math.sin(ai.wobblePhase) * 0.012 * (1 - skill);
  ai.wobblePhase += step * 2.3;
  steer += wobble;

  /* -- handbrake + nitro -------------------------------------------------- */
  ai.handbrakeCooldown -= step;
  if (ai.handbrakeTimer > 0) {
    ai.handbrakeTimer -= step;
  } else if (
    ai.handbrakeCooldown <= 0 &&
    skill > 0.8 &&
    Math.abs(curvatureAhead) > 0.045 &&
    speed > 17 &&
    speed > targetSpeed * 1.25
  ) {
    ai.handbrakeTimer = 0.22;
    ai.handbrakeCooldown = ai.rng.range(4, 9);
  }
  const handbrake = ai.handbrakeTimer > 0;

  // Nitrous is held with hysteresis so it cannot chatter around a threshold.
  if (ai.nitroHeld) {
    if (car.nitro < 12) ai.nitroHeld = false;
  } else if (car.nitro > 65 && Math.abs(curvatureAhead) < 0.01 && speed > 15) {
    ai.nitroHeld = true;
  }
  const nitro =
    ai.nitroHeld && !handbrake && speed > speedCap * 0.55 && Math.abs(curvatureAhead) < 0.01;

  /* -- throttle / brake --------------------------------------------------- */
  const speedError = targetSpeed - speed;
  let throttle = 0;
  if (speedError > 0.4) {
    throttle = clamp(0.45 + speedError / 7, 0, 1);
  }
  let brake = 0;
  if (speed > targetSpeed + 0.8) {
    brake = clamp((speed - targetSpeed) / 4.5, 0, 1);
  }
  if (headingError > 0.55 && speed > 12) {
    // Pointed badly at the road: lift and let the front recover.
    throttle *= 0.4;
    brake = Math.max(brake, 0.15);
  }
  brake = Math.max(brake, mistakeBrake);

  return {
    throttle: clamp(throttle - brake, -1, 1),
    steer: clamp(steer, -1, 1),
    handbrake,
    nitro,
  };
}
