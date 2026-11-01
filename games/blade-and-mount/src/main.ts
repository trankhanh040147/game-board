import './style.css';
import { Engine } from './core/engine';
import { Input } from './core/input';
import type { UIHandlers } from './core/types';
import { Game } from './game/game';
import { loadProfile, loadSettings } from './game/profile';
import { GameUI } from './ui/ui';
import { audio } from './audio/audio';
import {
  getAnimationMode,
  loadBakedAnimatorLibrary,
  setAnimationMode,
  setBakedAnimationLibrary,
  type AnimationMode,
  type BakedClipLibrary,
} from './characters/bakedAnimator';
import { setLiveAnimationMode } from './characters/rig';

const gameRoot = document.getElementById('game-root');
if (!gameRoot) throw new Error('Missing #game-root');

const profile = loadProfile();
const settings = loadSettings();

let engine: Engine;
try {
  engine = new Engine(gameRoot, settings.quality);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  document.body.innerHTML = `<div class="fatal">WebGL could not be initialised.<br><small>${message}</small></div>`;
  throw err;
}
const input = new Input(engine.canvas);

// ---- Baked animation library (KayKit Knight retarget, CC0) --------------
// Loaded once before the game constructs any fighter. A failure or slow fetch
// falls back to the procedural animator without crashing. `?anim=procedural`
// forces the procedural path for QA/comparison.
const ANIM_URL = `${import.meta.env.BASE_URL}assets/knight-anim.json`;
const animParam = new URLSearchParams(location.search).get('anim');
const forceProcedural = animParam === 'procedural';
let bakedLibrary: BakedClipLibrary | null = null;
if (!forceProcedural) {
  try {
    bakedLibrary = await Promise.race([
      loadBakedAnimatorLibrary(ANIM_URL),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!bakedLibrary) console.warn('[animation] baked clips timed out; using procedural animation');
  } catch (err) {
    console.warn('[animation] baked clips unavailable; using procedural animation', err);
  }
}
setBakedAnimationLibrary(bakedLibrary);
setAnimationMode(forceProcedural || !bakedLibrary ? 'procedural' : 'baked');
if (!forceProcedural && bakedLibrary) {
  console.info(`[animation] baked clips loaded (${Object.keys(bakedLibrary.clips).length} clips)`);
}

let game: Game;
const handlers: UIHandlers = {
  onStartTournament: () => game.startTournament(),
  onStartMelee: () => game.startMelee(),
  onResume: () => game.resume(),
  onRestart: () => game.restart(),
  onQuitToMenu: () => game.quitToMenu(),
  onBet: (amount) => game.placeBet(amount),
  onEnterRound: () => game.enterRound(),
  onContinue: () => game.continueAfterResult(),
  onSettingsChanged: (s) => game.applySettings(s),
  onLanguageToggle: () => game.toggleLanguage(),
  onOpenSettings: () => game.openSettings(),
  onOpenControls: () => game.openControls(),
  onCloseOverlay: () => game.closeOverlay(),
};

const ui = new GameUI(handlers);
game = new Game(engine, input, ui, profile, settings);
game.start();

interface DebugApi {
  game: Game;
  getState: () => Record<string, unknown>;
  startTournament: () => void;
  startMelee: () => void;
  enterRound: () => void;
  continueResult: () => void;
  killEnemies: () => void;
  pause: () => void;
  resume: () => void;
  audioUnlock: () => void;
  audioDiagnostics: () => unknown;
  setQuality: (q: 'low' | 'medium' | 'high') => void;
  setAnimationMode: (mode: AnimationMode) => void;
  animationMode: () => AnimationMode;
}

const debug: DebugApi = {
  game,
  getState: () => game.getDebugState(),
  startTournament: () => game.debugStartTournament(),
  startMelee: () => game.debugStartMelee(),
  enterRound: () => game.debugEnterRound(),
  continueResult: () => game.debugContinue(),
  killEnemies: () => game.debugKillEnemies(),
  pause: () => game.debugPause(),
  resume: () => game.debugResume(),
  audioUnlock: () => audio.unlock(),
  audioDiagnostics: () => {
    const engine = audio as unknown as { getDiagnostics?: () => unknown };
    return engine.getDiagnostics?.() ?? { available: false };
  },
  setQuality: (q) => game.applySettings({ ...game.settings, quality: q }),
  setAnimationMode: (mode) => {
    const count = setLiveAnimationMode(mode);
    console.info(`[animation] mode -> ${mode} (${count} live rigs swapped)`);
  },
  animationMode: () => getAnimationMode(),
};

declare global {
  interface Window {
    __game?: DebugApi;
    __ready?: boolean;
  }
}
window.__game = debug;

let last = performance.now();
let firstFrame = true;
function loop(now: number): void {
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = Math.min(0.05, Math.max(0, rawDt));
  try {
    game.update(dt);
    engine.update(dt);
    engine.render();
  } catch (err) {
    console.error('Game loop error', err);
  }
  input.endFrame();
  if (firstFrame) {
    firstFrame = false;
    window.__ready = true;
    document.body.classList.add('game-ready');
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
