/**
 * Arcade vehicle dynamics — a slip-angle bicycle model tuned for NFS-style
 * drifting rather than lap-time realism.
 *
 * Frame conventions (see `docs/CONTRACT.md`):
 * - `forward = (sin(heading), 0, cos(heading))`
 * - `right   = (cos(heading), 0, -sin(heading))`
 * - a positive `yawRate` turns the car to its right (heading increases).
 *
 * Internally the car works in its own body frame:
 * - `u` = forward speed (exported as `car.speed`),
 * - `v` = lateral speed, positive towards the car's right,
 * - `yawRate` = angular velocity about +Y.
 *
 * Model, in the order forces are resolved each step:
 * 1. Front/rear slip angles from the wheel-frame contact-patch velocities.
 * 2. Lateral forces from a tanh tyre curve with a post-peak drop-off, clamped by
 *    a friction budget derived from `spec.grip` and the surface. The rear
 *    budget is cut hard by the handbrake, which is what starts a drift.
 * 3. A friction-circle clamp on the longitudinal force: once the tyres are busy
 *    sideways the engine cannot also accelerate (drifting scrubs speed).
 * 4. A small self-aligning yaw assist so big slides are catchable — a 2-DOF
 *    bicycle model on its own has no caster/pneumatic-trail stabiliser.
 *
 * Ground: the car is glued to the road surface (no airtime). `y` is the ground
 * contact height, matching `createCarBodyMesh`'s origin at ground contact.
 *
 * Everything is deterministic and Math.random-free: the same inputs produce the
 * same trajectory on every run, at any fixed dt. All state is clamped and
 * sanitised so the simulation can never emit NaN/Infinity.
 */

import { clamp, clamp01, damp, moveTowards, wrapAngle } from '../core/math.js';
import { CAR_ORDER, CAR_SPECS, NITRO, SURFACE_GRIP } from './config.js';

/* ------------------------------------------------------------ constants -- */

const GRAVITY = 9.81;

/** Wheelbase plus the CG split used by the bicycle model (48/52 front/rear). */
const WHEELBASE = 2.7;
const CG_TO_FRONT = 1.3;
const CG_TO_REAR = WHEELBASE - CG_TO_FRONT;
const FRONT_GRIP_SHARE = 0.52;

/** Yaw inertia as a multiple of mass (kg·m²); ~1.7 suits a ~4.4 m car. */
const YAW_INERTIA_FACTOR = 1.7;

/** Slip angle (rad) where each axle reaches its friction budget. */
const TYRE_PEAK_SLIP_FRONT = 0.12;
const TYRE_PEAK_SLIP_REAR = 0.15;

/**
 * Past the peak the force falls away again (real tyres do this at 15–25°).
 * The steered front works at far larger slip angles than the rear, so its
 * fall-off is stronger: that differential is the car's self-aligning tendency.
 */
const POST_PEAK_DROP_FRONT = 0.4;
const POST_PEAK_DROP_REAR = 0.1;
const POST_PEAK_RANGE = 0.55;

/** Lateral force fades out below walking pace so a parked car cannot pivot. */
const TYRE_FADE_START = 0.5;
const TYRE_FADE_END = 3.0;

/** Softens the slip-angle atan2 near zero contact-patch speed. */
const TYRE_SLIP_EPSILON = 0.5;

/** Small physical yaw damping; the slip angles do most of the damping. */
const YAW_DAMPING = 0.18;

/**
 * Self-aligning assist: a restoring yaw moment proportional to body sideslip
 * past `ALIGN_DEADZONE`, scaled down while the handbrake is held.
 */
const ALIGN_DEADZONE = 0.2; // rad of body sideslip before the assist wakes up
const ALIGN_RATE = 24; // rad/s² of restoring yaw acceleration per rad² of excess
const ALIGN_DAMP = 1; // rad/s² per rad/s of sideslip growth (stops over-correction)
const HANDBRAKE_ALIGN = 0.18;
const MAX_YAW_ACCEL = 14; // rad/s² sanity ceiling

/**
 * Speed-sensitive steering: lock authority halves at `STEER_FALLOFF` m/s.
 * Without this the front tyre is asked for a slip angle far past its grip at
 * speed, which turns a hard corner into an instant spin.
 */
const STEER_FALLOFF = 16;

/**
 * `spec.aero` is authored as a drag-area coefficient, but the engine power
 * curve would otherwise cap top speed below `spec.topSpeed` for the heavier
 * cars. Scaling it down leaves the soft limiter as the thing that defines top
 * speed, which is what the garage numbers promise.
 */
const AERO_SCALE = 0.42;

const ROLLING_DECEL = 0.35; // m/s², always present while moving
const COAST_DECEL = 1.05; // engine braking when off the throttle, m/s²
const SLIP_SCRUB = 0.12; // extra longitudinal decel per m/s of lateral velocity

const REVERSE_TOP_SPEED = 10; // m/s
const REVERSE_ACCEL = 4.2; // m/s²
const HANDBRAKE_REAR_GRIP = 0.3;

const MAX_YAW_RATE = 3.4; // rad/s — hard sanity ceiling
const MAX_LATERAL_SPEED = 45; // m/s — hard sanity ceiling
const MAX_SPEED_FACTOR = 1.35; // hard ceiling as a multiple of spec.topSpeed

/** Ground contact height offset; matches the car mesh origin (tyres on tarmac). */
const RIDE_HEIGHT = 0;

const GEAR_CURVE = 0.9;
const GEAR_HYSTERESIS = 0.012;
const GEAR_IDLE_RPM = 0.16;

/* -------------------------------------------------------------- helpers -- */

/** @param {unknown} value @param {number} fallback */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Accept a car id, a CarSpec object or nothing.
 * @param {string|object|undefined} spec
 * @returns {object}
 */
function resolveSpec(spec) {
  if (typeof spec === 'string' && CAR_SPECS[spec]) return CAR_SPECS[spec];
  if (spec && typeof spec === 'object' && Number.isFinite(spec.mass)) return spec;
  return CAR_SPECS[CAR_ORDER[0]];
}

/**
 * Grip multiplier once an axle is pushed past its peak slip angle.
 * @param {number} slipAngle rad
 * @param {number} peakSlip rad
 * @param {number} postPeakDrop fraction of grip lost at peak+POST_PEAK_RANGE
 * @returns {number} 1 at the peak, falling towards `1 - postPeakDrop`
 */
function tyreDropOff(slipAngle, peakSlip, postPeakDrop) {
  const magnitude = Math.abs(slipAngle);
  return 1 - postPeakDrop * clamp01((magnitude - peakSlip) / POST_PEAK_RANGE);
}

/**
 * Force generated by an axle at a given slip angle: rises to the friction
 * budget, saturates, then falls away past the peak.
 *
 * @param {number} maxForce friction budget in newtons
 * @param {number} slipAngle rad, positive when the contact patch slides right
 * @param {number} peakSlip rad where the axle reaches `maxForce`
 * @param {number} postPeakDrop fraction of grip lost at peak+POST_PEAK_RANGE
 * @returns {number} lateral force in newtons (opposes the slip)
 */
function tyreLateral(maxForce, slipAngle, peakSlip, postPeakDrop) {
  if (!(maxForce > 0) || slipAngle === 0) return 0;
  const magnitude = Math.abs(slipAngle);
  const curve = Math.tanh(magnitude / peakSlip);
  return -maxForce * Math.sign(slipAngle) * curve * tyreDropOff(slipAngle, peakSlip, postPeakDrop);
}

/** @typedef {{type:'offtrack'|'nitro'|'shift'|'land'|'scrape', intensity?:number}} CarEvent */

/**
 * @typedef {{
 *   id: string, spec: object, palette: object|null, isPlayer: boolean,
 *   x: number, y: number, z: number, heading: number,
 *   vx: number, vz: number, yawRate: number,
 *   steer: number, throttle: number, brake: number, handbrake: boolean,
 *   nitro: number, boosting: boolean, speed: number, slip: number,
 *   onTrack: boolean, surface: 'road'|'kerb'|'grass', humpIndex: number,
 *   latSpeed: number, steerAngle: number, gear: number, rpm01: number,
 * }} CarState
 */

/**
 * Create a car sitting on the ground at `position`, facing `heading`.
 *
 * @param {{
 *   id?: string, spec: string|object, palette?: object,
 *   position: {x:number, y:number, z:number}, heading?: number, isPlayer?: boolean,
 * }} options
 * @returns {CarState}
 */
export function createCarState(options = {}) {
  const spec = resolveSpec(options.spec);
  const position = options.position ?? { x: 0, y: 0, z: 0 };
  /** @type {CarState} */
  const car = {
    id: options.id ?? spec.id ?? 'car',
    spec,
    palette: options.palette ?? spec.palette ?? null,
    isPlayer: options.isPlayer === true,

    x: finiteOr(position.x, 0),
    y: finiteOr(position.y, 0),
    z: finiteOr(position.z, 0),
    heading: finiteOr(options.heading, 0),

    vx: 0,
    vz: 0,
    yawRate: 0,

    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,

    nitro: NITRO.capacity,
    boosting: false,

    speed: 0,
    slip: 0,

    onTrack: true,
    surface: 'road',
    humpIndex: -1,

    // Extras the HUD / renderer may find useful.
    latSpeed: 0,
    steerAngle: 0,
    gear: 1,
    rpm01: GEAR_IDLE_RPM,

    // Bookkeeping used by collisions.js / race.js.
    _wasOnTrack: true,
    _scrapeCooldown: 0,
    _stuckTime: 0,
    _wasBoosting: false,
    _lastGear: 1,
    _sPrev: null,
  };
  return car;
}

/**
 * Put a car back on the road with no momentum. Used for grid placement and for
 * recovering AI cars that have wedged themselves against a barrier.
 *
 * @param {CarState} car
 * @param {{x:number, y:number, z:number}} position
 * @param {number} heading
 * @returns {CarState}
 */
export function resetCar(car, position, heading) {
  if (!car) return car;
  car.x = finiteOr(position && position.x, car.x);
  car.y = finiteOr(position && position.y, car.y);
  car.z = finiteOr(position && position.z, car.z);
  car.heading = wrapAngle(finiteOr(heading, car.heading));
  car.vx = 0;
  car.vz = 0;
  car.yawRate = 0;
  car.steer = 0;
  car.throttle = 0;
  car.brake = 0;
  car.handbrake = false;
  car.boosting = false;
  car.speed = 0;
  car.slip = 0;
  car.latSpeed = 0;
  car.steerAngle = 0;
  car.humpIndex = -1;
  car._sPrev = null;
  car._wasOnTrack = true;
  car._stuckTime = 0;
  car._scrapeCooldown = 0;
  return car;
}

/** Forward unit vector of the car in world space. */
export function carForward(car) {
  return [Math.sin(car.heading), 0, Math.cos(car.heading)];
}

/** Right unit vector of the car in world space. */
export function carRight(car) {
  return [Math.cos(car.heading), 0, -Math.sin(car.heading)];
}

/** Speed in km/h (signed; negative when reversing). */
export function carKph(car) {
  return finiteOr(car.speed, 0) * 3.6;
}

/**
 * Maximum road-wheel angle available at the car's current speed (radians).
 * Speed-sensitive lock keeps full steering from spinning the car at speed; the
 * AI uses this to convert a desired wheel angle into a normalised input.
 *
 * @param {CarState} car
 * @returns {number}
 */
export function carSteerLimit(car) {
  const lock = finiteOr(car && car.spec && car.spec.steerLock, 0.56);
  const speed = Math.abs(finiteOr(car && car.speed, 0));
  return lock / (1 + speed / STEER_FALLOFF);
}

/* ---------------------------------------------------------------- gears -- */

/**
 * Gear + tacho needle for the HUD and engine audio. Purely derived from speed
 * with a little hysteresis so it does not flicker at a constant speed.
 *
 * @param {CarState} car
 * @returns {{gear: number, rpm01: number}}
 */
export function gearForSpeed(car) {
  const spec = (car && car.spec) || {};
  const count = clamp(Math.round(finiteOr(spec.gearCount, 5)), 1, 8);
  const topSpeed = Math.max(10, finiteOr(spec.topSpeed, 70));
  const speed = Math.abs(finiteOr(car && car.speed, 0));
  const norm = clamp01(speed / topSpeed);

  // `starts[g - 1]` is the normalised speed where gear `g` begins.
  const starts = [0];
  for (let i = 1; i < count; i += 1) starts.push(Math.pow(i / count, GEAR_CURVE));
  starts.push(1);

  let raw = 1;
  for (let gear = 2; gear <= count; gear += 1) {
    if (norm >= starts[gear - 1]) raw = gear;
  }

  let gear = raw;
  const previous = car && Number.isFinite(car.gear) ? Math.round(car.gear) : 1;
  if (previous >= 1 && previous <= count) {
    if (raw > previous && norm < starts[previous] + GEAR_HYSTERESIS) gear = previous;
    else if (raw < previous && norm > starts[previous - 1] - GEAR_HYSTERESIS) gear = previous;
  }

  const lower = starts[gear - 1];
  const upper = starts[gear];
  const span = Math.max(1e-4, upper - lower);
  let rpm01 = 0.22 + 0.78 * clamp01((norm - lower) / span);
  if (speed < 0.4) rpm01 = GEAR_IDLE_RPM;

  if (car) {
    car.gear = gear;
    car.rpm01 = rpm01;
  }
  return { gear, rpm01 };
}

/* ------------------------------------------------------------ main step -- */

/**
 * Advance one car by `dt` seconds.
 *
 * @param {CarState} car
 * @param {{throttle?:number, steer?:number, handbrake?:boolean, nitro?:boolean}} input
 * @param {number} dt fixed timestep in seconds
 * @param {object} track `src/sim/track.js` track (provides `query`)
 * @param {{gripMultiplier?:number, topSpeedMultiplier?:number, autoPilot?:boolean}} [env]
 * @returns {CarEvent[]} small array of events for audio/HUD
 */
export function stepCar(car, input, dt, track, env) {
  /** @type {CarEvent[]} */
  const events = [];
  if (!car || !car.spec) return events;
  if (!(dt > 0) || !Number.isFinite(dt)) return events;

  const spec = car.spec;
  const environment = env || {};
  const throttleIn = clamp(finiteOr(input && input.throttle, 0), -1, 1);
  const steerIn = clamp(finiteOr(input && input.steer, 0), -1, 1);
  const handbrake = !!(input && input.handbrake);
  const nitroIn = !!(input && input.nitro);

  /* -- smoothed controls -------------------------------------------------- */
  const targetThrottle = Math.max(0, throttleIn);
  const targetBrake = Math.max(0, -throttleIn);
  car.throttle = damp(car.throttle, targetThrottle, targetThrottle > car.throttle ? 11 : 16, dt);
  car.brake = damp(car.brake, targetBrake, targetBrake > car.brake ? 16 : 22, dt);
  const steerRate = Math.abs(steerIn) < 0.02 ? 9.5 : 7.0;
  car.steer = moveTowards(car.steer, steerIn, steerRate * dt);
  car.handbrake = handbrake;
  if (car._scrapeCooldown > 0) car._scrapeCooldown = Math.max(0, car._scrapeCooldown - dt);

  /* -- track surface ------------------------------------------------------ */
  let query = null;
  if (track && typeof track.query === 'function') {
    query = track.query(car.x, car.z, car.humpIndex);
    car.humpIndex = query.index;
    car.onTrack = query.onTrack;
    car.surface = query.surface;
    car.y = query.y + RIDE_HEIGHT;
  }
  if (car._wasOnTrack && !car.onTrack) events.push({ type: 'offtrack', intensity: 0.5 });
  car._wasOnTrack = car.onTrack;

  const surfaceGrip = SURFACE_GRIP[car.surface] ?? 1;
  const gripMultiplier = finiteOr(environment.gripMultiplier, 1);
  const grip = surfaceGrip * gripMultiplier;

  /* -- body frame --------------------------------------------------------- */
  const heading = finiteOr(car.heading, 0);
  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  const fx = sinH;
  const fz = cosH;
  const rx = cosH;
  const rz = -sinH;
  const u = finiteOr(car.vx, 0) * fx + finiteOr(car.vz, 0) * fz;
  const v = finiteOr(car.vx, 0) * rx + finiteOr(car.vz, 0) * rz;
  let yawRate = clamp(finiteOr(car.yawRate, 0), -MAX_YAW_RATE, MAX_YAW_RATE);

  const mass = Math.max(400, finiteOr(spec.mass, 1400));
  const topSpeed = Math.max(10, finiteOr(spec.topSpeed, 70));
  const topSpeedMultiplier = finiteOr(environment.topSpeedMultiplier, 1);

  /* -- nitro -------------------------------------------------------------- */
  const canStartBoost = car.nitro >= NITRO.minToFire;
  const canContinueBoost = car._wasBoosting && car.nitro > 0.5;
  const boosting = nitroIn && (canStartBoost || canContinueBoost) && u > 3 && car.throttle > 0.1;
  if (boosting) {
    car.nitro = Math.max(0, car.nitro - NITRO.drainPerSecond * dt);
    if (!car._wasBoosting) events.push({ type: 'nitro', intensity: 1 });
  } else {
    let regen = NITRO.regenPerSecond;
    if (car.slip > 0.35) regen += NITRO.driftRegen;
    car.nitro = clamp(car.nitro + regen * dt, 0, NITRO.capacity);
  }
  car.boosting = boosting;
  car._wasBoosting = boosting;

  /* -- lateral: slip-angle bicycle model ---------------------------------- */
  const speedAbs = Math.abs(u);
  const steerScale = 1 / (1 + speedAbs / STEER_FALLOFF);
  const steerAngle = clamp(car.steer, -1, 1) * finiteOr(spec.steerLock, 0.56) * steerScale;
  car.steerAngle = steerAngle;

  // Contact-patch velocities in each wheel's own frame. Using atan2 of the true
  // wheel-frame velocity keeps the model sane when the car is sideways,
  // reversing or nearly stopped.
  const totalSpeed = Math.hypot(u, v);
  const cosSteer = Math.cos(steerAngle);
  const sinSteer = Math.sin(steerAngle);
  const frontLateral = v + CG_TO_FRONT * yawRate;
  const rearLateral = v - CG_TO_REAR * yawRate;
  const frontWheelForward = u * cosSteer + frontLateral * sinSteer;
  const frontWheelLateral = -u * sinSteer + frontLateral * cosSteer;
  const slipFront = Math.atan2(frontWheelLateral, Math.abs(frontWheelForward) + TYRE_SLIP_EPSILON);
  const slipRear = Math.atan2(rearLateral, Math.abs(u) + TYRE_SLIP_EPSILON);

  const drift = clamp01(finiteOr(spec.drift, 0.5));
  const roadLoad = mass * GRAVITY * Math.max(0.35, grip);
  // Lateral grip lost to simultaneous braking/throttle (a mild combined-slip term).
  const combinedSlip = Math.max(0.45, 1 - 0.15 * car.brake - 0.1 * car.throttle);
  const powerSlide = spec.drive === 'awd' ? 0.35 : 1;
  const frontMax = roadLoad * FRONT_GRIP_SHARE * combinedSlip;
  const rearMax =
    roadLoad *
    (1 - FRONT_GRIP_SHARE) *
    combinedSlip *
    (1 - 0.16 * drift * powerSlide * car.throttle) *
    (handbrake ? HANDBRAKE_REAR_GRIP : 1);

  const fade = clamp01((totalSpeed - TYRE_FADE_START) / (TYRE_FADE_END - TYRE_FADE_START));
  const tyreFade = fade * fade;
  const frontDrop = tyreDropOff(slipFront, TYRE_PEAK_SLIP_FRONT, POST_PEAK_DROP_FRONT);
  const rearDrop = tyreDropOff(slipRear, TYRE_PEAK_SLIP_REAR, POST_PEAK_DROP_REAR);
  const forceFront =
    tyreLateral(frontMax, slipFront, TYRE_PEAK_SLIP_FRONT, POST_PEAK_DROP_FRONT) * tyreFade;
  const forceRear =
    tyreLateral(rearMax, slipRear, TYRE_PEAK_SLIP_REAR, POST_PEAK_DROP_REAR) * tyreFade;

  const latAccel = (forceFront + forceRear) / mass;

  /* -- longitudinal ------------------------------------------------------- */
  const boostedTop = topSpeed * topSpeedMultiplier * (boosting ? NITRO.topSpeedBonus : 1);
  const driveBias = spec.drive === 'awd' ? 1 : 0.88;
  const tractionLimit = grip * GRAVITY * mass * Math.max(0.4, finiteOr(spec.grip, 1)) * driveBias;
  const powerWatts = Math.max(20, finiteOr(spec.power, 200)) * 1000;

  let driveForce = 0;
  if (car.throttle > 0.001) {
    const powerForce = powerWatts / Math.max(7, Math.abs(u));
    driveForce = Math.min(powerForce, tractionLimit) * car.throttle;
  }
  if (boosting) driveForce += NITRO.thrust;
  if (driveForce > 0) {
    // Soft limiter: the last ~2% of the top-speed range tapers drive away.
    const room = boostedTop - u;
    const taper = Math.max(1.2, boostedTop * 0.02);
    if (room <= 0) driveForce = 0;
    else if (room < taper) driveForce *= room / taper;
  }

  let tyreForce = driveForce;
  let brakeForce = 0;
  const brakeDecel = Math.min(
    Math.max(4, finiteOr(spec.brakePower, 12)),
    Math.max(4, finiteOr(spec.grip, 1)) * GRAVITY * 1.25,
  );
  if (car.brake > 0.01) {
    if (u > 0.4) {
      brakeForce = -brakeDecel * car.brake * mass;
      if (u + (tyreForce + brakeForce) / mass * dt < 0) brakeForce = -u * mass / dt - tyreForce;
    } else if (u > -REVERSE_TOP_SPEED) {
      brakeForce = -REVERSE_ACCEL * car.brake * mass;
    }
  }

  // Friction circle: the longitudinal force shares the tyre budget with the
  // lateral forces, so a car that is sliding sideways cannot also accelerate.
  // Usage is measured against the *current* (post-peak-dropped) grip, so a
  // sliding tyre frees no budget at all.
  const usageFront = frontMax > 0 ? Math.abs(forceFront) / (frontMax * frontDrop) : 0;
  const usageRear = rearMax > 0 ? Math.abs(forceRear) / (rearMax * rearDrop) : 0;
  const usage = Math.min(1, Math.max(usageFront, usageRear));
  // Longitudinal budget is the full friction circle, not the combined-slip
  // reduced lateral budget (that one only models lateral grip loss).
  const tyreCapacity = roadLoad * (handbrake ? 0.85 : 1);
  const longCapacity = tyreCapacity * Math.sqrt(Math.max(0, 1 - usage * usage));
  let requested = tyreForce + brakeForce;
  if (requested > longCapacity) requested = longCapacity;
  else if (requested < -longCapacity) requested = -longCapacity;
  let longAccel = requested / mass;

  if (car.brake < 0.01 && speedAbs > 0.05 && car.throttle < 0.05) {
    longAccel -= Math.sign(u) * COAST_DECEL; // engine braking off the throttle
  }
  if (speedAbs > 0.05) longAccel -= Math.sign(u) * ROLLING_DECEL;
  longAccel -= (AERO_SCALE * finiteOr(spec.aero, 0.65) * u * Math.abs(u)) / mass;
  longAccel -= Math.sign(u || 1) * Math.min(8, Math.abs(v) * SLIP_SCRUB);

  /* -- yaw ---------------------------------------------------------------- */
  const yawInertia = mass * YAW_INERTIA_FACTOR;
  let yawAccel = (CG_TO_FRONT * forceFront - CG_TO_REAR * forceRear) / yawInertia;
  yawAccel -= yawRate * YAW_DAMPING;

  // Self-aligning assist: rotate the nose towards the direction the car is
  // actually travelling once the body sideslip passes the deadzone.
  // betaDot = psiDot - yawRate, so a yaw moment with the sign of the sideslip
  // is what brings the car straight again.
  const sideslip = Math.atan2(v, Math.max(3.5, Math.abs(u)));
  if (Math.abs(sideslip) > ALIGN_DEADZONE) {
    const sideslipExcess =
      Math.sign(sideslip) * (Math.abs(sideslip) - ALIGN_DEADZONE);
    // betaDot = psiDot - yawRate (rad/s); the derivative term stops the spring
    // from overshooting into a wobble.
    const betaDot = (latAccel * u - longAccel * v) / Math.max(16, u * u + v * v) - yawRate;
    const align = handbrake ? HANDBRAKE_ALIGN : 1;
    yawAccel +=
      (sideslipExcess * Math.abs(sideslipExcess) * ALIGN_RATE + betaDot * ALIGN_DAMP) * align;
  }
  yawAccel = clamp(yawAccel, -MAX_YAW_ACCEL, MAX_YAW_ACCEL);

  /* -- integrate ---------------------------------------------------------- */
  // Body-frame speeds are rebuilt from the world velocity at the top of every
  // step, so the frame rotation (the centripetal `-u*yawRate` term) is already
  // accounted for by that re-projection. Adding it here too would count the
  // rotation twice and cancel most of the lateral grip.
  const uNext = u + longAccel * dt;
  const vNext = v + latAccel * dt;
  yawRate = clamp(yawRate + yawAccel * dt, -MAX_YAW_RATE, MAX_YAW_RATE);

  const hardTop = topSpeed * MAX_SPEED_FACTOR;
  let speedNext = clamp(uNext, -REVERSE_TOP_SPEED * 1.4, hardTop);
  let latNext = clamp(vNext, -MAX_LATERAL_SPEED, MAX_LATERAL_SPEED);
  if (Math.abs(speedNext) < 0.15 && car.throttle < 0.05 && car.brake < 0.05) {
    speedNext = 0;
    latNext *= 0.5;
  }

  car.speed = speedNext;
  car.latSpeed = latNext;
  car.yawRate = yawRate;
  car.heading = wrapAngle(heading + yawRate * dt);
  car.vx = speedNext * fx + latNext * rx;
  car.vz = speedNext * fz + latNext * rz;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.slip = clamp01(Math.abs(latNext) / Math.max(4, Math.abs(speedNext)));

  if (query) car.y = query.y + RIDE_HEIGHT;

  /* -- HUD gear + events -------------------------------------------------- */
  const gearInfo = gearForSpeed(car);
  if (gearInfo.gear !== car._lastGear) {
    if (Math.abs(speedNext) > 2) {
      events.push({ type: 'shift', intensity: clamp01(Math.abs(speedNext) / topSpeed) });
    }
    car._lastGear = gearInfo.gear;
  }

  /* -- never emit NaN/Infinity ------------------------------------------- */
  car.x = finiteOr(car.x, 0);
  car.y = finiteOr(car.y, 0);
  car.z = finiteOr(car.z, 0);
  car.heading = finiteOr(car.heading, 0);
  car.vx = finiteOr(car.vx, 0);
  car.vz = finiteOr(car.vz, 0);
  car.yawRate = clamp(finiteOr(car.yawRate, 0), -MAX_YAW_RATE, MAX_YAW_RATE);
  car.speed = clamp(finiteOr(car.speed, 0), -REVERSE_TOP_SPEED * 1.4, hardTop);
  car.latSpeed = clamp(finiteOr(car.latSpeed, 0), -MAX_LATERAL_SPEED, MAX_LATERAL_SPEED);
  car.slip = clamp01(finiteOr(car.slip, 0));
  car.nitro = clamp(finiteOr(car.nitro, 0), 0, NITRO.capacity);
  car.throttle = clamp01(finiteOr(car.throttle, 0));
  car.brake = clamp01(finiteOr(car.brake, 0));
  car.steer = clamp(finiteOr(car.steer, 0), -1, 1);

  return events;
}
