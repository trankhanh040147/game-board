/**
 * Chase / hood / orbit camera.
 *
 * The chase rig follows the car's *velocity* direction rather than its facing
 * direction, which is what makes a big drift slide read correctly: the camera
 * stays behind the travel line while the car rotates underneath it.
 *
 * Pure maths + config, so it is unit-testable without a DOM.
 */

import {
  clamp,
  clamp01,
  damp,
  lerp,
  lookAt,
  multiply4,
  normalize3,
  perspective,
  TAU,
} from '../core/math.js';
import { CAMERA } from '../sim/config.js';

const ORIGIN = [0, 0, 0];

/** @typedef {'chase'|'hood'|'far'|'orbit'} CameraMode */

export function createChaseCamera(options = {}) {
  const config = { ...CAMERA, ...options };
  const state = {
    mode: /** @type {CameraMode} */ ('chase'),
    position: [0, 12, -24],
    target: [0, 0, 0],
    forward: [0, 0, 1],
    velocityDirection: [0, 0, 1],
    fov: config.fovBase,
    speedRatio: 0,
    shakeAmount: 0,
    shakeTime: 0,
    orbitAngle: 0,
    orbitRadius: options.orbitRadius ?? 30,
    orbitHeight: options.orbitHeight ?? 11,
    orbitPoint: options.orbitPoint ?? [0, 0, 0],
    hintIndex: -1,
    matrices: {
      view: new Float32Array(16),
      projection: new Float32Array(16),
      viewProjection: new Float32Array(16),
    },
    scratchProjection: new Float32Array(16),
    ready: false,
  };

  function forwardOf(car) {
    return [Math.sin(car.heading), 0, Math.cos(car.heading)];
  }

  function lookDirection(car, dt) {
    const speed = Math.hypot(car.vx, car.vz);
    const forward = forwardOf(car);
    if (speed < 2.5) {
      state.velocityDirection = forward;
      return forward;
    }
    const velocityDirection = [car.vx / speed, 0, car.vz / speed];
    state.velocityDirection = velocityDirection;
    // Blend towards the velocity vector with speed so slow corners stay stable.
    const blend = clamp01(speed / 18) * config.drift;
    return normalize3([
      lerp(forward[0], velocityDirection[0], blend),
      0,
      lerp(forward[2], velocityDirection[2], blend),
    ]);
  }

  function chaseRig(car, direction) {
    const distance = config.distance;
    const height = config.height;
    return {
      x: car.x - direction[0] * distance,
      y: car.y + height,
      z: car.z - direction[2] * distance,
      lookX: car.x + direction[0] * config.lookAhead,
      lookY: car.y + 1.15,
      lookZ: car.z + direction[2] * config.lookAhead,
    };
  }

  function hoodRig(car) {
    // Above the bonnet lip: the shell is hidden in this mode (see main.js), so
    // the camera can sit where a bonnet cam actually is rather than in the cabin.
    const forward = forwardOf(car);
    return {
      x: car.x + forward[0] * 1.15,
      y: car.y + 1.06,
      z: car.z + forward[2] * 1.15,
      lookX: car.x + forward[0] * 26,
      lookY: car.y + 0.92,
      lookZ: car.z + forward[2] * 26,
    };
  }

  function farRig(car, direction) {
    return {
      x: car.x - direction[0] * 15,
      y: car.y + 6.2,
      z: car.z - direction[2] * 15,
      lookX: car.x + direction[0] * 10,
      lookY: car.y + 1.0,
      lookZ: car.z + direction[2] * 10,
    };
  }

  /**
   * Advance the camera.
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number,heading:number,vx:number,vz:number,boosting?:boolean,topSpeed?:number,slip?:number}} car
   * @param {{query?:Function}} [track]
   */
  function update(dt, car, track) {
    if (!car && state.mode !== 'orbit') return state;
    if (car) {
      state.speedRatio = clamp01(Math.hypot(car.vx, car.vz) / (car.topSpeed || 80));
    } else {
      state.speedRatio = 0;
    }
    const direction = car ? lookDirection(car, dt) : [0, 0, 1];

    if (state.mode === 'orbit') {
      state.orbitAngle = (state.orbitAngle + dt * 0.16) % TAU;
      const radius = state.orbitRadius;
      const point = state.orbitPoint;
      state.position[0] = point[0] + Math.cos(state.orbitAngle) * radius;
      state.position[1] = point[1] + state.orbitHeight;
      state.position[2] = point[2] + Math.sin(state.orbitAngle) * radius;
      state.target[0] = point[0];
      state.target[1] = point[1] + 1.5;
      state.target[2] = point[2];
      state.forward = [point[0] - state.position[0], 0, point[2] - state.position[2]];
      state.fov = config.fovBase;
      state.shakeAmount = 0;
    } else {
      let rig;
      if (state.mode === 'hood') rig = hoodRig(car);
      else if (state.mode === 'far') rig = farRig(car, direction);
      else rig = chaseRig(car, direction);

      // Keep the rig out of the road when the camera drops behind a crest.
      if (track && track.query) {
        const query = track.query(rig.x, rig.z, state.hintIndex >= 0 ? state.hintIndex : undefined);
        state.hintIndex = query.index;
        const groundY = query.y + 0.9;
        if (rig.y < groundY) rig.y = groundY;
      }

      const lambda = state.mode === 'hood' ? 30 : config.stiffness;
      const step = dt > 0 ? 1 - Math.exp(-lambda * dt) : 1;
      const lerpFactor = state.ready ? Math.min(1, step) : 1;
      state.position[0] += (rig.x - state.position[0]) * lerpFactor;
      state.position[1] += (rig.y - state.position[1]) * lerpFactor;
      state.position[2] += (rig.z - state.position[2]) * lerpFactor;
      state.target[0] = rig.lookX;
      state.target[1] = rig.lookY;
      state.target[2] = rig.lookZ;

      const speedFov =
        config.fovBase +
        config.fovSpeed * state.speedRatio * state.speedRatio +
        (car.boosting ? config.fovBoost : 0);
      state.fov = state.ready ? damp(state.fov, speedFov, 6, dt) : speedFov;

      // Shake: high-speed rumble plus explicit impacts (kerbs, collisions).
      state.shakeTime += dt;
      const rumble = state.speedRatio > 0.55 ? (state.speedRatio - 0.55) * config.shake * 0.25 : 0;
      state.shakeAmount = Math.max(state.shakeAmount * Math.exp(-6 * dt), rumble);
      state.ready = true;
    }

    state.forward = normalize3([
      state.target[0] - state.position[0],
      state.target[1] - state.position[1],
      state.target[2] - state.position[2],
    ]);
    return state;
  }

  /** View-projection matrix for the given viewport aspect ratio. */
  function viewProjection(aspect, near = config.near, far = config.far) {
    const { view, projection, viewProjection: vp } = state.matrices;
    const shake = state.shakeAmount;
    const shakeX = Math.sin(state.shakeTime * 47.3) * shake * 0.35;
    const shakeY = Math.sin(state.shakeTime * 61.7 + 1.3) * shake * 0.28;
    const shakeZ = Math.sin(state.shakeTime * 39.1 + 2.7) * shake * 0.35;
    lookAt(
      [state.position[0] + shakeX, state.position[1] + shakeY, state.position[2] + shakeZ],
      state.target,
      [0, 1, 0],
      view,
    );
    perspective(state.fov, Math.max(0.1, aspect), near, far, projection);
    multiply4(vp, projection, view);
    return vp;
  }

  function setMode(mode) {
    if (mode === state.mode) return state.mode;
    state.mode = mode;
    state.ready = false;
    return mode;
  }

  function nextMode() {
    const order = /** @type {CameraMode[]} */ (['chase', 'hood', 'far']);
    const index = order.indexOf(state.mode);
    return setMode(order[(index + 1) % order.length]);
  }

  function shake(amount = 0.5) {
    state.shakeAmount = Math.min(1.4, state.shakeAmount + amount);
  }

  function snapTo(car) {
    if (!car) return state;
    const direction = forwardOf(car);
    state.position = [
      car.x - direction[0] * config.distance,
      car.y + config.height,
      car.z - direction[2] * config.distance,
    ];
    state.target = [
      car.x + direction[0] * config.lookAhead,
      car.y + 1.15,
      car.z + direction[2] * config.lookAhead,
    ];
    state.fov = config.fovBase;
    state.ready = true;
    state.hintIndex = -1;
    return state;
  }

  function setOrbit(point, radius = state.orbitRadius, height = state.orbitHeight) {
    state.orbitPoint = point ?? ORIGIN;
    state.orbitRadius = radius;
    state.orbitHeight = height;
    state.orbitAngle = 0;
    state.ready = false;
  }

  return {
    get mode() {
      return state.mode;
    },
    get position() {
      return state.position;
    },
    get target() {
      return state.target;
    },
    get fov() {
      return state.fov;
    },
    get matrices() {
      return state.matrices;
    },
    config,
    state,
    update,
    viewProjection,
    setMode,
    nextMode,
    setOrbit,
    shake,
    snapTo,
    /** Exposed for tests/inspection. */
    forward: () => state.forward,
  };
}

export { clamp };
