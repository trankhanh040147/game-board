/**
 * Apex Drift — browser shell and integration point.
 *
 * Responsibilities:
 *  - boot WebGL2 / HUD / audio / input / UI and degrade gracefully when a
 *    feature is missing,
 *  - own the screen state machine (title → garage → countdown → racing → results),
 *  - build a track scene once and cache it (geometry generation is the only slow
 *    thing in the whole game),
 *  - drive the fixed-step race simulation, translate its events into audio,
 *    camera shake, HUD toasts and record updates,
 *  - assemble the render scene (static batches + cars + wheels + glows + blobs)
 *    and hand it to the renderer every frame.
 *
 * Everything browser-specific lives here or in sibling `src/app` modules, so the
 * simulation and renderer stay importable from Node tests.
 */

import {
  CAMERA,
  CAR_ORDER,
  CAR_SPECS,
  FIXED_STEP,
  LAPS,
  MAX_FRAME_DT,
  MAX_SUBSTEPS,
  OPPONENT_COUNT,
  OPPONENT_NAMES,
  OPPONENT_PALETTES,
  OPPONENT_SKILLS,
  QUALITY,
  TRACK_DEFS,
  TRACK_ORDER,
} from '../sim/config.js';
import {
  clamp01,
  compose4,
  damp,
  mat4,
  multiply4,
  rotationX,
  rotationY,
  translation4,
} from '../core/math.js';
import { buildTrack } from '../sim/track.js';
import { createRace, stepRace } from '../sim/race.js';
import { carKph, gearForSpeed } from '../sim/car.js';
import { createChaseCamera } from '../render/camera.js';
import { createCarBodyMesh, createWheelMesh, WHEEL_OFFSETS } from '../render/carModel.js';
import { createRenderer } from '../render/renderer.js';
import { buildTrackMeshes } from '../render/worldMesh.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createRecordStore } from './storage.js';
import { createUi, formatGap, formatLapTime } from './ui.js';

const MAX_GLOW_LAMPS = 170;
const LAMP_CULL_DISTANCE = 340;

const app = {
  mode: 'title',
  renderer: null,
  camera: null,
  hud: null,
  audio: null,
  input: null,
  ui: null,
  records: null,
  loop: null,
  race: null,
  trackScene: null,
  trackId: null,
  scenes: new Map(),
  carMeshes: new Map(),
  carPresentation: new Map(),
  time: 0,
  flash: 0,
  shakeMemory: 0,
  fps: 60,
  debug: false,
  lastFrame: null,
  toastUntil: 0,
  toastText: '',
  goFlashUntil: 0,
  loopStarted: false,
  quality: 'medium',
  cameraMode: 'chase',
};

const scratchMatrix = mat4();
const scratchMatrix2 = mat4();

/* ------------------------------------------------------------- utilities -- */

function toast(text, seconds = 2.2) {
  // The HUD canvas owns in-race messages; DOM toasts own the menus. Rendering
  // both would show every message twice.
  if (app.mode === 'racing' || app.mode === 'paused') {
    app.toastText = text;
    app.toastUntil = app.time + seconds;
    return;
  }
  app.ui?.toast(text, seconds * 1000);
}

function pushShake(amount) {
  app.shakeMemory = Math.min(1.2, app.shakeMemory + amount);
}

function currentQuality() {
  return QUALITY[app.quality] ?? QUALITY.medium;
}

/* ------------------------------------------------------------------ blobs -- */

function sceneForTrack(trackId) {
  if (app.scenes.has(trackId)) return app.scenes.get(trackId);
  const def = TRACK_DEFS[trackId] ?? TRACK_DEFS[TRACK_ORDER[0]];
  const track = buildTrack(def);
  const built = buildTrackMeshes({
    track,
    palette: def.palette,
    seed: def.seed,
  });
  const scene = {
    id: def.id,
    def,
    palette: def.palette,
    track,
    batches: built.batches.map((batch) => ({
      mesh: batch.mesh,
      name: batch.name ?? 'batch',
    })),
    lamps: built.lamps ?? [],
    minimap: built.minimap ?? [],
    triangles: built.triangles ?? 0,
  };
  app.scenes.set(def.id, scene);
  return scene;
}

function carMeshSet(key, palette) {
  if (app.carMeshes.has(key)) return app.carMeshes.get(key);
  const set = {
    body: createCarBodyMesh(palette),
    wheel: createWheelMesh(palette),
  };
  app.carMeshes.set(key, set);
  return set;
}

/* --------------------------------------------------------------- entrants -- */

function buildEntrants(carId) {
  const playerSpec = CAR_SPECS[carId] ?? CAR_SPECS[CAR_ORDER[0]];
  const entrants = [];
  for (let i = 0; i < OPPONENT_COUNT; i += 1) {
    const rivalSpec = CAR_SPECS[CAR_ORDER[(i + 1) % CAR_ORDER.length]];
    const paint = OPPONENT_PALETTES[i % OPPONENT_PALETTES.length];
    entrants.push({
      id: `rival-${i}`,
      name: OPPONENT_NAMES[i % OPPONENT_NAMES.length],
      spec: rivalSpec,
      palette: { ...rivalSpec.palette, paint },
      isPlayer: false,
      skill: OPPONENT_SKILLS[i % OPPONENT_SKILLS.length],
    });
  }
  entrants.push({
    id: 'player',
    name: 'YOU',
    spec: playerSpec,
    palette: playerSpec.palette,
    isPlayer: true,
    skill: 1,
  });
  return entrants;
}

/* ------------------------------------------------------------- race flow -- */

function startRace(carId, trackId) {
  if (app.mode === 'loading') return;
  app.audio?.resume();
  app.mode = 'loading';
  app.trackId = trackId;
  app.ui.setStatus(`BUILDING ${TRACK_DEFS[trackId]?.name ?? 'CIRCUIT'}…`);
  app.ui.setLoading('BUILDING CIRCUIT…');
  app.ui.hideScreens();

  // Two animation frames so the loading overlay can paint before the (blocking)
  // geometry build, then start the race.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const scene = sceneForTrack(trackId);
        app.trackScene = scene;
        const entrants = buildEntrants(carId);
        const seed = ((scene.def.seed ?? 1) ^ (app.records.get('races') * 2654435761)) >>> 0;
        app.race = createRace({
          track: scene.track,
          entrants,
          laps: LAPS,
          seed,
          countdown: 3,
        });
        app.carPresentation.clear();
        for (const car of app.race.cars) {
          app.carPresentation.set(car.id, { spin: 0, steer: 0 });
        }
        app.camera.setMode(app.cameraMode);
        app.camera.snapTo(app.race.player);
        app.audio.resume();
        app.ui.setLoading(null);
        app.ui.hideScreens();
        app.hud.reset();
        app.input.setEnabled(true);
        app.mode = 'racing';
        toast('HOLD THE LINE', 1.6);
      } catch (error) {
        console.error('[apex-drift] race start failed', error);
        app.mode = 'garage';
        app.ui.setLoading(null);
        app.ui.showGarage();
        app.ui.toast('Could not build the circuit — see console.');
      }
    });
  });
}

function restartRace() {
  const carId = app.ui.selectedCar;
  const trackId = app.ui.selectedTrack;
  app.race = null;
  startRace(carId, trackId);
}

function quitToGarage() {
  app.mode = 'garage';
  app.race = null;
  app.input.setEnabled(false);
  app.audio.suspend();
  app.ui.hideScreens();
  app.ui.setLoading(null);
  app.ui.setStatus('Ready. The grid is waiting.');
  app.hud?.reset();
  app.ui.showGarage();
  // Preview camera: orbit the start line of the selected track.
  const scene = app.scenes.get(app.ui.selectedTrack) ?? app.trackScene;
  if (scene) {
    app.trackScene = scene;
    app.camera.setMode('orbit');
    app.camera.setOrbit([scene.track.startLine.x, scene.track.startLine.y, scene.track.startLine.z], 24, 8.5);
    app.camera.update(1 / 60, null, scene.track);
  }
}

function enterGarage() {
  app.audio?.resume();
  app.mode = 'garage';
  app.ui.showGarage();
  app.input.setEnabled(false);
  const scene = app.scenes.get(app.ui.selectedTrack);
  if (scene) {
    app.trackScene = scene;
    app.camera.setMode('orbit');
    app.camera.setOrbit([scene.track.startLine.x, scene.track.startLine.y, scene.track.startLine.z], 24, 8.5);
  }
}

function pauseRace() {
  if (app.mode !== 'racing') return;
  app.mode = 'paused';
  app.audio.suspend();
  app.ui.showPause();
}

function resumeRace() {
  if (app.mode !== 'paused') return;
  app.mode = 'racing';
  app.audio.resume();
  app.ui.hideScreens();
}

function onRaceEnd() {
  if (app.mode === 'results') return;
  app.mode = 'results';
  app.audio.suspend();
  app.audio.event('finish');
  const race = app.race;
  const player = race?.player;
  const results = race?.results ?? [];
  const playerRow = results.find((row) => row.isPlayer) ?? null;
  const standings = results.map((row) => ({
    position: row.position,
    name: row.name ?? (row.isPlayer ? 'YOU' : 'RIVAL'),
    bestLap: row.bestLap,
    totalTime: row.totalTime,
    isPlayer: row.isPlayer,
  }));

  if (playerRow) {
    app.records.incrementRaces(playerRow.position === 1);
    if (Number.isFinite(playerRow.bestLap)) {
      const isRecord = app.records.submitLap(app.trackId, playerRow.bestLap);
      if (isRecord) app.ui.setBestRecord(playerRow.bestLap, app.trackId);
    }
    if (Number.isFinite(playerRow.totalTime)) {
      app.records.submitTotal(app.trackId, playerRow.totalTime);
    }
  }

  app.ui.showResults({
    title: playerRow?.position === 1 ? 'VICTORY' : 'RACE COMPLETE',
    position: playerRow ? `${playerRow.position}/${results.length || OPPONENT_COUNT + 1}` : '—',
    totalTime: playerRow?.totalTime ?? null,
    bestLap: playerRow?.bestLap ?? race?.playerBestLap ?? null,
    standings,
  });
  app.input.setEnabled(true);
}

/* ---------------------------------------------------------------- events -- */

function handleRaceEvents(events) {
  if (!events || events.length === 0) return;
  for (const event of events) {
    switch (event.type) {
      case 'countdown':
        app.audio.event('countdown');
        break;
      case 'go':
        app.audio.event('go');
        app.goFlashUntil = app.time + 0.9;
        toast('GO!', 1);
        break;
      case 'lap': {
        app.audio.event(event.isBest ? 'best' : 'lap');
        if (event.isPlayer) {
          if (Number.isFinite(event.lapTime)) {
            app.records.submitLap(app.trackId, event.lapTime);
            app.ui.setBestRecord(app.records.bestLap(app.trackId), app.trackId);
            toast(`LAP ${event.lap} — ${formatLapTime(event.lapTime)}`, 2.4);
          }
        }
        break;
      }
      case 'finish':
        if (event.isPlayer) {
          app.audio.event('finish');
          pushShake(0.35);
        }
        break;
      case 'race-end':
        onRaceEnd();
        break;
      case 'scrape':
        app.audio.event('scrape');
        pushShake(0.06 + (event.intensity ?? 0.3) * 0.16);
        app.flash = Math.max(app.flash, 0.16);
        break;
      case 'contact':
        app.audio.event('crash');
        pushShake(0.22);
        app.flash = Math.max(app.flash, 0.24);
        break;
      case 'nitro':
        app.audio.event('nitro');
        break;
      case 'offtrack':
        app.flash = Math.max(app.flash, 0.08);
        break;
      case 'shift':
        app.audio.event('shift');
        break;
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ input -- */

function handleCommand(command) {
  if (command === 'mute') {
    app.audio.setMuted(!app.audio.muted);
    app.records.set('muted', app.audio.muted);
    app.ui.setMuted(app.audio.muted);
    return;
  }
  if (command === 'fullscreen') {
    toggleFullscreen();
    return;
  }
  if (command === 'debug') {
    app.debug = !app.debug;
    app.ui.toast(app.debug ? 'DEBUG ON' : 'DEBUG OFF');
    return;
  }

  if (command === 'confirm') {
    if (app.mode === 'title') enterGarage();
    else if (app.mode === 'garage') startRace(app.ui.selectedCar, app.ui.selectedTrack);
    else if (app.mode === 'results') restartRace();
    return;
  }
  if (command === 'pause') {
    if (app.mode === 'racing') pauseRace();
    else if (app.mode === 'paused') resumeRace();
    else if (app.mode === 'title') enterGarage();
    return;
  }
  if (command === 'restart') {
    if (app.mode === 'racing' || app.mode === 'paused' || app.mode === 'results') restartRace();
    return;
  }
  if (command === 'quit') {
    if (app.mode === 'racing' || app.mode === 'paused' || app.mode === 'results') quitToGarage();
    return;
  }
  if (command === 'camera') {
    const mode = app.camera.nextMode();
    app.cameraMode = mode;
    app.records.set('camera', mode);
    app.ui.setCamera(mode);
    app.ui.toast(`CAMERA: ${mode.toUpperCase()}`, 1.2);
  }
}

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  } catch {
    /* fullscreen can be blocked by permissions policy; ignore */
  }
}

/* ------------------------------------------------------------- simulation -- */

function stepSimulation(dt) {
  app.time += dt;
  if (app.mode !== 'racing' || !app.race) return;
  const sample = app.input.sample();
  const events = stepRace(app.race, dt, sample);
  handleRaceEvents(events);
  if (app.race.state === 'finished' && app.mode === 'racing') onRaceEnd();
}

/* ---------------------------------------------------------- presentation -- */

function updateCamera(dt) {
  if (app.mode === 'title' || app.mode === 'garage' || app.mode === 'loading') {
    if (app.trackScene) {
      if (app.camera.mode !== 'orbit') {
        const line = app.trackScene.track.startLine;
        app.camera.setMode('orbit');
        app.camera.setOrbit([line.x, line.y, line.z], 24, 8.5);
      }
      app.camera.update(dt, null, app.trackScene.track);
    }
    return;
  }
  const player = app.race?.player;
  if (!player) return;
  player.topSpeed = player.spec.topSpeed;
  app.camera.update(dt, player, app.trackScene?.track);
  // Fold impact shake into the camera rig.
  if (app.shakeMemory > 0.001) {
    app.camera.shake(app.shakeMemory);
    app.shakeMemory = 0;
  }
}

function wheelMatrix(car, offset, presentation, steerAngle, spin) {
  const carMatrix = compose4(car.x, car.y + 0.02, car.z, car.heading);
  const local = translation4(offset.x, offset.y, offset.z, scratchMatrix2);
  multiply4(scratchMatrix, carMatrix, local);
  if (offset.front) {
    const steering = rotationY(steerAngle, mat4());
    multiply4(scratchMatrix, scratchMatrix, steering);
  }
  const spinning = rotationX(spin, mat4());
  multiply4(scratchMatrix, scratchMatrix, spinning);
  return scratchMatrix;
}

function buildRenderScene(dt) {
  const scene = app.trackScene;
  if (!scene) return null;
  const palette = scene.palette;
  const objects = [];
  for (const batch of scene.batches) {
    objects.push({ mesh: batch.mesh });
  }

  const glows = [];
  const blobs = [];
  const cameraPos = app.camera.position;

  const cars = app.race?.cars ?? [];
  for (const car of cars) {
    const key = car.isPlayer ? `player-${car.spec.id}` : car.id;
    const paletteForCar = car.palette ?? car.spec.palette;
    const meshes = carMeshSet(key, paletteForCar);
    const presentation = app.carPresentation.get(car.id) ?? { spin: 0, steer: 0 };

    // A bonnet camera sits inside the shell, so its owner is not drawn.
    const hiddenCar = car.isPlayer && app.camera.mode === 'hood';
    const speed = Math.abs(car.speed ?? Math.hypot(car.vx ?? 0, car.vz ?? 0));
    presentation.spin -= (speed / 0.36) * dt;
    presentation.steer = damp(presentation.steer, (car.steer ?? 0) * (car.spec.steerLock ?? 0.55), 14, dt);
    app.carPresentation.set(car.id, presentation);

    if (hiddenCar) continue;

    // Body.
    objects.push({
      mesh: meshes.body,
      matrix: compose4(car.x, car.y + 0.03, car.z, car.heading),
    });

    // Wheels.
    for (const offset of WHEEL_OFFSETS) {
      objects.push({
        mesh: meshes.wheel,
        matrix: wheelMatrix(car, offset, presentation, presentation.steer, presentation.spin),
      });
    }

    // Contact shadow.
    blobs.push({
      x: car.x,
      y: car.y + 0.035,
      z: car.z,
      rx: 1.18,
      rz: 2.25,
      opacity: 0.9,
      color: palette.shadow ?? [0.01, 0.01, 0.02],
    });

    // Lights: transform local offsets into world space.
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    const toWorld = (lx, ly, lz) => [
      car.x + cos * lx + sin * lz,
      car.y + ly,
      car.z - sin * lx + cos * lz,
    ];
    const hc = palette.glow?.headlight ?? [1, 0.96, 0.86];
    const tc = palette.glow?.taillight ?? [1, 0.18, 0.25];
    const rivalScale = car.isPlayer ? 1 : 0.78;
    for (const lx of [-0.62, 0.62]) {
      const [wx, wy, wz] = toWorld(lx, 0.62, 2.12);
      glows.push({ x: wx, y: wy, z: wz, size: 1.15, color: hc, intensity: 0.85 * rivalScale });
      const [tx, ty, tz] = toWorld(lx * 1.05, 0.72, -2.18);
      const braking = (car.brake ?? 0) > 0.35;
      glows.push({ x: tx, y: ty, z: tz, size: 0.78, color: tc, intensity: (braking ? 1.5 : 0.7) * rivalScale });
    }
    if (car.boosting) {
      const nc = palette.glow?.nitro ?? [0.35, 0.75, 1.0];
      const flicker = 0.8 + Math.sin(app.time * 47) * 0.2;
      for (const lx of [-0.42, 0.42]) {
        const [nx, ny, nz] = toWorld(lx, 0.36, -2.28);
        glows.push({ x: nx, y: ny, z: nz, size: 0.95 * flicker, color: nc, intensity: 1.5 });
      }
    }
  }

  // Street lamps (culled by distance, capped for the additive pass budget).
  let lampBudget = MAX_GLOW_LAMPS;
  const lampIntensity = currentQuality().glows ?? 0.7;
  if (lampIntensity > 0) {
    for (const lamp of scene.lamps) {
      if (lampBudget <= 0) break;
      const dx = lamp.x - cameraPos[0];
      const dz = lamp.z - cameraPos[2];
      if (dx * dx + dz * dz > LAMP_CULL_DISTANCE * LAMP_CULL_DISTANCE) continue;
      glows.push({
        x: lamp.x,
        y: lamp.y,
        z: lamp.z,
        size: lamp.size ?? 1.6,
        color: lamp.color ?? palette.lamps.color,
        intensity: (lamp.intensity ?? 1) * lampIntensity,
      });
      lampBudget -= 1;
    }
  }

  const fog = palette.fog ?? { color: [0, 0, 0], near: 100, far: 800 };
  const drawDistance = currentQuality().drawDistance;
  const sun = palette.sun ?? { direction: [0, 1, 0], color: [1, 1, 1], intensity: 1 };

  return {
    camera: {
      position: app.camera.position,
      target: app.camera.target,
      fov: app.camera.fov,
      near: CAMERA.near,
      far: CAMERA.far,
    },
    sun: {
      direction: sun.direction,
      color: [sun.color[0] * sun.intensity, sun.color[1] * sun.intensity, sun.color[2] * sun.intensity],
    },
    ambient: palette.ambient,
    fog: { color: fog.color, near: fog.near, far: Math.min(fog.far, drawDistance) },
    sky: { ...palette.sky },
    clear: palette.sky?.bottom ?? [0.02, 0.02, 0.04],
    time: app.time,
    objects,
    glows,
    blobs,
    glowIntensity: app.mode === 'racing' || app.mode === 'paused' ? 1 : 0.85,
  };
}

/* ------------------------------------------------------------------- hud -- */

function buildHudState() {
  const race = app.race;
  const player = race?.player ?? null;
  const scene = app.trackScene;
  let speedKph = 0;
  let gear = 1;
  let rpm01 = 0;
  let nitro01 = 0;
  let drift01 = 0;
  let lapTime = 0;
  let bestLap = race?.playerBestLap ?? null;
  let lastLap = null;
  let position = 1;
  let totalCars = race?.cars.length ?? OPPONENT_COUNT + 1;
  let progress = 0;
  let lap = 1;

  if (player) {
    speedKph = Math.abs(carKph(player));
    const gearing = gearForSpeed(player);
    gear = gearing.gear;
    rpm01 = gearing.rpm01;
    nitro01 = clamp01((player.nitro ?? 0) / 100);
    drift01 = clamp01(player.slip ?? 0);
    const lapTimes = race.playerLapTimes ?? [];
    const sum = lapTimes.reduce((total, value) => total + value, 0);
    lapTime = Number.isFinite(race.playerLapTime)
      ? Math.max(0, race.playerLapTime)
      : Math.max(0, (race.time ?? 0) - sum);
    lastLap = lapTimes.length > 0 ? lapTimes[lapTimes.length - 1] : null;
    const standings = race.standings ?? [];
    const mine = standings.find((row) => row.isPlayer);
    position = mine?.position ?? 1;
    lap = mine?.lap ?? 1;
    progress = 0;
    if (scene && player) {
      const query = scene.track.query(player.x, player.z, player.humpIndex);
      progress = clamp01(query.s / scene.track.length);
    }
  }

  const standings = (race?.standings ?? []).map((row) => ({
    name: row.name ?? (row.isPlayer ? 'YOU' : 'RIVAL'),
    position: row.position,
    gap: row.gap ?? 0,
    isPlayer: Boolean(row.isPlayer),
  }));

  const minimapCars = (race?.cars ?? []).map((car) => ({ x: car.x, z: car.z, isPlayer: car.isPlayer }));

  // Hold the countdown frame briefly after GO so the big "GO" flash is visible,
  // but never let that bleed into the menus (the HUD blanks on title/garage).
  const goFlash =
    app.mode === 'racing' && app.goFlashUntil > 0 && app.time < app.goFlashUntil;
  const raceState =
    app.mode === 'racing' ? (goFlash ? 'countdown' : (race?.state ?? 'running')) : app.mode;
  const countdown = race?.state === 'countdown'
    ? Math.max(0, Math.ceil(race.countdown ?? 0))
    : 0;
  const delta =
    lastLap !== null && Number.isFinite(lastLap) && Number.isFinite(bestLap) && bestLap > 0
      ? lastLap - bestLap
      : null;

  return {
    speedKph,
    gear,
    rpm01,
    nitro01,
    boosting: Boolean(player?.boosting),
    drift01,
    raceState,
    countdown,
    lap,
    laps: race?.laps ?? LAPS,
    position,
    totalCars,
    lapTime,
    lastLap,
    bestLap,
    delta,
    progress,
    standings,
    minimap: {
      outline: scene?.minimap ?? [],
      cars: minimapCars,
      start: scene ? [scene.track.startLine.x, scene.track.startLine.z] : [0, 0],
    },
    speedLines: clamp01((speedKph / 260) ** 2 * 1.2),
    fps: app.fps,
    quality: app.quality.toUpperCase(),
    toast: app.time < app.toastUntil ? { text: app.toastText } : null,
    bestRecord: app.records?.bestLap(app.trackId) ?? null,
  };
}

/* ----------------------------------------------------------------- frame -- */

function frameRender(dt) {
  app.fps = dt > 0 ? app.fps + (1 / dt - app.fps) * 0.08 : app.fps;
  app.flash = Math.max(0, app.flash - dt * 2.4);

  updateCamera(dt);

  const hudState = buildHudState();
  // Presentation-only CSS effects (transform/opacity only, so they stay cheap).
  const root = document.documentElement;
  root.style.setProperty('--speed', hudState.speedLines.toFixed(3));
  root.style.setProperty('--flash', app.flash.toFixed(3));
  root.style.setProperty('--nitro', hudState.boosting ? '1' : '0');

  if (app.trackScene) {
    const renderScene = buildRenderScene(dt);
    if (renderScene) app.renderer.renderFrame(renderScene);
  }

  const player = app.race?.player ?? null;
  app.audio.update({
    rpm01: hudState.rpm01,
    throttle: player?.throttle ?? 0,
    speed: player ? Math.abs(player.speed ?? 0) : 0,
    slip: hudState.drift01,
    boosting: hudState.boosting,
    surface: player?.surface ?? 'road',
    parked: !player || app.mode !== 'racing',
    raceState: app.mode,
  });

  if (app.hud) app.hud.draw(hudState);
}

/* ------------------------------------------------------------------ boot -- */

function showFatalError(message) {
  const lockup = document.querySelector('.title-lockup');
  if (lockup) {
    lockup.textContent = '';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'SYSTEM CHECK FAILED';
    const heading = document.createElement('h1');
    heading.className = 'logo';
    heading.textContent = 'NO WEBGL2';
    const text = document.createElement('p');
    text.className = 'tagline';
    text.textContent = message;
    lockup.append(eyebrow, heading, text);
  }
}

function boot() {
  const view = document.getElementById('view');
  const hudCanvas = document.getElementById('hud');
  if (!view || !hudCanvas) return;

  app.records = createRecordStore();
  app.quality = app.records.get('quality') ?? 'medium';
  app.cameraMode = app.records.get('camera') ?? 'chase';

  app.renderer = createRenderer(view, {
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    quality: app.quality,
  });
  if (!app.renderer.ok) {
    showFatalError(app.renderer.error ?? 'WebGL2 is unavailable.');
    return;
  }
  app.renderer.setQuality(app.quality);

  app.camera = createChaseCamera();
  app.camera.setMode('orbit');
  app.audio = createAudio();
  app.audio.setMuted(Boolean(app.records.get('muted')));

  app.ui = createUi({
    records: app.records,
    onEnterGarage: () => {
      if (app.mode === 'title') enterGarage();
    },
    onStart: (carId, trackId) => {
      if (app.mode === 'garage') startRace(carId, trackId);
    },
    onResume: () => resumeRace(),
    onRestart: () => restartRace(),
    onQuit: () => quitToGarage(),
    onAgain: () => restartRace(),
    onBackToGarage: () => quitToGarage(),
    onQuality: (value) => {
      app.quality = value;
      app.records.set('quality', value);
      app.renderer.setQuality(value);
      resize();
      app.ui.toast(`QUALITY: ${value.toUpperCase()}`, 1.4);
    },
    onCamera: (value) => {
      app.cameraMode = value;
      app.records.set('camera', value);
      app.camera.setMode(value);
      app.ui.toast(`CAMERA: ${value.toUpperCase()}`, 1.4);
    },
    onMute: () => handleCommand('mute'),
    onSelectCar: (carId) => app.ui?.setStatus(`${CAR_SPECS[carId]?.name ?? carId} selected`),
    onSelectTrack: (trackId) => {
      if (app.mode !== 'garage') return;
      app.selectedTrackId = trackId;
      const scene = app.scenes.get(trackId);
      if (scene) {
        app.ui.setLoading(null);
        app.trackScene = scene;
        app.camera.setMode('orbit');
        app.camera.setOrbit(
          [scene.track.startLine.x, scene.track.startLine.y, scene.track.startLine.z],
          24,
          8.5,
        );
      } else {
        app.ui.setStatus(`LOADING ${TRACK_DEFS[trackId]?.name ?? 'CIRCUIT'}…`);
        app.ui.setLoading(`BUILDING ${TRACK_DEFS[trackId]?.name ?? 'CIRCUIT'}…`);
        setTimeout(() => {
          if (app.mode !== 'garage' || app.selectedTrackId !== trackId) return;
          const built = sceneForTrack(trackId);
          app.trackScene = built;
          app.camera.setMode('orbit');
          app.camera.setOrbit(
            [built.track.startLine.x, built.track.startLine.y, built.track.startLine.z],
            24,
            8.5,
          );
          app.ui.setLoading(null);
          app.ui.setStatus('Ready. The grid is waiting.');
        }, 40);
      }
    },
  });

  app.hud = createHud({
    canvas: hudCanvas,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });

  app.input = createInput({ target: window, onCommand: handleCommand });
  app.input.setEnabled(false);
  app.audio.setMuted(Boolean(app.records.get('muted')));
  app.ui.setMuted(Boolean(app.records.get('muted')));

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.mode === 'racing') pauseRace();
  });

  // Build the default circuit before showing the attract screen.
  app.ui.setLoading('BUILDING NEON BAY…');
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const scene = sceneForTrack(app.ui.selectedTrack);
        app.trackScene = scene;
        app.camera.setMode('orbit');
        app.camera.setOrbit(
          [scene.track.startLine.x, scene.track.startLine.y, scene.track.startLine.z],
          24,
          8.5,
        );
        app.ui.setLoading(null);
        app.ui.showTitle();
        app.mode = 'title';
        app.loop = createLoop({
          step: FIXED_STEP,
          maxSubsteps: MAX_SUBSTEPS,
          maxFrameDt: MAX_FRAME_DT,
          onStep: stepSimulation,
          onRender: frameRender,
        });
        installDebugHooks();
        app.loop.start();
        app.input.setEnabled(false);
      } catch (error) {
        console.error('[apex-drift] boot failed', error);
        showFatalError(`Could not build the circuit: ${error.message}`);
      }
    }, 30);
  });
}

function resize() {
  if (!app.renderer) return;
  app.renderer.resize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const view = document.getElementById('view');
  const hudCanvas = document.getElementById('hud');
  if (view && hudCanvas) {
    hudCanvas.style.width = '100%';
    hudCanvas.style.height = '100%';
    const width = view.clientWidth || window.innerWidth;
    const height = view.clientHeight || window.innerHeight;
    app.hud?.resize(width, height, dpr);
  }
}

/**
 * Debug hooks used by the headless verification harness in `tools/`.
 * Harmless in production and useful in the console.
 */
function installDebugHooks() {
  if (typeof window === 'undefined') return;
  window.__APEX__ = app;
  window.__apexDebug = {
    app,
    get mode() {
      return app.mode;
    },
    get ready() {
      return Boolean(app.trackScene && app.renderer?.ok);
    },
    enterGarage,
    startRace,
    quitToGarage,
    restartRace,
    pauseRace,
    resumeRace,
    setMode(mode) {
      app.mode = mode;
    },
    stats() {
      return {
        mode: app.mode,
        quality: app.quality,
        triangles: app.renderer?.stats.triangles ?? 0,
        drawCalls: app.renderer?.stats.drawCalls ?? 0,
        glows: app.renderer?.stats.glows ?? 0,
        cars: app.race?.cars.length ?? 0,
        raceState: app.race?.state ?? null,
      };
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

export { app, boot, formatGap, formatLapTime };
