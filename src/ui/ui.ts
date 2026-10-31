/**
 * BLADE & MOUNT interface.
 *
 * GameUI owns the DOM layer above the Three.js canvas: main menu, HUD, tournament
 * board, intros, results, pause, settings and controls. All copy is driven by the
 * data passed in from the game; the class only formats and presents it.
 */

import '@fontsource/cinzel/500.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/600.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';

import './ui.css';

import type {
  GameMode, GameUIAPI, HudState, Loadout, LogEntry, LogKind, MeleeResultView, Profile,
  RoundIntroView, RoundResultView, Settings, TargetView, TournamentEndView, TournamentView,
  UIHandlers,
} from '../core/types';
import { audio } from '../audio/audio';
import { HudView } from './hud';
import type { UIEnv } from './shared';
import { makeEnv } from './shared';
import { renderMainMenu, renderCredits } from './screens/menu';
import { renderBracket, renderRoundIntro } from './screens/board';
import { renderMeleeResult, renderRoundResult, renderTournamentEnd } from './screens/results';
import { renderControls, renderPause, renderSettings } from './screens/system';
import type { PauseContext } from './screens/system';
import { append, div, span } from './util';

const FALLBACK_SETTINGS: Settings = {
  quality: 'high',
  sensitivity: 1,
  invertY: false,
  masterVolume: 0.85,
  musicVolume: 0.5,
  sfxVolume: 0.85,
  cameraShake: 1,
  showHints: true,
  language: 'en',
  fov: 62,
};

const FALLBACK_PROFILE: Profile = {
  version: 1,
  name: 'The Wanderer',
  denars: 0,
  xp: 0,
  level: 1,
  renown: 0,
  tournamentsWon: 0,
  tournamentsPlayed: 0,
  meleeRuns: 0,
  bestMelee: 0,
  totalKills: 0,
  createdAt: 0,
  lastPlayed: 0,
};

type OverlayKey =
  | 'bracket' | 'intro' | 'roundresult' | 'tournamentend' | 'meleeresult'
  | 'pause' | 'settings' | 'controls' | 'credits';

const OUTCOME_KEYS: OverlayKey[] = ['roundresult', 'tournamentend', 'meleeresult'];

export class GameUI implements GameUIAPI {
  readonly root: HTMLElement;

  private handlers: UIHandlers;
  private profile: Profile;
  private settings: Settings;
  private env: UIEnv;

  private hud: HudView;
  private menuHost: HTMLDivElement;
  private overlayHost: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private damageEl: HTMLDivElement;
  private toastHost: HTMLDivElement;
  private loadingEl: HTMLDivElement;
  private loadingBar: HTMLDivElement;
  private loadingValue: HTMLSpanElement;
  private loadingLabel: HTMLSpanElement;

  private slots = new Map<OverlayKey, HTMLElement>();
  private menuOpen = false;

  private views: {
    bracket?: TournamentView;
    intro?: RoundIntroView;
    roundResult?: RoundResultView;
    tournamentEnd?: TournamentEndView;
    meleeResult?: MeleeResultView;
    pause?: PauseContext | null;
  } = {};

  private lastHud: HudState | null = null;
  private hudLoadout: Loadout | null = null;
  private damage = 0;
  private damageRaf = 0;
  private damageLast = 0;
  private loadVisible = false;
  private timers = new Set<number>();
  private disposed = false;

  constructor(handlers: UIHandlers) {
    this.handlers = handlers;
    this.profile = { ...FALLBACK_PROFILE };
    this.settings = { ...FALLBACK_SETTINGS };

    document.querySelectorAll('#ui-root').forEach((node) => node.remove());
    this.root = document.createElement('div');
    this.root.id = 'ui-root';
    this.root.dataset.lang = this.settings.language;

    this.env = this.makeEnv();

    this.hud = new HudView(this.env);
    this.menuHost = div('bm-menu-host');
    this.overlayHost = div('bm-overlay-host');
    this.toastHost = div('bm-toasts');

    this.fadeEl = div('bm-fade');
    this.damageEl = div('bm-damage');

    this.loadingEl = div('bm-loading');
    this.loadingEl.innerHTML = LOADING_MARKUP;
    this.loadingBar = this.loadingEl.querySelector('.bm-loading-bar') as HTMLDivElement;
    this.loadingValue = this.loadingEl.querySelector('.bm-loading-value') as HTMLSpanElement;
    this.loadingLabel = this.loadingEl.querySelector('.bm-loading-label') as HTMLSpanElement;

    append(this.root, this.hud.root, this.menuHost, this.overlayHost, this.damageEl,
      this.toastHost, this.fadeEl, this.loadingEl);
    document.body.appendChild(this.root);
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  private makeEnv(): UIEnv {
    return makeEnv(
      this.handlers,
      this.profile,
      this.settings,
      () => {
        audio.unlock();
        audio.play('ui-click');
      },
      () => audio.play('ui-hover'),
      (next) => this.applySettings(next),
      () => this.showCredits(),
    );
  }

  private refreshEnv(): void {
    this.env = this.makeEnv();
    this.root.dataset.lang = this.settings.language;
    this.hud.setEnv(this.env);
    this.hud.setProfile(this.profile.name, this.profile.level);
  }

  init(profile: Profile, settings: Settings): void {
    this.profile = { ...profile };
    this.settings = { ...settings };
    this.refreshEnv();
    this.setLoading(null);
  }

  setProfile(profile: Profile): void {
    this.profile = { ...profile };
    this.env.profile = this.profile;
    this.hud.setProfile(this.profile.name, this.profile.level);
    if (this.menuOpen) this.renderMenu();
  }

  updateSettings(settings: Settings): void {
    const languageChanged = settings.language !== this.settings.language;
    const hintsChanged = settings.showHints !== this.settings.showHints;
    this.settings = { ...settings };
    this.refreshEnv();
    if (hintsChanged) this.hud.setHintsEnabled(settings.showHints);
    if (languageChanged) this.rerenderOpen();
    if (this.lastHud) this.hud.update(this.lastHud);
  }

  private applySettings(next: Settings): void {
    this.updateSettings(next);
    this.handlers.onSettingsChanged({ ...this.settings });
  }

  /** Re-render every visible layer (used for live language switches). */
  private rerenderOpen(): void {
    if (this.menuOpen) this.renderMenu();
    if (this.slots.get('bracket')?.classList.contains('is-open') && this.views.bracket) {
      this.buildOverlay('bracket', renderBracket(this.env, this.views.bracket));
    }
    if (this.slots.get('intro')?.classList.contains('is-open') && this.views.intro) {
      this.buildOverlay('intro', renderRoundIntro(this.env, this.views.intro));
    }
    if (this.slots.get('roundresult')?.classList.contains('is-open') && this.views.roundResult) {
      this.buildOverlay('roundresult', renderRoundResult(this.env, this.views.roundResult));
    }
    if (this.slots.get('tournamentend')?.classList.contains('is-open') && this.views.tournamentEnd) {
      this.buildOverlay('tournamentend', renderTournamentEnd(this.env, this.views.tournamentEnd));
    }
    if (this.slots.get('meleeresult')?.classList.contains('is-open') && this.views.meleeResult) {
      this.buildOverlay('meleeresult', renderMeleeResult(this.env, this.views.meleeResult));
    }
    if (this.slots.get('pause')?.classList.contains('is-open')) {
      this.buildOverlay('pause', renderPause(this.env, this.views.pause ?? null));
    }
    if (this.slots.get('settings')?.classList.contains('is-open')) {
      this.buildOverlay('settings', renderSettings(this.env));
    }
    if (this.slots.get('controls')?.classList.contains('is-open')) {
      this.buildOverlay('controls', renderControls(this.env));
    }
    if (this.slots.get('credits')?.classList.contains('is-open')) {
      this.buildOverlay('credits', renderCredits(this.env, () => this.hideOverlay('credits')));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Main menu                                                           */
  /* ------------------------------------------------------------------ */

  private renderMenu(): void {
    this.menuHost.replaceChildren(renderMainMenu(this.env));
  }

  showMainMenu(profile: Profile): void {
    this.profile = { ...profile };
    this.env.profile = this.profile;
    this.hud.setProfile(this.profile.name, this.profile.level);
    this.hud.hide();
    this.closeAllOverlays();
    this.setLoading(null);
    this.renderMenu();
    if (!this.menuOpen) {
      this.menuHost.classList.add('is-open');
      this.menuOpen = true;
    }
    this.sync();
  }

  hideMainMenu(): void {
    if (!this.menuOpen) return;
    this.menuHost.classList.remove('is-open');
    this.menuOpen = false;
    this.hideOverlay('credits');
    this.sync();
  }

  showCredits(): void {
    this.buildOverlay('credits', renderCredits(this.env, () => this.hideOverlay('credits')));
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */

  showHUD(mode: GameMode): void {
    if (this.menuOpen) this.hideMainMenu();
    this.closePhaseScreens();
    this.hud.setLoadout(this.hudLoadout);
    this.hud.show(mode);
    this.sync();
  }

  hideHUD(): void {
    this.hud.hide();
  }

  updateHud(hud: HudState): void {
    this.lastHud = hud;
    this.hud.update(hud);
    this.sync();
  }

  pushLog(entry: Omit<LogEntry, 'id'>): void {
    this.hud.pushLog(entry);
  }

  clearLog(): void {
    this.hud.clearLog();
  }

  setTargetOverlay(target: TargetView | null): void {
    this.hud.setTarget(target);
  }

  /* ------------------------------------------------------------------ */
  /* Tournament board / intros                                           */
  /* ------------------------------------------------------------------ */

  showBracket(view: TournamentView): void {
    this.views.bracket = view;
    this.hudLoadout = view.playerLoadout;
    this.hud.setLoadout(view.playerLoadout);
    this.closePhaseScreens('bracket');
    this.buildOverlay('bracket', renderBracket(this.env, view));
  }

  hideBracket(): void {
    this.hideOverlay('bracket');
  }

  showRoundIntro(view: RoundIntroView): void {
    this.views.intro = view;
    this.hudLoadout = view.loadout;
    this.hud.setLoadout(view.loadout);
    this.closePhaseScreens('intro');
    this.buildOverlay('intro', renderRoundIntro(this.env, view));
  }

  hideRoundIntro(): void {
    this.hideOverlay('intro');
  }

  /* ------------------------------------------------------------------ */
  /* Results                                                             */
  /* ------------------------------------------------------------------ */

  showRoundResult(view: RoundResultView): void {
    this.views.roundResult = view;
    this.closePhaseScreens('roundresult');
    this.buildOverlay('roundresult', renderRoundResult(this.env, view));
  }

  showTournamentEnd(view: TournamentEndView): void {
    this.views.tournamentEnd = view;
    this.closePhaseScreens('tournamentend');
    this.buildOverlay('tournamentend', renderTournamentEnd(this.env, view));
  }

  showMeleeResult(view: MeleeResultView): void {
    this.views.meleeResult = view;
    this.closePhaseScreens('meleeresult');
    this.buildOverlay('meleeresult', renderMeleeResult(this.env, view));
  }

  /* ------------------------------------------------------------------ */
  /* Pause / settings / controls                                        */
  /* ------------------------------------------------------------------ */

  showPause(): void {
    this.hideOverlay('settings');
    this.hideOverlay('controls');
    this.hideOutcomes();
    this.hideOverlay('bracket');
    this.hideOverlay('intro');
    const hud = this.lastHud;
    this.views.pause = hud
      ? {
        roundLabel: hud.roundLabel,
        objective: hud.objective,
        mode: hud.mode,
        denars: hud.denars,
        bet: hud.bet,
      }
      : null;
    this.buildOverlay('pause', renderPause(this.env, this.views.pause ?? null));
  }

  hidePause(): void {
    this.hideOverlay('pause');
    this.hideOverlay('settings');
    this.hideOverlay('controls');
  }

  showSettings(): void {
    this.buildOverlay('settings', renderSettings(this.env));
  }

  hideSettings(): void {
    this.hideOverlay('settings');
  }

  showControls(): void {
    this.buildOverlay('controls', renderControls(this.env));
  }

  hideControls(): void {
    this.hideOverlay('controls');
  }

  /* ------------------------------------------------------------------ */
  /* Toasts / damage / fades / loading                                   */
  /* ------------------------------------------------------------------ */

  toast(text: string, kind: LogKind = 'info'): void {
    const node = div(`bm-toast bm-toast--${kind}`);
    node.appendChild(span('bm-toast-mark'));
    node.appendChild(span('bm-toast-text', text));
    this.toastHost.appendChild(node);
    while (this.toastHost.childElementCount > 3) this.toastHost.firstElementChild?.remove();
    requestAnimationFrame(() => node.classList.add('is-in'));
    const timer = window.setTimeout(() => {
      node.classList.remove('is-in');
      const remove = window.setTimeout(() => node.remove(), 320);
      this.timers.delete(timer);
      this.timers.add(remove);
    }, 3600);
    this.timers.add(timer);
  }

  setDamagePulse(amount01: number): void {
    const value = Math.max(0, Math.min(1, amount01));
    if (value <= 0) return;
    this.damage = Math.max(this.damage, value);
    if (!this.damageRaf) {
      this.damageLast = performance.now();
      this.damageRaf = requestAnimationFrame(this.tickDamage);
    }
  }

  private tickDamage = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.damageLast) / 1000);
    this.damageLast = now;
    this.damage = Math.max(0, this.damage - dt * 2.4);
    this.damageEl.style.opacity = String(Math.min(0.9, this.damage * 0.85));
    if (this.damage > 0.004) {
      this.damageRaf = requestAnimationFrame(this.tickDamage);
    } else {
      this.damageRaf = 0;
      this.damageEl.style.opacity = '0';
    }
  };

  fadeToBlack(ms = 500): Promise<void> {
    this.fadeEl.style.transition = `opacity ${ms}ms ease`;
    this.fadeEl.classList.add('is-black');
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  fadeFromBlack(ms = 500): Promise<void> {
    this.fadeEl.style.transition = `opacity ${ms}ms ease`;
    this.fadeEl.classList.remove('is-black');
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  setLoading(progress: number | null, label?: string): void {
    if (progress === null) {
      if (this.loadVisible) {
        this.loadVisible = false;
        this.loadingEl.classList.remove('is-open');
      }
      return;
    }
    const pct = progress <= 1 ? progress * 100 : progress;
    this.loadVisible = true;
    this.loadingEl.classList.add('is-open');
    this.loadingBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    this.loadingValue.textContent = `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
    this.loadingLabel.textContent = label ?? this.env.tr('loadingForge');
  }

  /* ------------------------------------------------------------------ */
  /* Overlay plumbing                                                    */
  /* ------------------------------------------------------------------ */

  private buildOverlay(key: OverlayKey, content: HTMLElement): void {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = div('bm-overlay-slot');
      slot.dataset.overlay = key;
      this.slots.set(key, slot);
      this.overlayHost.appendChild(slot);
    }
    slot.replaceChildren(content);
    // Hard exclusivity invariant: never more than one modal screen on screen.
    for (const [otherKey, otherSlot] of this.slots) {
      if (otherKey !== key) otherSlot.classList.remove('is-open');
    }
    slot.classList.add('is-open');
    this.overlayHost.appendChild(slot);
    this.sync();
  }

  private hideOverlay(key: OverlayKey): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.classList.remove('is-open');
    this.sync();
  }

  private hideOutcomes(except?: OverlayKey): void {
    for (const key of OUTCOME_KEYS) {
      if (key !== except) this.hideOverlay(key);
    }
  }

  /** Close every screen that must never sit behind a new phase of the game. */
  private closePhaseScreens(except?: OverlayKey): void {
    if (except !== 'intro') this.hideOverlay('intro');
    if (except !== 'bracket') this.hideOverlay('bracket');
    this.hideOutcomes(except);
    if (except !== 'pause') this.hideOverlay('pause');
    if (except !== 'settings') this.hideOverlay('settings');
    if (except !== 'controls') this.hideOverlay('controls');
  }

  private closeAllOverlays(): void {
    for (const key of this.slots.keys()) this.hideOverlay(key);
  }

  private sync(): void {
    let anyOpen = false;
    for (const slot of this.slots.values()) {
      if (slot.classList.contains('is-open')) {
        anyOpen = true;
        break;
      }
    }
    const modal = this.menuOpen || anyOpen || this.loadVisible;
    document.body.classList.toggle('ui-open', modal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    if (this.damageRaf) cancelAnimationFrame(this.damageRaf);
    this.damageRaf = 0;
    this.hud.dispose();
    this.root.remove();
    document.body.classList.remove('ui-open');
  }
}

const LOADING_MARKUP = `
  <div class="bm-loading-inner">
    <div class="bm-loading-crest">
      <svg viewBox="0 0 40 44" fill="none" aria-hidden="true">
        <path d="M20 2 38 7v12c0 10-7 17-18 21C9 36 2 29 2 19V7L20 2Z" fill="rgba(176,141,87,.14)" stroke="#b08d57" stroke-width="1.1"/>
        <path d="M20 10.5 24 16v8h-8v-8l4-5.5Z" fill="none" stroke="#c9a24a" stroke-width="1.2"/>
        <path d="M14 19.5h12M20 20v7" stroke="#c9a24a" stroke-width="1.1"/>
      </svg>
    </div>
    <div class="bm-loading-title">BLADE &amp; MOUNT</div>
    <div class="bm-loading-sub">TOURNAMENT OF THE REALM</div>
    <div class="bm-loading-track"><div class="bm-loading-bar"><i></i></div></div>
    <div class="bm-loading-row">
      <span class="bm-loading-label">Forging the lists…</span>
      <span class="bm-loading-value">0%</span>
    </div>
    <div class="bm-loading-wait">The gates are opening.</div>
  </div>
`;
