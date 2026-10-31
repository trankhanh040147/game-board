import './style.css';
import { Engine } from './core/engine';
import { createArena } from './world/arena';
import { loadSettings } from './game/profile';
import * as THREE from 'three';

const gameRoot = document.getElementById('game-root') as HTMLElement;
const settings = loadSettings();
const engine = new Engine(gameRoot, settings.quality);
const arena = createArena(engine.scene, engine.renderer, settings.quality);

const cam = engine.camera;
let t = 0;
const target = new THREE.Vector3(0, 1.6, 0);

function frame(dt: number): void {
  t += dt;
  arena.update(dt, t);
  const r = 17;
  cam.position.set(Math.sin(t * 0.12) * r, 5.5, Math.cos(t * 0.12) * r + 2);
  cam.lookAt(target);
  engine.update(dt);
  engine.render();
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

(window as unknown as Record<string, unknown>).__ready = true;
void arena;
