/**
 * GameApp: the glue between the deterministic simulation, the renderer and the
 * DOM UI. Owns the fixed-timestep clock, save/load, selection and player actions.
 */
import type {
  ActionResult,
  BuildingId,
  Content,
  GameSettings,
  GameState,
  OverlayMode,
  ResourceId,
  ViewState,
} from './sim/types';
import type { Difficulty } from './sim/config';
import { RULES, SPEEDS, LIMITS } from './sim/config';
import { buildContent, validateContent } from './sim/content';
import { createNewGame } from './sim/state';
import { tick } from './sim/tick';
import { deserializeState, serializeState, saveToStorage, loadFromStorage, hasSave, SAVE_KEY, AUTOSAVE_KEY } from './sim/save';
import { capitalOf, totalPopulation, dateLabel, clamp } from './sim/core';
import * as Actions from './sim/actions';
import { WorldRenderer } from './render/renderer';
import { createUI, type UIController } from './ui';

export type AppEventName =
  | 'tick'
  | 'action'
  | 'selection'
  | 'decision'
  | 'notification'
  | 'newgame'
  | 'loaded'
  | 'speed'
  | 'paused';

type Listener = (...args: unknown[]) => void;

export class GameApp {
  content: Content;
  state: GameState;
  view: ViewState;
  renderer: WorldRenderer | null = null;
  ui: UIController | null = null;
  paused = false;
  speed = 2;
  private listeners = new Map<AppEventName, Set<Listener>>();
  private accumulator = 0;
  private lastFrame = 0;
  private raf = 0;
  private lastUiRefresh = 0;
  private lastAutosaveDay = -1;
  private decisionPause = false;
  private started = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  fps = 60;
  frameMs = 0;
  contentErrors: string[] = [];

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.content = buildContent();
    const validation = validateContent(this.content);
    this.contentErrors = validation.errors;
    if (validation.errors.length) console.error('[content] validation errors', validation.errors);
    if (validation.warnings.length) console.warn('[content] warnings', validation.warnings);

    // A state is required before renderer/UI construction; replaced by load/newgame.
    this.state = createNewGame(this.content, { seed: 'first-hearth-preview' });
    this.view = {
      tileX: this.state.world.startX,
      tileY: this.state.world.startY,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      hoverTile: -1,
      selectedTile: -1,
      selectedBuildingId: -1,
      selectedCitizenId: -1,
      selectedSettlementId: capitalOf(this.state)?.id ?? -1,
      buildMode: null,
      overlay: 'none',
      showGrid: true,
      showRange: false,
      paused: false,
    };
  }

  // ------------------------------------------------------------------
  // Boot & loop
  // ------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const loaded = this.tryLoad();
    if (!loaded) this.newGame(undefined, 'balanced');
    this.renderer = new WorldRenderer(this, this.canvas);
    this.ui = createUI(this);
    this.renderer.resize();
    const cap = capitalOf(this.state);
    if (cap) this.renderer.centerOnTile(cap.x, cap.y, 1);
    window.addEventListener('resize', () => this.renderer?.resize());
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    this.emit('loaded');
    this.refreshUI();
  }

  private loop = (now: number): void => {
    const dt = Math.min(250, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    this.frameMs = dt;
    this.fps = this.fps * 0.92 + (1000 / Math.max(1, dt)) * 0.08;
    this.advance(dt);
    this.renderer?.render(now);
    if (now - this.lastUiRefresh > 240) {
      this.lastUiRefresh = now;
      this.ui?.refresh();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Advance the simulation by real elapsed milliseconds. */
  advance(dtMs: number): void {
    if (this.paused || this.speed <= 0 || this.state.gameOver) return;
    if (this.state.events.pending.length > 0) return;
    const daysPerSecond = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, this.speed))] ?? 1;
    this.accumulator += (dtMs / 1000) * daysPerSecond;
    let steps = 0;
    const maxSteps = 24;
    while (this.accumulator >= 1 && steps < maxSteps) {
      this.accumulator -= 1;
      this.tickOnce();
      steps++;
      if (this.paused || this.state.events.pending.length > 0) break;
    }
    if (this.accumulator > 4) this.accumulator = 4;
  }

  tickOnce(): void {
    if (this.state.gameOver) return;
    try {
      tick(this.state, this.content, RULES);
    } catch (err) {
      console.error('[sim] tick failed', err);
      this.pause();
      this.toast(`Simulation error: ${(err as Error).message}`, 'bad', 'warning');
      return;
    }
    this.postTick();
  }

  private postTick(): void {
    const s = this.state;
    // Pause for decisions.
    if (s.events.pending.length > 0 && !this.decisionPause) {
      this.decisionPause = true;
      this.pause();
      this.emit('decision');
      this.refreshUI();
    }
    // Autosave.
    if (s.settings.autosave && s.tick - this.lastAutosaveDay >= LIMITS.autosaveIntervalDays) {
      this.lastAutosaveDay = s.tick;
      saveToStorage(s, AUTOSAVE_KEY);
    }
    // A settler expedition has reached its destination: found the new settlement.
    const readyX = s.flags['exploration.settleReadyX'];
    const readyY = s.flags['exploration.settleReadyY'];
    if (typeof readyX === 'number' && typeof readyY === 'number') {
      delete s.flags['exploration.settleReadyX'];
      delete s.flags['exploration.settleReadyY'];
      const fromId = s.flags['exploration.settleReadyFrom'] ?? capitalOf(s)?.id ?? 0;
      delete s.flags['exploration.settleReadyFrom'];
      if (s.settlements.length < LIMITS.maxSettlements) {
        Actions.foundSettlementAt({ state: s, content: this.content, rules: RULES }, Math.round(readyX), Math.round(readyY), fromId);
        this.renderer?.invalidateTerrain();
      }
    }
    // Game over: the last hearth goes dark.
    if (totalPopulation(s) === 0 && !s.gameOver) {
      s.gameOver = { tick: s.tick, cause: 'The last hearth went dark.' };
      this.pause();
      this.emit('decision');
    }
    this.emit('tick');
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  on(event: AppEventName, cb: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  emit(event: AppEventName, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error('[ui] listener failed', err);
      }
    }
  }

  toast(text: string, severity: 'info' | 'good' | 'warn' | 'bad' | 'discovery' | 'milestone' = 'info', icon = 'bell'): void {
    this.emit('notification', { text, severity, icon });
  }

  refreshUI(): void {
    this.ui?.refresh();
  }

  // ------------------------------------------------------------------
  // Time control
  // ------------------------------------------------------------------

  setSpeed(speed: number): void {
    this.speed = clamp(Math.round(speed), 0, SPEEDS.length - 1);
    this.state.settings.speed = this.speed;
    if (this.speed === 0) {
      this.paused = true;
    } else if (!this.decisionPause && this.state.events.pending.length === 0 && !this.state.gameOver) {
      this.paused = false;
    }
    this.view.paused = this.paused;
    this.emit('speed', this.speed);
    this.refreshUI();
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  pause(): void {
    this.paused = true;
    this.view.paused = true;
    this.emit('paused', true);
    this.refreshUI();
  }

  resume(): void {
    if (this.state.events.pending.length > 0) {
      this.emit('decision');
      return;
    }
    if (this.state.gameOver) return;
    this.paused = false;
    this.view.paused = false;
    if (this.speed === 0) {
      this.speed = 2;
      this.state.settings.speed = 2;
    }
    this.emit('paused', false);
    this.emit('speed', this.speed);
    this.refreshUI();
  }

  // ------------------------------------------------------------------
  // Selection & view
  // ------------------------------------------------------------------

  selectTile(x: number, y: number): void {
    this.view.selectedTile = y * this.state.world.width + x;
    this.view.selectedBuildingId = -1;
    this.view.selectedCitizenId = -1;
    const t = this.state.world.tiles[this.view.selectedTile];
    if (t && t.buildingId >= 0) this.view.selectedBuildingId = t.buildingId;
    this.emit('selection');
    this.refreshUI();
  }

  selectBuilding(id: number): void {
    this.view.selectedBuildingId = id;
    const b = this.state.buildings.find((x) => x.id === id);
    if (b) {
      this.view.selectedTile = b.y * this.state.world.width + b.x;
      this.renderer?.centerOnTile(b.x, b.y);
    }
    this.emit('selection');
    this.refreshUI();
  }

  selectCitizen(id: number): void {
    this.view.selectedCitizenId = id;
    this.emit('selection');
    this.refreshUI();
  }

  selectSettlement(id: number): void {
    this.view.selectedSettlementId = id;
    this.emit('selection');
    this.refreshUI();
  }

  setBuildMode(buildingId: BuildingId | null): void {
    this.view.buildMode = buildingId;
    this.view.overlay = buildingId ? 'none' : this.view.overlay;
    this.emit('selection');
    this.refreshUI();
  }

  setOverlay(mode: OverlayMode): void {
    this.view.overlay = mode;
    this.renderer?.setOverlay(mode);
    this.emit('selection');
    this.refreshUI();
  }

  // ------------------------------------------------------------------
  // New game / save / load
  // ------------------------------------------------------------------

  newGame(seed?: string, difficulty: Difficulty = 'balanced', announce = true): void {
    const chosenSeed = (seed ?? '').trim() || randomSeed();
    this.state = createNewGame(this.content, { seed: chosenSeed, difficulty });
    this.speed = 2;
    this.state.settings.speed = 2;
    this.paused = false;
    this.decisionPause = false;
    this.accumulator = 0;
    this.lastAutosaveDay = -1;
    const cap = capitalOf(this.state);
    this.view.selectedSettlementId = cap?.id ?? -1;
    this.view.selectedBuildingId = -1;
    this.view.selectedCitizenId = -1;
    this.view.selectedTile = -1;
    this.view.buildMode = null;
    this.view.overlay = 'none';
    if (this.renderer) {
      this.renderer.invalidateTerrain();
      this.renderer.setOverlay('none');
      if (cap) this.renderer.centerOnTile(cap.x, cap.y, 1);
    }
    this.emit('newgame', chosenSeed);
    this.emit('speed', this.speed);
    this.refreshUI();
    if (announce) this.toast(`A new world: seed “${chosenSeed}”`, 'good', 'seed');
  }

  save(slot: string = SAVE_KEY): boolean {
    const ok = saveToStorage(this.state, slot);
    this.toast(ok ? 'World saved.' : 'Could not save (storage unavailable).', ok ? 'good' : 'bad', 'save');
    return ok;
  }

  load(slot: string = SAVE_KEY): boolean {
    const loaded = loadFromStorage(this.content, slot);
    if (!loaded) {
      this.toast('No save found.', 'warn', 'save');
      return false;
    }
    this.applyLoaded(loaded);
    this.toast('World restored.', 'good', 'save');
    return true;
  }

  private tryLoad(): boolean {
    if (!hasSave(SAVE_KEY)) return false;
    const loaded = loadFromStorage(this.content, SAVE_KEY);
    if (!loaded) return false;
    this.applyLoaded(loaded);
    return true;
  }

  private applyLoaded(loaded: GameState): void {
    this.state = loaded;
    this.paused = true;
    this.speed = loaded.settings.speed || 1;
    this.decisionPause = loaded.events.pending.length > 0;
    this.accumulator = 0;
    this.lastAutosaveDay = loaded.tick;
    const cap = capitalOf(loaded);
    this.view.selectedSettlementId = cap?.id ?? -1;
    this.view.selectedBuildingId = -1;
    this.view.selectedCitizenId = -1;
    this.view.buildMode = null;
    this.view.overlay = 'none';
    this.emit('loaded');
    this.emit('speed', this.speed);
  }

  exportSave(): string {
    return serializeState(this.state);
  }

  importSave(json: string): boolean {
    try {
      const loaded = deserializeState(json, this.content);
      this.applyLoaded(loaded);
      this.renderer?.invalidateTerrain();
      this.toast('Save imported.', 'good', 'save');
      this.refreshUI();
      return true;
    } catch (err) {
      this.toast(`Import failed: ${(err as Error).message}`, 'bad', 'warning');
      return false;
    }
  }

  updateSettings(patch: Partial<GameSettings>): void {
    Object.assign(this.state.settings, patch);
    this.speed = this.state.settings.speed ?? this.speed;
    this.emit('speed', this.speed);
    this.refreshUI();
  }

  // ------------------------------------------------------------------
  // Actions — every UI mutation flows through here
  // ------------------------------------------------------------------

  private run(fn: (a: Actions.ActionContext) => ActionResult, quiet = false): ActionResult {
    const result = fn({ state: this.state, content: this.content, rules: RULES });
    if (result.ok) {
      this.emit('action');
      if (!quiet && result.message) this.toast(result.message, 'good', 'check');
    } else if (result.message) {
      this.toast(result.message, 'warn', 'warning');
    }
    this.refreshUI();
    return result;
  }

  placeBuilding(typeId: BuildingId, x: number, y: number): ActionResult {
    return this.run((a) => Actions.placeBuilding(a, typeId, x, y, this.view.selectedSettlementId));
  }

  canPlaceBuilding(typeId: BuildingId, x: number, y: number) {
    return Actions.placementCheck({ state: this.state, content: this.content, rules: RULES }, typeId, x, y, this.view.selectedSettlementId);
  }

  placeRoad(x: number, y: number): ActionResult {
    return this.run((a) => Actions.placeRoad(a, x, y, this.view.selectedSettlementId));
  }

  removeRoad(x: number, y: number): ActionResult {
    return this.run((a) => Actions.removeRoad(a, x, y));
  }

  roadCheck(x: number, y: number) {
    return Actions.roadCheck({ state: this.state, content: this.content, rules: RULES }, x, y, this.view.selectedSettlementId);
  }

  demolish(buildingId: number): ActionResult {
    return this.run((a) => Actions.demolishBuilding(a, buildingId));
  }

  toggleBuilding(buildingId: number): ActionResult {
    return this.run((a) => Actions.toggleBuilding(a, buildingId));
  }

  setBuildingPriority(buildingId: number, priority: number): ActionResult {
    return this.run((a) => Actions.setBuildingPriority(a, buildingId, priority), true);
  }

  setBuildingRecipe(buildingId: number, recipeId: string): ActionResult {
    return this.run((a) => Actions.setBuildingRecipe(a, buildingId, recipeId));
  }

  setGovernor(patch: Partial<GameState['settlements'][number]['governor']>): ActionResult {
    return this.run((a) => Actions.setGovernor(a, this.view.selectedSettlementId, patch), true);
  }

  chooseTech(techId: string): ActionResult {
    return this.run((a) => Actions.chooseTech(a, techId));
  }

  chooseDoctrine(doctrineId: string): ActionResult {
    return this.run((a) => Actions.chooseDoctrine(a, doctrineId));
  }

  setPolicy(policyId: string, on: boolean): ActionResult {
    return this.run((a) => Actions.setPolicy(a, policyId, on));
  }

  setTaxRate(rate: number): ActionResult {
    return this.run((a) => Actions.setTaxRate(a, rate), true);
  }

  setRations(rations: 'meager' | 'normal' | 'generous'): ActionResult {
    return this.run((a) => Actions.setRations(a, rations));
  }

  setWorkHours(hours: number): ActionResult {
    return this.run((a) => Actions.setWorkHours(a, hours));
  }

  resolveDecision(decisionId: number, choiceId: string): ActionResult {
    const result = this.run((a) => Actions.resolveDecision(a, decisionId, choiceId));
    if (result.ok && this.state.events.pending.length === 0 && this.decisionPause) {
      this.decisionPause = false;
      this.resume();
    }
    return result;
  }

  startExpedition(kind: 'scout' | 'survey' | 'settle', x: number, y: number): ActionResult {
    return this.run((a) => Actions.startExpedition(a, kind, x, y));
  }

  trade(resource: ResourceId, amount: number, direction: 'buy' | 'sell'): ActionResult {
    return this.run((a) => Actions.tradeNow(a, resource, amount, direction));
  }

  startMegaproject(id: string): ActionResult {
    return this.run((a) => Actions.startMegaproject(a, id));
  }

  plantForest(x: number, y: number): ActionResult {
    return this.run((a) => Actions.plantForest(a, x, y, this.view.selectedSettlementId));
  }

  respondToOffer(neighborId: number, offerIndex: number, accept: boolean): ActionResult {
    return this.run((a) => Actions.respondToNeighborOffer(a, neighborId, offerIndex, accept));
  }

  giftToNeighbor(neighborId: number, resource: ResourceId | null, amount: number): ActionResult {
    return this.run((a) => Actions.giftToNeighbor(a, neighborId, resource, amount));
  }

  // ------------------------------------------------------------------
  // Debug / tests
  // ------------------------------------------------------------------

  debugSnapshot(): string {
    return serializeState(this.state);
  }

  advanceDays(days: number): void {
    for (let i = 0; i < days; i++) this.tickOnce();
  }
}

export function randomSeed(): string {
  const words = ['ember', 'river', 'stone', 'moss', 'dawn', 'hearth', 'willow', 'raven', 'thistle', 'ashen', 'moon', 'harvest'];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 900 + 100)}`;
}

export function currentDate(state: GameState): string {
  return dateLabel(state.tick);
}
