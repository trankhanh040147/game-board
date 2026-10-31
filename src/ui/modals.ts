/**
 * Modal system + the game's decision points:
 *  - generic keyboard-trapped modal host
 *  - event decision modal (pauses the world)
 *  - game-over screen, era-up banner
 *  - new-game, save/load/settings/help modals
 *  - first-run onboarding overlay
 */
import type { Content, EventChoice, EventEffect, GameState, ModifierKey, PendingDecision } from '../sim/types';
import { MODIFIER_META } from '../sim/types';
import { capitalOf, dateLabel, evalCondition } from '../sim/core';
import { computeMetric } from '../sim/metrics';
import { DIFFICULTIES, type Difficulty } from '../sim/config';
import { AUTOSAVE_KEY, SAVE_KEY, clearSave, downloadSave, hasSave } from '../sim/save';
import { icon } from './icons';
import {
  chip,
  costChips,
  esc,
  modValueText,
  escAttr,
  fmt,
  fmtInt,
  pct,
  pct100,
  pretty,
  roman,
  selectedSettlement,
  signed,
  stateOf,
  tip,
  tipText,
  type Services,
  type SettingsTab,
} from './util';

// ---------------------------------------------------------------------------
// Generic modal host
// ---------------------------------------------------------------------------

export interface ModalConfig {
  id: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  body: string;
  footer?: string;
  className?: string;
  size?: 'm' | 'l' | 'xl';
  dismissible?: boolean;
  onMount?: (modal: HTMLElement) => void;
  onClose?: () => void;
}

interface ModalEntry {
  config: ModalConfig;
  el: HTMLElement;
  restoreFocus: HTMLElement | null;
}

export class ModalHost {
  readonly root: HTMLElement;
  private stack: ModalEntry[] = [];
  private keydownHandler: (ev: KeyboardEvent) => void;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'fh-modal-host';
    this.root.addEventListener('mousedown', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.classList.contains('fh-modal-backdrop')) {
        const entry = this.stack[this.stack.length - 1];
        if (entry?.config.dismissible) this.close(entry.config.id);
      }
    });
    this.keydownHandler = (ev) => this.onKeyDown(ev);
    document.addEventListener('keydown', this.keydownHandler, true);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keydownHandler, true);
    this.root.remove();
  }

  isOpen(id?: string): boolean {
    if (!this.stack.length) return false;
    return id ? this.stack.some((e) => e.config.id === id) : true;
  }

  top(): string | null {
    return this.stack.length ? this.stack[this.stack.length - 1].config.id : null;
  }

  open(config: ModalConfig): void {
    const existing = this.stack.find((e) => e.config.id === config.id);
    if (existing) this.close(config.id);
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = document.createElement('div');
    el.className = `fh-modal-backdrop ${config.className ?? ''}`;
    el.dataset.modalId = config.id;
    const dismiss = config.dismissible !== false;
    el.innerHTML = `
      <div class="fh-modal size-${config.size ?? 'm'}" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="fh-modal-title-${escAttr(config.id)}">
        <header class="fh-modal-head">
          <div class="fh-modal-titles">
            ${config.eyebrow ? `<span class="fh-eyebrow">${esc(config.eyebrow)}</span>` : ''}
            <h2 class="display" id="fh-modal-title-${escAttr(config.id)}">${esc(config.title)}</h2>
            ${config.subtitle ? `<p class="fh-modal-sub">${esc(config.subtitle)}</p>` : ''}
          </div>
          ${
            dismiss
              ? `<button type="button" class="fh-iconbtn fh-modal-close clickable" data-modal-close aria-label="Close dialog">${icon('close', 'fh-icon')}</button>`
              : ''
          }
        </header>
        <div class="fh-modal-body">${config.body}</div>
        ${config.footer ? `<footer class="fh-modal-foot">${config.footer}</footer>` : ''}
      </div>
    `;
    this.root.appendChild(el);
    el.querySelector<HTMLElement>('[data-modal-close]')?.addEventListener('click', () => this.close(config.id));
    el.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const closeBtn = target.closest('[data-modal-close]');
      if (closeBtn) this.close(config.id);
    });
    this.stack.push({ config, el, restoreFocus });
    config.onMount?.(el);
    // Focus the dialog itself (not the first control) so no stray tooltip opens.
    const panel = el.querySelector<HTMLElement>('.fh-modal');
    window.setTimeout(() => panel?.focus({ preventScroll: true }), 20);
    this.syncBody();
  }

  close(id?: string): void {
    const idx = id ? this.stack.findIndex((e) => e.config.id === id) : this.stack.length - 1;
    if (idx < 0) return;
    const [entry] = this.stack.splice(idx, 1);
    const panel = entry.el.querySelector('.fh-modal');
    if (panel) panel.classList.add('is-closing');
    window.setTimeout(() => entry.el.remove(), 170);
    entry.config.onClose?.();
    if (entry.restoreFocus?.isConnected) entry.restoreFocus.focus({ preventScroll: true });
    this.syncBody();
  }

  closeAll(): void {
    while (this.stack.length) this.close();
  }

  /** Close every modal except one id (used when a decision demands attention). */
  closeOthers(keepId: string): void {
    for (const entry of [...this.stack]) {
      if (entry.config.id !== keepId) this.close(entry.config.id);
    }
  }

  private syncBody(): void {
    document.body.classList.toggle('fh-has-modal', this.stack.length > 0);
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (!this.stack.length) return;
    const entry = this.stack[this.stack.length - 1];
    if (ev.key === 'Escape') {
      if (entry.config.dismissible !== false) {
        ev.preventDefault();
        ev.stopPropagation();
        this.close(entry.config.id);
      }
      return;
    }
    if (ev.key === 'Tab') {
      const focusables = Array.from(
        entry.el.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decision modal
// ---------------------------------------------------------------------------

export class DecisionModal {
  private lastKey = '';
  private resolvedQueue: number[] = [];

  constructor(
    private readonly svc: Services,
    private readonly host: ModalHost,
  ) {}

  refresh(): void {
    const s = stateOf(this.svc);
    const pending = s.events.pending ?? [];
    if (!pending.length) {
      if (this.host.isOpen('decision')) this.host.close('decision');
      this.lastKey = '';
      return;
    }
    const decision = pending[0];
    const key = `${decision.id}:${s.tick >> 3}:${pending.length}`;
    if (this.host.isOpen('decision') && this.lastKey === key) return;
    this.lastKey = key;
    // A decision takes precedence over any other dialog on screen.
    this.host.closeOthers('decision');
    this.show(decision, pending.length);
  }

  show(decision: PendingDecision, total: number): void {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const capital = capitalOf(s);
    const choices = decision.choices?.length ? decision.choices : [];
    const body = `
      <div class="fh-decision ${decision.severity >= 3 ? 'is-severe' : decision.severity === 2 ? 'is-serious' : ''}">
        <div class="fh-decision-banner">
          <span class="fh-decision-icon">${icon(decision.icon || 'bell', 'fh-icon is-large')}</span>
          <span class="fh-decision-meta">
            <span class="fh-eyebrow">${esc(pretty(decision.category))} · ${'◆'.repeat(decision.severity)}${'◇'.repeat(3 - decision.severity)}</span>
            <span class="fh-decision-when">${esc(dateLabel(decision.createdTick))}${total > 1 ? ` · ${total} decisions waiting` : ''}</span>
          </span>
        </div>
        ${
          decision.causes?.length
            ? `<div class="fh-causes">${decision.causes.map((cause) => `<span class="fh-cause" ${tipText('Why this has happened')}>${icon('warning', 'fh-icon is-tiny')}${esc(cause)}</span>`).join('')}</div>`
            : ''
        }
        <p class="fh-decision-text serif">${esc(decision.text)}</p>
        <div class="fh-choices">
          ${
            choices.length
              ? choices.map((choice) => this.choiceHtml(choice, decision, capital)).join('')
              : `<p class="fh-faint">No choices — this passes on its own.</p>`
          }
        </div>
      </div>
    `;
    const footer = choices.length
      ? `<span class="fh-faint">Your word will be recorded in the chronicle.</span>`
      : `<button type="button" class="fh-btn is-ember clickable" data-choice="__none" data-decision="${decision.id}">Let it pass</button>`;
    this.host.open({
      id: 'decision',
      title: decision.title,
      eyebrow: 'A decision',
      className: 'fh-modal-decision',
      size: 'l',
      dismissible: false,
      body,
      footer,
      onMount: (modal) => {
        modal.addEventListener('click', (ev) => {
          const target = ev.target;
          if (!(target instanceof Element)) return;
          const btn = target.closest<HTMLElement>('[data-choice]');
          if (!btn) return;
          const choiceId = btn.dataset.choice ?? '';
          const id = Number(btn.dataset.decision);
          if (!Number.isFinite(id)) return;
          btn.classList.add('is-busy');
          if (choiceId === '__none') {
            // Auto-pass: pick the first choice if any; otherwise the sim clears it.
            this.svc.app.resolveDecision(id, decision.choices?.[0]?.id ?? '');
          } else {
            this.svc.app.resolveDecision(id, choiceId);
          }
          this.lastKey = '';
          this.svc.refreshSoon();
          this.refresh();
        });
      },
    });
  }

  private choiceHtml(choice: EventChoice, decision: PendingDecision, capital: ReturnType<typeof capitalOf>): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const missingCosts = choice.cost && capital ? Object.entries(choice.cost).filter(([res, amount]) => (capital.stock[res] ?? 0) + 1e-6 < (amount ?? 0)) : [];
    const affected = capital ?? selectedSettlement(this.svc);
    const reqOk = choice.requires ? evalCondition(choice.requires, s, c, (st, co, metric) => computeMetric(st, co, metric), () => 0.5) : true;
    const disabled = missingCosts.length > 0 || !reqOk;
    const reason = !reqOk ? 'Your people are not ready for this' : missingCosts.length ? `Missing ${missingCosts.map(([res]) => c.resources[res]?.name ?? pretty(res)).join(', ')}` : '';
    const effects = choice.effects?.length ? choice.effects.map((fx) => this.effectText(fx, c)).filter(Boolean) : [];
    return `<button type="button" class="fh-choice ${disabled ? 'is-disabled' : ''} clickable" data-choice="${escAttr(choice.id)}" data-decision="${decision.id}" ${disabled ? 'aria-disabled="true"' : ''} ${tipText(choice.tooltip ?? '')}>
      <span class="fh-choice-label">${icon(disabled ? 'lock' : 'chevron_right', 'fh-icon is-tiny')}${esc(choice.label)}</span>
      <span class="fh-choice-body">
        ${choice.cost ? `<span class="fh-choice-costs">${costChips(c, choice.cost, affected?.stock)}</span>` : ''}
        ${effects.length ? `<span class="fh-choice-effects">${effects.slice(0, 3).map((e) => `<span>${esc(e)}</span>`).join('')}</span>` : ''}
        ${reason ? `<span class="fh-choice-reason">${icon('warning', 'fh-icon is-tiny')}${esc(reason)}</span>` : ''}
      </span>
    </button>`;
  }

  private effectText(fx: EventEffect, c: Content): string {
    switch (fx.kind) {
      case 'stock':
        return `${fx.amount >= 0 ? '+' : ''}${fmt(fx.amount)} ${c.resources[fx.resource]?.name ?? pretty(fx.resource)}`;
      case 'morale':
        return `Morale ${signed(fx.amount, 0)}`;
      case 'health':
        return `Health ${signed(fx.amount, 0)}`;
      case 'treasury':
        return `Treasury ${signed(fx.amount)}`;
      case 'insight':
        return `Insight +${fmt(fx.amount)}`;
      case 'culture':
        return `Culture +${fmt(fx.amount)}`;
      case 'kill':
        return `Lose ${pct(fx.fraction)} of the people`;
      case 'migrate':
        return `${fx.count >= 0 ? '+' : ''}${fx.count} people`;
      case 'tempoModifier':
      case 'settlementModifier':
        return `${pretty(fx.key)} ${signed(fx.value * 100, 0)}% for ${fx.days} days`;
      case 'pollution':
        return `Pollution ${signed(fx.amount * 100, 0)}%`;
      case 'forest':
        return `Forest ${fx.amount >= 0 ? '+' : ''}${fmt(fx.amount * 100, 0)}%`;
      case 'fertility':
        return `Fertility ${fx.amount >= 0 ? '+' : ''}${fmt(fx.amount * 100, 0)}%`;
      case 'relation':
        return `Relations ${signed(fx.amount, 0)}`;
      case 'unlockPolicy':
      case 'unlockBuilding':
        return 'Unlocks something new';
      case 'grantTech':
        return `Discovery: ${c.techs[fx.tech]?.name ?? pretty(fx.tech)}`;
      case 'discoverSite':
        return 'Reveals a site';
      case 'reveal':
        return 'Reveals the land';
      case 'raid':
        return 'Raiders strike';
      case 'spawnRefugees':
        return `${fx.count} refugees arrive`;
      case 'flag':
        return 'Sets a lasting mark';
      default:
        return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------

export class GameOverOverlay {
  private shown = false;

  constructor(
    private readonly svc: Services,
    private readonly host: ModalHost,
  ) {}

  refresh(): void {
    const s = stateOf(this.svc);
    if (s.gameOver && !this.shown) {
      this.shown = true;
      this.show(s);
    }
    if (!s.gameOver) this.shown = false;
  }

  private show(s: GameState): void {
    const stats = s.stats;
    const years = Math.max(1, Math.floor(s.tick / 64) + 1);
    const best = [...s.chronicle].sort((a, b) => b.importance - a.importance).slice(0, 4);
    const body = `
      <div class="fh-gameover">
        <div class="fh-gameover-ember" aria-hidden="true"></div>
        <p class="fh-gameover-cause serif">${esc(s.gameOver?.cause ?? 'The last hearth went dark.')}</p>
        <p class="fh-gameover-copy serif">No one remains to bank the coals. The valley keeps its own counsel now, and the story of your people fades to a story told by others — if it is told at all.</p>
        <div class="fh-gameover-stats">
          <div><span>Years endured</span><b>${fmtInt(years)}</b></div>
          <div><span>Peak population</span><b>${fmtInt(stats.populationPeak)}</b></div>
          <div><span>Discoveries</span><b>${fmtInt(stats.techsResearched)}</b></div>
          <div><span>Buildings raised</span><b>${fmtInt(stats.buildingsBuilt)}</b></div>
          <div><span>Born</span><b>${fmtInt(stats.citizensBorn)}</b></div>
          <div><span>Lost</span><b>${fmtInt(stats.citizensDied)}</b></div>
        </div>
        ${
          best.length
            ? `<div class="fh-gameover-chronicle"><span class="fh-eyebrow">How you are remembered</span>${best
                .map((e) => `<div class="fh-gameover-entry"><span>${esc(e.title)}</span><small>${esc(dateLabel(e.tick))}</small></div>`)
                .join('')}</div>`
            : ''
        }
      </div>
    `;
    this.host.open({
      id: 'gameover',
      title: 'The last hearth goes dark',
      eyebrow: 'An ending',
      className: 'fh-modal-gameover',
      size: 'l',
      dismissible: false,
      body,
      footer: `<button type="button" class="fh-btn is-ember clickable" data-act="new-world">${icon('seed', 'fh-icon is-tiny')} Begin a new world</button>
        <button type="button" class="fh-btn is-quiet clickable" data-act="load-save">${icon('load', 'fh-icon is-tiny')} Restore a save</button>`,
      onMount: (modal) => {
        modal.addEventListener('click', (ev) => {
          const target = ev.target;
          if (!(target instanceof Element)) return;
          const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
          if (act === 'new-world') {
            this.host.close('gameover');
            this.svc.openNewGame();
          } else if (act === 'load-save') {
            this.host.close('gameover');
            this.svc.openSettings('save');
          }
        });
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Era banner
// ---------------------------------------------------------------------------

export class EraBanner {
  readonly root: HTMLElement;
  private timer = 0;
  private lastEra = -1;
  private dismissed = new Set<string>();
  private action: 'codex' | null = null;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('div');
    this.root.className = 'fh-era-banner';
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.root.addEventListener('click', (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest('[data-dismiss]') : null;
      if (target) {
        this.hide();
        return;
      }
      if (this.action === 'codex') {
        this.hide();
        this.svc.openPanel('codex');
      }
    });
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.root.remove();
  }

  refresh(): void {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const era = s.research.era;
    if (this.lastEra < 0) {
      this.lastEra = era;
      return;
    }
    if (era > this.lastEra) {
      this.lastEra = era;
      const def = c.eras[era];
      if (def) this.show(def.name, def.desc, def.unlocksText, `Era ${roman(era + 1)}`);
    }
    // Doctrine offers are also a moment worth flagging.
    if (s.research.doctrineChoices?.length && !s.research.doctrine && !this.dismissed.has('doctrine')) {
      this.dismissed.add('doctrine');
      this.action = 'codex';
      this.show('A creed is offered', 'Your people look for a shape to believe in. A path must be chosen — click here to open the Codex.', 'Choose your doctrine →', 'Doctrine');
    }
  }

  show(title: string, body: string, foot: string, eyebrow: string): void {
    if (eyebrow !== 'Doctrine') this.action = null;
    this.root.hidden = false;
    this.root.classList.add('is-visible');
    this.root.innerHTML = `
      <div class="fh-era-banner-inner">
        <span class="fh-era-banner-glow" aria-hidden="true"></span>
        <span class="fh-eyebrow">${esc(eyebrow)}</span>
        <h2 class="display">${esc(title)}</h2>
        <p class="serif">${esc(body)}</p>
        <span class="fh-era-banner-foot">${esc(foot)}</span>
        <button type="button" class="fh-iconbtn fh-era-banner-close clickable" data-dismiss aria-label="Dismiss">${icon('close', 'fh-icon is-small')}</button>
      </div>
    `;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), 9000);
  }

  hide(): void {
    this.root.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!this.root.classList.contains('is-visible')) this.root.hidden = true;
    }, 320);
  }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const WELCOME_KEY = 'fh.welcome.v1';

export class WelcomeOverlay {
  readonly root: HTMLElement;
  private open = false;
  private wasPaused = false;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('div');
    this.root.className = 'fh-welcome';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Welcome to First Hearth');
    this.root.innerHTML = `
      <div class="fh-welcome-panel">
        <div class="fh-welcome-crest">${icon('flame', 'fh-icon is-crest')}</div>
        <span class="fh-eyebrow">A living valley · a single hearth</span>
        <h1 class="display">First Hearth</h1>
        <p class="fh-welcome-lede serif">One wanderer. An unexplored valley. A fire that must not go out.</p>
        <div class="fh-welcome-grid">
          <article>
            <span class="fh-welcome-num">I</span>
            <h3>Gather &amp; feed</h3>
            <p>Send your first hands to forage, to the woodline, to the stone. Your people eat every day — a store of food is the only thing between a bad season and a grave.</p>
          </article>
          <article>
            <span class="fh-welcome-num">II</span>
            <h3>Build &amp; grow</h3>
            <p>Raise shelters, a well, a granary. Better homes bring children; children bring hands; hands bring surplus. Roads turn distance into time.</p>
          </article>
          <article>
            <span class="fh-welcome-num">III</span>
            <h3>Learn &amp; endure</h3>
            <p>Insight buys discoveries. Discoveries open new work. The valley will test you — drought, blight, wolves and neighbours. Read the warnings; answer the decisions.</p>
          </article>
        </div>
        <div class="fh-welcome-keys">
          <span><kbd>Space</kbd> pause</span><span><kbd>1</kbd>–<kbd>4</kbd> speed</span><span><kbd>B</kbd> build</span><span><kbd>T</kbd> codex</span><span><kbd>Esc</kbd> cancel</span><span><kbd>?</kbd> help</span>
        </div>
        <button type="button" class="fh-btn is-ember is-large clickable" data-act="begin">${icon('flame', 'fh-icon is-small')} Light the hearth</button>
        <p class="fh-welcome-foot">The world is paused while you read. It will keep when you begin.</p>
      </div>
    `;
    this.root.addEventListener('click', (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest('[data-act="begin"]') : null;
      if (target || ev.target === this.root) this.begin();
    });
  }

  destroy(): void {
    this.root.remove();
  }

  shouldShow(): boolean {
    const s = this.svc.app.state;
    if (s.tick > 1 || (s.tutorial?.step ?? 0) > 0) return false;
    try {
      return localStorage.getItem(WELCOME_KEY) !== '1';
    } catch {
      return true;
    }
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.wasPaused = this.svc.app.paused;
    this.svc.app.pause();
    this.root.hidden = false;
    this.root.classList.add('is-visible');
    window.setTimeout(() => this.root.querySelector<HTMLElement>('[data-act="begin"]')?.focus(), 60);
  }

  begin(): void {
    if (!this.open) return;
    this.open = false;
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      /* ignore */
    }
    this.root.classList.remove('is-visible');
    window.setTimeout(() => {
      this.root.hidden = true;
    }, 400);
    if (!this.wasPaused) this.svc.app.resume();
    this.svc.refreshSoon();
  }

  get isOpen(): boolean {
    return this.open;
  }
}

// ---------------------------------------------------------------------------
// New game modal
// ---------------------------------------------------------------------------

export function openNewGameModal(svc: Services, host: ModalHost): void {
  const app = svc.app;
  const seed = randomSeedLocal();
  const difficulty: Difficulty = (app.state.difficulty as Difficulty) ?? 'balanced';
  const difficultyCards = (Object.keys(DIFFICULTIES) as Difficulty[])
    .map((key) => {
      const d = DIFFICULTIES[key];
      const mods = Object.entries(d.mods ?? {})
        .filter(([, v]) => typeof v === 'number' && v !== 0)
        .map(([k, v]) => `${MODIFIER_META[k as ModifierKey]?.label ?? pretty(k)} ${modValueText(k as ModifierKey, v as number)}`);
      return `<button type="button" class="fh-difficulty ${key === difficulty ? 'is-active' : ''} clickable" data-difficulty="${key}" aria-pressed="${key === difficulty}">
        <span class="fh-difficulty-title">${esc(d.label)}</span>
        <span class="fh-difficulty-desc">${esc(d.desc)}</span>
        ${mods.length ? `<span class="fh-difficulty-mods">${mods.slice(0, 4).map((m) => `<span>${esc(m)}</span>`).join('')}</span>` : `<span class="fh-difficulty-mods"><span>the intended balance</span></span>`}
      </button>`;
    })
    .join('');
  const body = `
    <div class="fh-newgame">
      <p class="fh-newgame-intro serif">A new valley will be raised from noise and seed. Your old world is not lost until you save over it — but it will sleep while you begin again.</p>
      <label class="fh-field">
        <span class="fh-field-label">World seed</span>
        <span class="fh-seed-row">
          <input type="text" class="fh-input" data-seed-input value="${escAttr(seed)}" aria-label="World seed" spellcheck="false" autocomplete="off" />
          <button type="button" class="fh-btn is-quiet clickable" data-act="randomize">${icon('spark', 'fh-icon is-tiny')} Randomize</button>
        </span>
        <span class="fh-field-hint">The same seed always grows the same valley, people and all.</span>
      </label>
      <div class="fh-field-label">Difficulty</div>
      <div class="fh-difficulties" role="radiogroup" aria-label="Difficulty">${difficultyCards}</div>
    </div>
  `;
  host.open({
    id: 'newgame',
    title: 'A new world',
    eyebrow: 'Begin again',
    size: 'l',
    body,
    footer: `<button type="button" class="fh-btn is-ghost clickable" data-modal-close>Cancel</button><button type="button" class="fh-btn is-ember clickable" data-act="start">${icon('seed', 'fh-icon is-tiny')} Light a new hearth</button>`,
    onMount: (modal) => {
      const input = modal.querySelector<HTMLInputElement>('[data-seed-input]');
      let chosenDifficulty: Difficulty = difficulty;
      modal.querySelectorAll<HTMLElement>('[data-difficulty]').forEach((el) => {
        el.addEventListener('click', () => {
          chosenDifficulty = el.dataset.difficulty as Difficulty;
          modal.querySelectorAll('[data-difficulty]').forEach((x) => {
            x.classList.toggle('is-active', x === el);
            x.setAttribute('aria-pressed', String(x === el));
          });
        });
      });
      modal.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'randomize') {
          if (input) {
            input.value = randomSeedLocal();
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (act === 'start') {
          const value = (input?.value ?? '').trim() || randomSeedLocal();
          host.close('newgame');
          app.newGame(value, chosenDifficulty);
          host.closeAll();
          svc.refreshSoon();
        }
      });
    },
  });
}

function randomSeedLocal(): string {
  const words = ['ember', 'river', 'stone', 'moss', 'dawn', 'hearth', 'willow', 'raven', 'thistle', 'ashen', 'moon', 'harvest', 'cinder', 'lichen'];
  const a = words[Math.floor(Math.random() * words.length)];
  const b = words[Math.floor(Math.random() * words.length)];
  return `${a}-${b}-${Math.floor(Math.random() * 900 + 100)}`;
}

// ---------------------------------------------------------------------------
// Save / settings / help modal
// ---------------------------------------------------------------------------

export function openSettingsModal(svc: Services, host: ModalHost, initialTab: SettingsTab = 'save'): void {
  const app = svc.app;
  let tab: SettingsTab = initialTab;
  const s = () => stateOf(svc);
  const bodyFor = (): string => {
    const state = s();
    const settings = state.settings;
    const saveExists = hasSave(SAVE_KEY);
    const autosaveExists = hasSave(AUTOSAVE_KEY);
    if (tab === 'save') {
      return `
        <div class="fh-save-tab">
          <div class="fh-save-card">
            <div class="fh-save-card-head">${icon('save', 'fh-icon is-small')}<span><b>This world</b><small>seed ${esc(state.seed)} · ${esc(dateLabel(state.tick))} · ${fmtInt(state.settlements.reduce((n, x) => n + x.population, 0))} people</small></span></div>
            <div class="fh-save-actions">
              <button type="button" class="fh-btn is-ember clickable" data-act="save">${icon('save', 'fh-icon is-tiny')} Save now</button>
              <button type="button" class="fh-btn is-quiet clickable" data-act="load" ${saveExists ? '' : 'disabled'}>${icon('load', 'fh-icon is-tiny')} Load save</button>
              <button type="button" class="fh-btn is-ghost clickable" data-act="load-auto" ${autosaveExists ? '' : 'disabled'}>${icon('hourglass', 'fh-icon is-tiny')} Restore autosave</button>
              <button type="button" class="fh-btn is-ghost clickable" data-act="export">${icon('save', 'fh-icon is-tiny')} Export file</button>
              <button type="button" class="fh-btn is-ghost clickable" data-act="delete" ${saveExists ? '' : 'disabled'}>${icon('close', 'fh-icon is-tiny')} Delete save</button>
            </div>
            <div class="fh-save-note">${autosaveExists ? `An autosave is kept every ${fmt(30)} days.` : 'No autosave yet — it appears after the first month.'} Saves live in this browser only; export a file to keep a world forever.</div>
          </div>
          <div class="fh-import-block">
            <div class="fh-field-label">Import a save file</div>
            <textarea class="fh-textarea" data-import placeholder="Paste save JSON here…" rows="4" aria-label="Save JSON"></textarea>
            <button type="button" class="fh-btn is-quiet clickable" data-act="import">${icon('load', 'fh-icon is-tiny')} Import</button>
          </div>
          <div class="fh-save-meta">
            <div><span>Seed</span><b>${esc(state.seed)}</b></div>
            <div><span>Difficulty</span><b>${esc(DIFFICULTIES[state.difficulty]?.label ?? state.difficulty)}</b></div>
            <div><span>Play days</span><b>${fmtInt(state.tick)}</b></div>
            <div><span>Save version</span><b>v${fmtInt(state.version)}</b></div>
          </div>
        </div>`;
    }
    if (tab === 'settings') {
      const toggle = (key: keyof typeof settings, label: string, hint: string): string =>
        `<button type="button" class="fh-toggle fh-setting-toggle clickable ${settings[key] ? 'is-on' : ''}" data-setting="${key}" aria-pressed="${!!settings[key]}" ${tipText(hint)}>${icon(settings[key] ? 'check' : 'dot', 'fh-icon is-tiny')}<span>${esc(label)}</span></button>`;
      return `
        <div class="fh-settings-tab">
          <div class="fh-settings-group">
            <div class="fh-field-label">Comfort</div>
            <div class="fh-toggle-grid">
              ${toggle('autosave', 'Autosave', 'Write an autosave every 30 days.')}
              ${toggle('showHints', 'Tutorial hints', 'Show onboarding hints as your settlement grows.')}
              ${toggle('tooltips', 'Tooltips', 'Explain numbers on hover.')}
              ${toggle('reducedMotion', 'Reduced motion', 'Still the interface and the world where possible.')}
              ${toggle('colorblind', 'Colourblind palette', 'Shift the palette toward colourblind-safe hues.')}
              ${toggle('autoAssign', 'Auto-assign jobs', 'Let the governor fill jobs automatically.')}
            </div>
          </div>
          <div class="fh-settings-group">
            <div class="fh-field-label">Particle density <b class="fh-field-value" data-fx-value>${fslider(settings.particleDensity)}</b></div>
            <input type="range" min="0" max="1" step="0.05" value="${settings.particleDensity}" data-setting-range="particleDensity" aria-label="Particle density" />
            <div class="fh-field-hint">Smoke, embers, birds and weather effects in the world view.</div>
          </div>
          <div class="fh-settings-group">
            <div class="fh-field-label">Interface scale <b class="fh-field-value" data-scale-value>${Math.round(settings.uiScale * 100)}%</b></div>
            <input type="range" min="0.85" max="1.25" step="0.05" value="${settings.uiScale}" data-setting-range="uiScale" aria-label="Interface scale" />
          </div>
          <div class="fh-settings-group">
            <div class="fh-field-label">World</div>
            <div class="fh-settings-actions">
              <button type="button" class="fh-btn is-quiet clickable" data-act="new-game-dialog">${icon('seed', 'fh-icon is-tiny')} New game…</button>
              <button type="button" class="fh-btn is-ghost clickable" data-act="open-help">${icon('help', 'fh-icon is-tiny')} Shortcuts</button>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="fh-help-tab">
        <div class="fh-help-grid">
          <section>
            <h3>Time</h3>
            <dl><dt><kbd>Space</kbd></dt><dd>Pause / resume</dd><dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Game speed</dd><dt><kbd>0</kbd></dt><dd>Pause</dd></dl>
          </section>
          <section>
            <h3>Panels</h3>
            <dl><dt><kbd>B</kbd></dt><dd>Construction</dd><dt><kbd>T</kbd></dt><dd>Codex</dd><dt><kbd>S</kbd></dt><dd>Society</dd><dt><kbd>M</kbd></dt><dd>Market</dd><dt><kbd>P</kbd></dt><dd>People</dd><dt><kbd>C</kbd></dt><dd>Almanac</dd><dt><kbd>D</kbd></dt><dd>Diplomacy</dd><dt><kbd>E</kbd></dt><dd>Expeditions</dd><dt><kbd>W</kbd></dt><dd>Wonders</dd><dt><kbd>O</kbd></dt><dd>Objectives</dd></dl>
          </section>
          <section>
            <h3>World</h3>
            <dl><dt><kbd>G</kbd></dt><dd>Toggle grid</dd><dt><kbd>F</kbd></dt><dd>Centre on capital</dd><dt><kbd>Esc</kbd></dt><dd>Cancel / close</dd><dt><kbd>?</kbd></dt><dd>This help</dd></dl>
          </section>
          <section>
            <h3>The loop</h3>
            <p class="fh-help-copy">Feed your people. Build shelter, water and storage. Earn insight and discover. Answer decisions with care — the valley remembers. When a warning appears, read its cause before it becomes a crisis.</p>
          </section>
        </div>
        <div class="fh-help-foot">Every number in this interface has a tooltip. Hover anything you do not understand.</div>
      </div>`;
  };
  host.open({
    id: 'settings',
    title: tab === 'save' ? 'Save & load' : tab === 'settings' ? 'Settings' : 'How to play',
    eyebrow: 'The hearth',
    size: 'l',
    body: `
      <div class="fh-settings-tabs" role="tablist">
        <button type="button" role="tab" class="fh-itab clickable ${tab === 'save' ? 'is-active' : ''}" data-settings-tab="save">${icon('save', 'fh-icon is-tiny')} Save</button>
        <button type="button" role="tab" class="fh-itab clickable ${tab === 'settings' ? 'is-active' : ''}" data-settings-tab="settings">${icon('gear', 'fh-icon is-tiny')} Settings</button>
        <button type="button" role="tab" class="fh-itab clickable ${tab === 'help' ? 'is-active' : ''}" data-settings-tab="help">${icon('help', 'fh-icon is-tiny')} Help</button>
      </div>
      <div class="fh-settings-content" data-settings-content>${bodyFor()}</div>
    `,
    onMount: (modal) => {
      const content = modal.querySelector<HTMLElement>('[data-settings-content]') as HTMLElement;
      const titleEl = modal.querySelector<HTMLElement>('.fh-modal-titles h2') as HTMLElement;
      const rerender = (): void => {
        content.innerHTML = bodyFor();
        if (titleEl) titleEl.textContent = tab === 'save' ? 'Save & load' : tab === 'settings' ? 'Settings' : 'How to play';
      };
      modal.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const tabBtn = target.closest<HTMLElement>('[data-settings-tab]');
        if (tabBtn) {
          tab = (tabBtn.dataset.settingsTab as SettingsTab) ?? 'save';
          modal.querySelectorAll('[data-settings-tab]').forEach((b) => b.classList.toggle('is-active', b === tabBtn));
          rerender();
          return;
        }
        const toggle = target.closest<HTMLElement>('[data-setting]');
        if (toggle) {
          const key = toggle.dataset.setting as keyof typeof app.state.settings;
          const current = app.state.settings[key];
          if (typeof current === 'boolean') app.updateSettings({ [key]: !current } as Parameters<typeof app.updateSettings>[0]);
          rerender();
          return;
        }
        const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
        switch (act) {
          case 'save':
            app.save(SAVE_KEY);
            rerender();
            break;
          case 'load':
            host.close('settings');
            app.load(SAVE_KEY);
            break;
          case 'load-auto':
            host.close('settings');
            app.load(AUTOSAVE_KEY);
            break;
          case 'export':
            downloadSave(app.state);
            svc.toast('Save exported to a file.', 'good', 'save');
            break;
          case 'delete':
            clearSave(SAVE_KEY);
            svc.toast('Save deleted.', 'info', 'close');
            rerender();
            break;
          case 'import': {
            const textarea = content.querySelector<HTMLTextAreaElement>('[data-import]');
            if (textarea && textarea.value.trim()) {
              const ok = app.importSave(textarea.value.trim());
              if (ok) {
                host.closeAll();
              }
            } else svc.toast('Paste a save first.', 'warn', 'warning');
            break;
          }
          case 'new-game-dialog':
            host.close('settings');
            svc.openNewGame();
            break;
          case 'open-help':
            tab = 'help';
            modal.querySelectorAll('[data-settings-tab]').forEach((b) => b.classList.toggle('is-active', (b as HTMLElement).dataset.settingsTab === 'help'));
            rerender();
            break;
          default:
            break;
        }
      });
      modal.addEventListener('input', (ev) => {
        const input = ev.target;
        if (!(input instanceof HTMLInputElement)) return;
        const key = input.dataset.settingRange;
        if (key === 'particleDensity' || key === 'uiScale') {
          const value = Number(input.value);
          app.updateSettings({ [key]: value } as Parameters<typeof app.updateSettings>[0]);
          const label = modal.querySelector<HTMLElement>(key === 'uiScale' ? '[data-scale-value]' : '[data-fx-value]');
          if (label) label.textContent = key === 'uiScale' ? `${Math.round(value * 100)}%` : fslider(value);
          if (key === 'uiScale') document.documentElement.style.setProperty('--fh-ui-scale', String(value));
        }
      });
    },
  });
}

function fslider(v: number): string {
  if (v <= 0.02) return 'None';
  if (v < 0.35) return 'Sparse';
  if (v < 0.7) return 'Normal';
  return 'Lush';
}

// Keep content referenced for locale-sensitive formatting helpers.
void chip;
void pct100;
