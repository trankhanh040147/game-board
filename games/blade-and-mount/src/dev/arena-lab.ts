import * as THREE from 'three';
import { Engine } from '../core/engine';
import { createArena } from '../world/arena';
import type { Quality } from '../core/types';

/**
 * Arena lab — dev-only Vite entry for iterating on the tournament ground.
 * Orbiting camera with presets, live draw-call/FPS readout, crowd controls.
 */

const params = new URLSearchParams(location.search);
const quality = (params.get('quality') as Quality | null) ?? 'high';
const clean = params.get('hud') === '0';
if (clean) document.body.classList.add('clean');

const container = document.getElementById('game-root') as HTMLElement;
const engine = new Engine(container, quality);
const arena = createArena(engine.scene, engine.renderer, quality);

/* ---------------- Camera ---------------- */

interface Preset {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

const PRESETS: Record<string, Preset> = {
  hero: { position: [3.2, 3.75, 10.8], target: [-0.9, 3.25, -15.0], fov: 58 },
  wide: { position: [22, 15.5, 30], target: [-3, 3.5, -6], fov: 46 },
  gate: { position: [0.4, 4.6, -6.5], target: [0, 7.2, -23.5], fov: 52 },
  stands: { position: [-5.5, 6.8, 3.5], target: [-27.5, 6.3, -1], fov: 60 },
  east: { position: [19.5, 5.5, -13], target: [-11, 4.2, 10], fov: 58 },
};

const camera = engine.camera;
let presetName: keyof typeof PRESETS = 'hero';

function applyPreset(name: keyof typeof PRESETS): void {
  presetName = name;
  const preset = PRESETS[name];
  camera.fov = preset.fov ?? 62;
  camera.updateProjectionMatrix();
  camera.position.set(...preset.position);
  camera.lookAt(new THREE.Vector3(...preset.target));
  target.set(...preset.target);
  orbit.yaw = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
  orbit.pitch = Math.asin(
    THREE.MathUtils.clamp((camera.position.y - target.y) / Math.max(0.001, camera.position.distanceTo(target)), -1, 1),
  );
  orbit.radius = camera.position.distanceTo(target);
}

const target = new THREE.Vector3();
const orbit = { yaw: 0, pitch: 0.3, radius: 32 };
let dragging = false;

container.addEventListener('pointerdown', (e) => {
  dragging = true;
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit.yaw -= e.movementX * 0.0032;
  orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + e.movementY * 0.0026, -0.4, 1.15);
  applyOrbit();
});
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    orbit.radius = THREE.MathUtils.clamp(orbit.radius * (1 + Math.sign(e.deltaY) * 0.08), 5, 90);
    applyOrbit();
  },
  { passive: false },
);

function applyOrbit(): void {
  const cp = Math.cos(orbit.pitch);
  camera.position.set(
    target.x + Math.sin(orbit.yaw) * cp * orbit.radius,
    target.y + Math.sin(orbit.pitch) * orbit.radius,
    target.z + Math.cos(orbit.yaw) * cp * orbit.radius,
  );
  camera.lookAt(target);
}

window.addEventListener('keydown', (e) => {
  const map: Record<string, keyof typeof PRESETS> = {
    '1': 'hero',
    '2': 'wide',
    '3': 'gate',
    '4': 'stands',
    '5': 'east',
  };
  const name = map[e.key];
  if (name) applyPreset(name);
  if (e.key === 'c' || e.key === 'C') arena.cheer(1);
});

applyPreset('hero');
arena.setExcitement(0.6);

/* ---------------- Loop ---------------- */

const statsEl = document.getElementById('lab-stats');
let time = 0;
let last = performance.now();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;

  // Keep the crowd lively; occasional cheers roll around the stands.
  if (time % 9 > 8.85) arena.cheer(0.85);
  arena.update(dt, time);

  engine.update(dt);
  engine.renderer.info.autoReset = false;
  engine.renderer.info.reset();
  engine.render();
  engine.renderer.info.autoReset = true;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
    if (statsEl) {
      const info = engine.renderer.info.render;
      statsEl.textContent = `${fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(1)}k tris · ${presetName}`;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const root = window as unknown as Record<string, unknown>;
root.__ready = true;
root.__arena = arena;
root.__lab = {
  engine,
  arena,
  applyPreset,
  cheer: (s = 1) => arena.cheer(s),
  setExcitement: (v: number) => arena.setExcitement(v),
};
