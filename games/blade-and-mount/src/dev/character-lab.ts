/**
 * Character Lab — visual iteration harness for the procedural fighters.
 * URL params:
 *   ?n=8               number of fighters (1..12)
 *   ?quality=high      low | medium | high
 *   ?view=wide         wide | front | hero | side | orbit
 *   ?solo=3            isolate one fighter
 *   ?pose=idle         idle|walk|run|strafe-left|strafe-right|back|guard-*|
 *                      attack-*|hit|stagger|kick|dodge|victory|taunt|spawn|bash|death|mix
 *   ?t=0.35            freeze time for the pose
 *   Space              pause/resume the auto cycle
 */
import * as THREE from 'three';
import { createCharacterRig, type CharacterRigDebug } from '../characters/rig';
import { createAppearance } from '../characters/appearance';
import {
  ARMORS, HELMETS, SHIELDS, TEAM_PALETTE, WEAPONS,
} from '../core/config';
import type { AttackDir, Loadout, Quality, ShieldDef } from '../core/types';
import { attackTiming } from '../core/config';

/* ------------------------------------------------------------------ */
/* URL params                                                          */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (key: string, fallback: string): string => params.get(key) ?? fallback;
const QUALITY = str('quality', 'high') as Quality;
const VIEW = str('view', 'wide');
const SOLO = params.has('solo') ? num('solo', 0) : -1;
const POSE = params.get('pose');
const FREEZE_T = num('t', 0.35);
const COUNT = Math.max(1, Math.min(12, Math.round(num('n', 8))));

/* ------------------------------------------------------------------ */
/* Renderer / scene                                                    */
/* ------------------------------------------------------------------ */

const rootEl = document.getElementById('lab-root') as HTMLElement;
const errorEl = document.getElementById('lab-error') as HTMLElement;
const statFighters = document.getElementById('stat-fighters') as HTMLElement;
const statCalls = document.getElementById('stat-calls') as HTMLElement;
const statPer = document.getElementById('stat-per') as HTMLElement;
const statTris = document.getElementById('stat-tris') as HTMLElement;
const statFps = document.getElementById('stat-fps') as HTMLElement;
const statFoot = document.getElementById('stat-foot') as HTMLElement;
const statTip = document.getElementById('stat-tip') as HTMLElement;
const statAnim = document.getElementById('stat-anim') as HTMLElement;

function showError(msg: string): void {
  errorEl.style.display = 'block';
  errorEl.textContent = msg;
}
window.addEventListener('error', (e) => showError(String(e.message)));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;
rootEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 120);
scene.fog = new THREE.Fog(0xb9b3a1, 14, 44);

/* --- sky gradient backdrop --- */
{
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#8fa3ab');
    g.addColorStop(0.45, '#b9c2c1');
    g.addColorStop(0.62, '#ddd5c0');
    g.addColorStop(0.68, '#cfc5ab');
    g.addColorStop(1, '#a08c6c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
  } else {
    scene.background = new THREE.Color(0xb6bcae);
  }
}

/* --- lights --- */
const hemi = new THREE.HemisphereLight(0xd6e2e8, 0x6d5a40, 1.35);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff2da, 2.65);
key.position.set(5.5, 9.5, 6.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 32;
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -4;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(key.target);

const rim = new THREE.DirectionalLight(0xffd3a2, 1.5);
rim.position.set(-5, 5.5, -7);
scene.add(rim);

const fill = new THREE.DirectionalLight(0x9db6c9, 0.55);
fill.position.set(-7, 3, 5);
scene.add(fill);

/* --- ground --- */
{
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#b9a47f';
    ctx.fillRect(0, 0, 256, 256);
    // Sand grain + trodden patches.
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 0.4 + rnd() * 2.6;
      const v = rnd() > 0.5 ? 255 : 60;
      ctx.fillStyle = `rgba(${v},${v * 0.94},${v * 0.8},${0.025 + rnd() * 0.09})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 14; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 12 + rnd() * 40;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(90,74,52,${0.05 + rnd() * 0.06})`);
      g.addColorStop(1, 'rgba(90,74,52,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(10, 10);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(46, 64),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xcdbb98, roughness: 0.97, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }
}

/* ------------------------------------------------------------------ */
/* Fighter roster                                                      */
/* ------------------------------------------------------------------ */

interface RosterEntry {
  weapon: string;
  shield: string | null;
  armor: string;
  helmet: string;
  team: number;
  seed: number;
  scaleBias?: number;
}

const ROSTER: RosterEntry[] = [
  { weapon: 'spear', shield: 'kite', armor: 'gambeson', helmet: 'none', team: 0, seed: 1013 },
  { weapon: 'war_axe', shield: 'round', armor: 'jerkin', helmet: 'skullcap', team: 1, seed: 2027 },
  { weapon: 'arming_sword', shield: 'heater', armor: 'hauberk', helmet: 'nasal', team: 2, seed: 3041 },
  { weapon: 'mace', shield: 'tower', armor: 'scale', helmet: 'spangen', team: 3, seed: 4057 },
  { weapon: 'greatsword', shield: null, armor: 'plate', helmet: 'great', team: 0, seed: 5077 },
  { weapon: 'falchion', shield: 'round', armor: 'gambeson', helmet: 'barbute', team: 1, seed: 6091 },
  { weapon: 'quarterstaff', shield: null, armor: 'hauberk', helmet: 'nasal', team: 2, seed: 7103 },
  { weapon: 'boar_spear', shield: 'heater', armor: 'plate', helmet: 'barbute', team: 3, seed: 8117 },
];

function buildLoadout(entry: RosterEntry): Loadout {
  const team = TEAM_PALETTE[entry.team % TEAM_PALETTE.length];
  const color1 = team.color;
  const color2 = team.secondary;
  const shieldBase: ShieldDef | undefined = entry.shield ? SHIELDS[entry.shield] : undefined;
  const shield = shieldBase ? { ...shieldBase, color: color1, color2 } : null;
  return {
    weapon: { ...WEAPONS[entry.weapon] },
    shield,
    armor: { ...ARMORS[entry.armor] },
    helmet: { ...HELMETS[entry.helmet] },
    color1,
    color2,
    title: 'Character Lab',
  };
}

interface LabFighter {
  rig: CharacterRigDebug;
  loadout: Loadout;
  index: number;
  baseX: number;
  offset: number;
  timelineStep: number;
  kind: string;
}

const fighters: LabFighter[] = [];
const sceneFighters = new THREE.Group();
scene.add(sceneFighters);

function layout(activeCount: number): void {
  for (const f of fighters) {
    f.rig.root.position.set(f.baseX, 0, 0);
    f.rig.root.rotation.y = 0;
    f.rig.root.visible = true;
  }
  if (SOLO >= 0) {
    for (const f of fighters) {
      f.rig.root.visible = f.index === SOLO;
      if (f.index === SOLO) f.rig.root.position.set(0, 0, 0);
    }
  }
  void activeCount;
}

function spawnFighters(): void {
  for (const f of fighters) {
    f.rig.dispose();
  }
  fighters.length = 0;
  for (let i = 0; i < COUNT; i++) {
    const entry = ROSTER[i % ROSTER.length];
    const loadout = buildLoadout(entry);
    const appearance = createAppearance(entry.seed, loadout, loadout.color1, loadout.color2);
    if (entry.scaleBias) appearance.build = Math.max(0.9, Math.min(1.08, appearance.build + entry.scaleBias));
    const rig = createCharacterRig({ loadout, appearance, quality: QUALITY });
    rig.root.position.set((i - (COUNT - 1) / 2) * 0.98, 0, 0);
    rig.root.rotation.y = 0;
    rig.root.name = `lab-fighter-${i}`;
    sceneFighters.add(rig.root);
    fighters.push({
      rig: rig as CharacterRigDebug,
      loadout,
      index: i,
      baseX: rig.root.position.x,
      offset: i * 1.37,
      timelineStep: 0,
      kind: 'idle',
    });
    rig.playAction('spawn');
  }
  layout(COUNT);
}

/* ------------------------------------------------------------------ */
/* Auto cycle                                                          */
/* ------------------------------------------------------------------ */

const LOOP = 24;

type Step = { at: number; label: string; run: (f: LabFighter) => void };

const motion =
  (speed: number, strafe: number, forward: number) =>
    (f: LabFighter): void => f.rig.setMotion(speed, strafe, forward);

const guard =
  (dir: 'left' | 'right' | 'overhead' | 'thrust' | null) =>
    (f: LabFighter): void => f.rig.setGuard(dir);

const attack =
  (dir: 'left' | 'right' | 'overhead' | 'thrust') =>
    (f: LabFighter): void => f.rig.playAttack(dir, 1);

const action =
  (a: 'hit' | 'stagger' | 'kick' | 'dodge' | 'victory' | 'taunt' | 'bash' | 'spawn') =>
    (f: LabFighter): void => f.rig.playAction(a, { dir: new THREE.Vector3(0, 0, 1) });

const STEPS: Step[] = [
  { at: 0.0, label: 'spawn', run: (f) => f.rig.playAction('spawn') },
  { at: 0.95, label: 'idle', run: motion(0, 0, 0) },
  { at: 2.6, label: 'walk', run: motion(3.5, 0, 3.5) },
  { at: 4.9, label: 'run', run: motion(6.1, 0, 6.1) },
  { at: 6.6, label: 'guard right', run: guard('right') },
  { at: 7.8, label: 'guard overhead', run: guard('overhead') },
  { at: 8.9, label: 'attack right', run: (f) => { guard(null)(f); attack('right')(f); } },
  { at: 9.9, label: 'attack left', run: attack('left') },
  { at: 10.9, label: 'attack overhead', run: attack('overhead') },
  { at: 11.9, label: 'attack thrust', run: attack('thrust') },
  { at: 12.9, label: 'hit', run: (f) => { f.rig.setGuard(null); f.rig.setMotion(0, 0, 0); action('hit')(f); } },
  { at: 13.5, label: 'stagger', run: action('stagger') },
  { at: 14.5, label: 'kick', run: action('kick') },
  { at: 15.4, label: 'dodge', run: action('dodge') },
  { at: 16.2, label: 'victory', run: action('victory') },
  { at: 17.9, label: 'taunt', run: action('taunt') },
  { at: 18.9, label: 'idle', run: motion(0, 0, 0) },
  { at: 19.4, label: 'death', run: (f) => { f.rig.setGuard(null); f.rig.playAction('die'); } },
];

function resetForLoop(f: LabFighter): void {
  f.rig.setDead(false);
  f.rig.setGuard(null);
  f.rig.setMotion(0, 0, 0);
  f.rig.playAction('spawn');
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

function soloX(): number {
  if (SOLO < 0) return 0;
  const f = fighters[SOLO];
  return f ? f.rig.root.position.x : 0;
}

function setCamera(view: string): void {
  camera.fov = 42;
  const cx = SOLO >= 0 ? 0 : 0;
  switch (view) {
    case 'front':
      camera.position.set(cx, 1.28, 3.2);
      camera.fov = 40;
      camera.lookAt(cx, 1.02, 0);
      break;
    case 'hero':
      camera.position.set(cx + 0.95, 1.45, 2.75);
      camera.fov = 34;
      camera.lookAt(cx, 1.05, 0);
      break;
    case 'side':
      camera.position.set(3.4, 1.35, 3.15);
      camera.fov = 38;
      camera.lookAt(0, 1.02, 0);
      break;
    case 'orbit':
      camera.position.set(2.4, 1.7, 4.4);
      camera.lookAt(0, 1.05, 0);
      break;
    default:
      camera.position.set(0, 1.62, 7.4);
      camera.fov = 38;
      camera.lookAt(0, 0.98, 0);
      break;
  }
  camera.updateProjectionMatrix();
  void soloX();
}

/* ------------------------------------------------------------------ */
/* Freeze / pose inspection                                            */
/* ------------------------------------------------------------------ */

let paused = false;
let frozen = false;

const POSE_MIX = [
  'idle', 'walk', 'guard-overhead', 'attack-right', 'attack-overhead',
  'death', 'victory', 'attack-thrust',
];

function configurePose(f: LabFighter, kind: string): void {
  f.rig.setDead(false);
  f.rig.setGuard(null);
  f.rig.setMotion(0, 0, 0);
  f.kind = kind;
  if (kind === 'walk') f.rig.setMotion(3.5, 0, 3.5);
  else if (kind === 'run') f.rig.setMotion(6.15, 0, 6.15);
  else if (kind === 'strafe-left') f.rig.setMotion(2.8, -2.8, 0);
  else if (kind === 'strafe-right') f.rig.setMotion(2.8, 2.8, 0);
  else if (kind === 'back') f.rig.setMotion(2.6, 0, -2.6);
  else if (kind.startsWith('guard-')) f.rig.setGuard(kind.slice(6) as 'left' | 'right' | 'overhead' | 'thrust');
  else if (kind.startsWith('attack-')) f.rig.playAttack(kind.slice(7) as 'left' | 'right' | 'overhead' | 'thrust', 1);
  else if (kind === 'die' || kind === 'death') f.rig.playAction('die');
  else if (kind === 'hit' || kind === 'stagger' || kind === 'kick' || kind === 'dodge' ||
    kind === 'victory' || kind === 'taunt' || kind === 'spawn' || kind === 'bash') {
    f.rig.playAction(kind, { dir: new THREE.Vector3(0.4, 0, 1) });
  }
}

function freezeAt(kind: string, t: number): void {
  paused = true;
  frozen = true;
  spawnFighters();
  const kinds = kind === 'mix' ? POSE_MIX : fighters.map(() => kind);
  fighters.forEach((f, i) => {
    configurePose(f, kinds[i % kinds.length]);
  });
  const look = new THREE.Vector3(camera.position.x, 1.45, camera.position.z + 1.2);
  for (const f of fighters) f.rig.setLookTarget(look);
  const steps = Math.max(1, Math.round(t * 120));
  for (const f of fighters) {
    for (let s = 0; s < steps; s++) f.rig.update(1 / 120);
  }
  statAnim.textContent = `${kind} @ ${t.toFixed(2)}s`;
  render();
}

function resumeAuto(): void {
  paused = false;
  frozen = false;
  spawnFighters();
  statAnim.textContent = 'auto cycle';
}

/* ------------------------------------------------------------------ */
/* Update loop                                                         */
/* ------------------------------------------------------------------ */

let simTime = 0;
let lastFrame = performance.now();
let fpsAccum = 0;
let fpsCount = 0;
let hudTimer = 0;
let orbitAngle = 0;

function updateFighters(dt: number): void {
  simTime += dt;
  for (const f of fighters) {
    const local = (simTime + f.offset) % LOOP;
    // Reset on wrap.
    if (local < f.timelineStep) {
      f.timelineStep = 0;
      f.kind = 'spawn';
      resetForLoop(f);
    }
    while (f.timelineStep < STEPS.length && local >= STEPS[f.timelineStep].at) {
      const st = STEPS[f.timelineStep];
      st.run(f);
      if (st.label) f.kind = st.label;
      f.timelineStep++;
    }
    f.rig.update(dt);
  }
  if (!frozen) {
    statAnim.textContent = fighters[0]?.kind ?? 'idle';
  }
}

function updateLook(): void {
  const look = new THREE.Vector3(camera.position.x * 0.35, 1.5, camera.position.z + 1.0);
  for (const f of fighters) f.rig.setLookTarget(look);
}

function render(): void {
  renderer.render(scene, camera);
}

const feetTmp = { left: 0, right: 0 };
const tipTmp = new THREE.Vector3();

function updateStats(): void {
  const info = renderer.info.render;
  const f0 = fighters.find((f) => f.rig.root.visible);
  if (f0) {
    f0.rig.debugFeet(feetTmp);
    f0.rig.debugTip(tipTmp);
    statFoot.textContent = `${(feetTmp.left * 100).toFixed(1)} / ${(feetTmp.right * 100).toFixed(1)} cm`;
    statTip.textContent = `${tipTmp.z.toFixed(2)} m (y ${tipTmp.y.toFixed(2)})`;
  }
  const calls = info.calls;
  const n = Math.max(1, fighters.filter((f) => f.rig.root.visible).length);
  statCalls.textContent = String(calls);
  statPer.textContent = (calls / n).toFixed(1);
  statTris.textContent = info.triangles.toLocaleString('en-US');
  statFighters.textContent = String(n);
}

function frame(now: number): void {
  const rawDt = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = Math.min(0.05, Math.max(0, rawDt));
  fpsAccum += rawDt;
  fpsCount++;

  if (!paused) {
    updateFighters(dt);
    updateLook();
    if (VIEW === 'orbit') {
      orbitAngle += dt * 0.22;
      const r = 4.1;
      camera.position.set(Math.sin(orbitAngle) * r, 1.7, Math.cos(orbitAngle) * r);
      camera.lookAt(0, 1.05, 0);
    }
  }

  render();
  hudTimer += dt;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    updateStats();
    if (fpsCount > 0) {
      statFps.textContent = (fpsCount / Math.max(0.001, fpsAccum)).toFixed(0);
      fpsAccum = 0;
      fpsCount = 0;
    }
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
  }
  if (e.key === 'r' || e.key === 'R') resumeAuto();
});

spawnFighters();
setCamera(VIEW);
updateLook();
if (POSE) {
  const t = FREEZE_T;
  freezeAt(POSE, t);
} else {
  // Settle a moment so the first screenshot is not all spawn poses.
  simTime = 0;
  updateFighters(0.016);
}
render();
updateStats();

interface LabAPI {
  freeze(kind: string, t?: number): void;
  resume(): void;
  setView(view: string): void;
  stats(): { calls: number; triangles: number; fighters: number; perFighter: number };
  meshes(index?: number): string[];
  hide(prefix: string, visible?: boolean): number;
  telemetry(): { feet: { left: number; right: number }; tip: { x: number; y: number; z: number } };
  footCycle(speed: number, strafe?: number, forward?: number): {
    minL: number; maxL: number; minR: number; maxR: number; below: number;
    tL: number; tR: number; minSole: number;
  };
  attackReach(dir: AttackDir): { x: number; y: number; z: number };
  attackArc(dir: AttackDir, enemyZ?: number, index?: number): {
    minDist: number;
    tip: { x: number; y: number; z: number };
    samples: { t: number; x: number; y: number; z: number; d: number }[];
  };
}

(window as unknown as { __lab: LabAPI }).__lab = {
  freeze: (kind: string, t = 0.35) => freezeAt(kind, t),
  resume: () => resumeAuto(),
  setView: (view: string) => setCamera(view),
  stats: () => {
    const info = renderer.info.render;
    const n = Math.max(1, fighters.filter((f) => f.rig.root.visible).length);
    return { calls: info.calls, triangles: info.triangles, fighters: n, perFighter: info.calls / n };
  },
  hide: (prefix: string, visible = false) => {
    let n = 0;
    for (const f of fighters) {
      f.rig.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.name.startsWith(prefix)) {
          o.visible = visible;
          n++;
        }
      });
    }
    renderer.render(scene, camera);
    return n;
  },
  telemetry: () => {
    const f = fighters.find((x) => x.rig.root.visible) ?? fighters[0];
    if (!f) return { feet: { left: 0, right: 0 }, tip: { x: 0, y: 0, z: 0 } };
    f.rig.debugFeet(feetTmp);
    f.rig.debugTip(tipTmp);
    return { feet: { ...feetTmp }, tip: tipTmp.toArray().reduce((acc, v, i) => ({ ...acc, [['x', 'y', 'z'][i]]: v }), {}) as { x: number; y: number; z: number } };
  },
  footCycle: (speed, strafe = 0, forward = speed) => {
    const f = fighters[0];
    if (!f) return { minL: 0, maxL: 0, minR: 0, maxR: 0, below: 0, tL: 0, tR: 0, minSole: 0 };
    paused = true;
    frozen = true;
    f.rig.setDead(false);
    f.rig.setGuard(null);
    f.rig.setMotion(speed, strafe, forward);
    const stats = { minL: 1, maxL: 0, minR: 1, maxR: 0, below: 0, tL: 0, tR: 0, minSole: 1 };
    for (let i = 0; i < 480; i++) {
      f.rig.update(1 / 120);
      f.rig.debugFeet(feetTmp);
      const t = i / 120;
      if (feetTmp.left < stats.minL) stats.minL = feetTmp.left;
      if (feetTmp.left > stats.maxL) { stats.maxL = feetTmp.left; stats.tL = t; }
      if (feetTmp.right < stats.minR) stats.minR = feetTmp.right;
      if (feetTmp.right > stats.maxR) { stats.maxR = feetTmp.right; stats.tR = t; }
      stats.minSole = Math.min(stats.minSole, feetTmp.left, feetTmp.right);
      if (feetTmp.left < -0.01 || feetTmp.right < -0.01) stats.below++;
    }
    f.rig.setMotion(0, 0, 0);
    render();
    return stats;
  },
  attackReach: (dir) => {
    const f = fighters[0];
    if (!f) return { x: 0, y: 0, z: 0 };
    paused = true;
    frozen = true;
    f.rig.setDead(false);
    f.rig.setGuard(null);
    f.rig.setMotion(0, 0, 0);
    for (let i = 0; i < 30; i++) f.rig.update(1 / 120);
    f.rig.playAttack(dir, 1);
    const timing = attackTiming(f.loadout.weapon, 1);
    const contact = timing.windup + timing.active * 0.65;
    for (let t = 0; t < contact; t += 1 / 240) f.rig.update(1 / 240);
    f.rig.debugTip(tipTmp);
    render();
    return { x: tipTmp.x, y: tipTmp.y, z: tipTmp.z };
  },
  attackArc: (dir, enemyZ = 2.1, index = 2) => {
    const f = fighters[index] ?? fighters[0];
    if (!f) return { minDist: 0, tip: { x: 0, y: 0, z: 0 }, samples: [] };
    paused = true;
    frozen = true;
    f.rig.setDead(false);
    f.rig.setGuard(null);
    f.rig.setMotion(0, 0, 0);
    for (let i = 0; i < 30; i++) f.rig.update(1 / 120);
    f.rig.playAttack(dir, 1);
    const timing = attackTiming(f.loadout.weapon, 1);
    const dt = 1 / 240;
    const samples: { t: number; x: number; y: number; z: number; d: number }[] = [];
    let minDist = Infinity;
    let best = { x: 0, y: 0, z: 0 };
    for (let t = 0; t < timing.windup + timing.active; t += dt) {
      f.rig.update(dt);
      f.rig.debugTip(tipTmp);
      const d = Math.hypot(tipTmp.x, tipTmp.z - enemyZ);
      if (t >= timing.windup) {
        samples.push({ t: +t.toFixed(3), x: +tipTmp.x.toFixed(3), y: +tipTmp.y.toFixed(3), z: +tipTmp.z.toFixed(3), d: +d.toFixed(3) });
        if (d < minDist) {
          minDist = d;
          best = { x: +tipTmp.x.toFixed(3), y: +tipTmp.y.toFixed(3), z: +tipTmp.z.toFixed(3) };
        }
      }
    }
    render();
    return { minDist: +minDist.toFixed(3), tip: best, samples };
  },
  meshes: (index = 0) => {
    const f = fighters[index];
    if (!f) return [];
    const names: string[] = [];
    f.rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const mat = (o as THREE.Mesh).material;
        const matType = Array.isArray(mat) ? mat[0]?.type : mat?.type;
        names.push(`${o.name}|${o.visible ? 'v' : 'h'}|${matType ?? '?'}`);
      }
    });
    return names;
  },
};

window.requestAnimationFrame(frame);
(window as unknown as { __ready: boolean }).__ready = true;
