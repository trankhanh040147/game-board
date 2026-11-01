/**
 * First-run Game Tour.
 *
 * A spotlight guide over the real interface: eight short steps, each one
 * highlighting the element it talks about, with a small card that can be
 * stepped through by mouse or keyboard. Skippable, replayable from Help, and
 * it never starts while a decision dialog is waiting for an answer.
 */
import { icon } from './icons';
import { esc, escAttr, type Services } from './util';

const TOUR_KEY = 'fh-tour-v1';

interface TourRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TourStep {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  hint?: string;
  target: () => TourRect | null;
  before?: () => void;
}

function rectOf(el: Element | null, pad = 6): TourRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export class Tour {
  readonly root: HTMLElement;
  private hole!: HTMLElement;
  private card!: HTMLElement;
  private blocks: HTMLElement[] = [];
  private active = false;
  private index = 0;
  private wasPaused = false;
  private waitTimer = 0;
  private waitGuard = 0;
  private repositionTimer = 0;
  private steps: TourStep[];

  constructor(private readonly svc: Services) {
    this.root = document.createElement('div');
    this.root.className = 'fh-tour';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="fh-tour-block" data-block="top"></div>
      <div class="fh-tour-block" data-block="bottom"></div>
      <div class="fh-tour-block" data-block="left"></div>
      <div class="fh-tour-block" data-block="right"></div>
      <div class="fh-tour-hole" aria-hidden="true"><span class="fh-tour-pulse"></span></div>
      <div class="fh-tour-card" role="dialog" aria-modal="true" aria-label="Game tour" tabindex="-1"></div>
    `;
    this.hole = this.root.querySelector('.fh-tour-hole') as HTMLElement;
    this.card = this.root.querySelector('.fh-tour-card') as HTMLElement;
    this.blocks = Array.from(this.root.querySelectorAll<HTMLElement>('.fh-tour-block'));
    this.root.addEventListener('click', this.onClick);
    this.steps = this.buildSteps();
  }

  destroy(): void {
    this.stopTimers();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  isActive(): boolean {
    return this.active;
  }

  shouldStart(): boolean {
    try {
      return localStorage.getItem(TOUR_KEY) !== 'done';
    } catch {
      return true;
    }
  }

  private q<T extends Element = HTMLElement>(sel: string): T | null {
    return document.querySelector<T>(sel);
  }

  /** Map area between the build column and the inspector. */
  private mapArea(): TourRect {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rail = this.q('.fh-rail');
    const inspect = this.q('.fh-inspector');
    const hud = this.q('.fh-hud');
    const mini = this.q('.fh-minimap');
    const left = rail ? rail.getBoundingClientRect().right + 18 : 60;
    const right = inspect ? inspect.getBoundingClientRect().left - 18 : vw - 330;
    const top = hud ? hud.getBoundingClientRect().bottom + 18 : 100;
    const bottom = mini ? mini.getBoundingClientRect().top - 18 : vh - 280;
    return { x: left, y: top, w: Math.max(180, right - left), h: Math.max(140, bottom - top) };
  }

  private centerMap(size = 440): TourRect {
    const area = this.mapArea();
    const w = Math.min(size, area.w - 40);
    const h = Math.min(size * 0.62, area.h - 40);
    return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
  }

  private buildSteps(): TourStep[] {
    const hudBottom = (): number => (this.q('.fh-hud')?.getBoundingClientRect().bottom ?? 92) + 14;
    return [
      {
        id: 'welcome',
        eyebrow: 'The tour · 1 of 8',
        title: 'A fire in an empty valley',
        body: 'You have one settler, a fire, and a whole valley. Keep your people fed, sheltered and curious — everything else follows from those three.',
        hint: 'This guide takes about a minute. Skip it any time with Esc.',
        target: () => this.mapArea(),
      },
      {
        id: 'map',
        eyebrow: 'The tour · 2 of 8',
        title: 'Your valley',
        body: 'This is your settlement and the land around it. Click any tile to inspect it, drag to pan, and use the wheel to zoom.',
        hint: 'Right-click cancels a build or a tool.',
        target: () => this.centerMap(460),
        before: () => this.svc.closePanel(),
      },
      {
        id: 'vitals',
        eyebrow: 'The tour · 3 of 8',
        title: 'The survival clocks',
        body: 'The top bar is your people’s pulse. Food and water are measured in days left — when they run out, people starve. Morale keeps them working and staying; Insight buys discoveries.',
        hint: 'Hover any number for an explanation.',
        target: () => rectOf(this.q('.fh-hud'), 2),
      },
      {
        id: 'build',
        eyebrow: 'The tour · 4 of 8',
        title: 'Raise the first roofs',
        body: 'Everything you build lives here. Start with a Forager’s Camp for food, then a Lean-to for shelter, then a Well for water. Costs are drawn from your stores.',
        hint: 'Press B to open or close this panel at any time.',
        target: () => rectOf(this.q('.fh-build-panel')),
        before: () => {
          this.svc.closePanel();
          this.svc.focusBuild('gathering');
        },
      },
      {
        id: 'speed',
        eyebrow: 'The tour · 5 of 8',
        title: 'Let the days turn',
        body: 'Space pauses and resumes. 1–4 set the pace — slow enough to watch, fast enough to reach a season. The world always pauses when a decision waits.',
        hint: 'Paused? The active button glows and the HUD says PAUSED.',
        target: () => rectOf(this.q('.fh-speed'), 8) ?? { x: 24, y: hudBottom(), w: 200, h: 48 },
      },
      {
        id: 'codex',
        eyebrow: 'The tour · 6 of 8',
        title: 'The Codex',
        body: 'Spend Insight on discoveries here. Cultivation unlocks farms; Firekeeping steadies morale; water and storage techs carry you through winter. Pick one path and follow it.',
        hint: 'Insight comes from scholars — and from a curious people.',
        target: () => rectOf(this.q('[data-rail="codex"]'), 8),
        before: () => this.svc.openPanel('codex'),
      },
      {
        id: 'objectives',
        eyebrow: 'The tour · 7 of 8',
        title: 'First steps & the next age',
        body: 'Your First Steps checklist tracks the opening: feed, shelter, water, a discovery, a farm, five souls, a granary. Finish them and you stand at the threshold of Era I.',
        hint: 'The checklist sits above the minimap — click a step to jump to it.',
        target: () => rectOf(this.q('[data-rail="objectives"]'), 8),
        before: () => this.svc.openPanel('objectives'),
      },
      {
        id: 'decisions',
        eyebrow: 'The tour · 8 of 8',
        title: 'When the world asks',
        body: 'Now and then a decision will pause the world and ask for your word. Read the causes, weigh the costs — or choose “Let it pass”. Warnings appear as alerts; read the cause and act early.',
        hint: 'You can replay this tour later from Help (?) at any time.',
        target: () => rectOf(this.q('.fh-alert-pill:not([hidden])'), 6) ?? rectOf(this.q('.fh-hud-controls'), 4),
        before: () => this.svc.closePanel(),
      },
    ];
  }

  /** Start the tour. Returns false when it cannot start right now. */
  start(force = false): boolean {
    if (this.active) return false;
    if (!force && !this.shouldStart()) return false;
    const s = this.svc.app.state;
    if ((s.events.pending?.length ?? 0) > 0 || document.querySelector('.fh-modal-host .fh-modal:not(.is-closing)')) {
      // Wait for the player to finish the current decision/dialog first.
      if (this.waitTimer) return false;
      this.waitGuard = 0;
      this.svc.toast('The tour will begin once the world is quiet.', 'info', 'compass');
      this.waitTimer = window.setInterval(() => {
        this.waitGuard += 1;
        const pendingNow = (this.svc.app.state.events.pending?.length ?? 0) > 0 || !!document.querySelector('.fh-modal-host .fh-modal:not(.is-closing)');
        if (!pendingNow || this.waitGuard > 60) {
          window.clearInterval(this.waitTimer);
          this.waitTimer = 0;
          if (!pendingNow) this.start(force);
        }
      }, 700);
      return false;
    }
    this.active = true;
    this.index = 0;
    this.wasPaused = this.svc.app.paused;
    this.svc.app.pause();
    this.root.hidden = false;
    this.root.classList.add('is-visible');
    document.body.classList.add('fh-tour-open');
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    this.repositionTimer = window.setInterval(() => this.position(), 450);
    this.renderStep();
    window.setTimeout(() => this.focusCard(), 120);
    return true;
  }

  next(): void {
    if (this.index >= this.steps.length - 1) {
      this.finish(false);
      return;
    }
    this.index += 1;
    this.renderStep();
  }

  prev(): void {
    if (this.index <= 0) return;
    this.index -= 1;
    this.renderStep();
  }

  /** Called when something (a decision) needs the screen: hide without marking done. */
  abort(): void {
    if (!this.active) return;
    this.active = false;
    this.stopTimers();
    this.root.classList.remove('is-visible');
    this.root.hidden = true;
    document.body.classList.remove('fh-tour-open');
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    if (!this.wasPaused && (this.svc.app.state.events.pending?.length ?? 0) === 0) this.svc.app.resume();
  }

  private finish(skipped: boolean): void {
    if (!this.active) return;
    this.active = false;
    this.stopTimers();
    this.root.classList.remove('is-visible');
    this.root.hidden = true;
    document.body.classList.remove('fh-tour-open');
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    try {
      localStorage.setItem(TOUR_KEY, 'done');
    } catch {
      /* ignore */
    }
    this.svc.closePanel();
    if (!this.wasPaused) this.svc.app.resume();
    this.svc.toast(
      skipped ? 'Tour skipped — you can replay it from Help.' : 'Tour complete — replay it any time from Help.',
      skipped ? 'info' : 'good',
      'compass',
    );
    this.svc.refreshSoon();
  }

  private stopTimers(): void {
    if (this.waitTimer) {
      window.clearInterval(this.waitTimer);
      this.waitTimer = 0;
    }
    if (this.repositionTimer) {
      window.clearInterval(this.repositionTimer);
      this.repositionTimer = 0;
    }
  }

  private onResize = (): void => this.position();

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderStep(): void {
    const step = this.steps[this.index];
    step.before?.();
    // Give the layout one frame to settle after opening/closing panels.
    window.setTimeout(() => this.position(), 20);
    window.setTimeout(() => this.position(), 280);
    this.card.innerHTML = `
      <div class="fh-tour-head">
        <span class="fh-eyebrow">${icon('compass', 'fh-icon is-tiny')} ${esc(step.eyebrow)}</span>
        <span class="fh-tour-counter">${this.index + 1} / ${this.steps.length}</span>
      </div>
      <h2 class="display">${esc(step.title)}</h2>
      <p class="fh-tour-body">${esc(step.body)}</p>
      ${step.hint ? `<div class="fh-tour-hint">${icon('spark', 'fh-icon is-tiny')}<span>${esc(step.hint)}</span></div>` : ''}
      <div class="fh-tour-dots" role="tablist" aria-label="Tour steps">
        ${this.steps
          .map(
            (s, i) =>
              `<button type="button" class="fh-tour-dot clickable ${i === this.index ? 'is-active' : ''} ${i < this.index ? 'is-done' : ''}" data-act="goto" data-index="${i}" role="tab" aria-selected="${i === this.index}" aria-label="Step ${i + 1}: ${escAttr(s.title)}"></button>`,
          )
          .join('')}
      </div>
      <div class="fh-tour-actions">
        <button type="button" class="fh-tour-skip clickable" data-act="skip">Skip tour</button>
        <span class="fh-tour-spacer"></span>
        <button type="button" class="fh-btn is-ghost clickable" data-act="prev" ${this.index === 0 ? 'disabled' : ''}>${icon('chevron_left', 'fh-icon is-tiny')} Back</button>
        <button type="button" class="fh-btn is-ember clickable" data-act="next">
          ${this.index === this.steps.length - 1 ? `${icon('flame', 'fh-icon is-tiny')} Begin your watch` : `Next ${icon('chevron_right', 'fh-icon is-tiny')}`}
        </button>
      </div>
      <div class="fh-tour-keys"><kbd>←</kbd><kbd>→</kbd> step · <kbd>Enter</kbd> next · <kbd>Esc</kbd> skip</div>
    `;
  }

  private cardPlacement(rect: TourRect, vw: number, vh: number, cardW: number, cardH: number): { x: number; y: number } {
    const m = 18;
    const hud = this.q('.fh-hud')?.getBoundingClientRect();
    if (hud && rect.y < hud.bottom + 2 && rect.y + rect.h <= hud.bottom + 6) {
      // Targets inside the HUD: put the card just under the bar.
      return { x: clamp(rect.x + rect.w / 2 - cardW / 2, m, vw - cardW - m), y: clamp(hud.bottom + 16, m, vh - cardH - m) };
    }
    const spaceRight = vw - (rect.x + rect.w) - m;
    const spaceLeft = rect.x - m;
    if (rect.w < vw * 0.42) {
      if (spaceRight >= cardW) {
        return { x: rect.x + rect.w + 16, y: clamp(rect.y + rect.h / 2 - cardH / 2, m, vh - cardH - m) };
      }
      if (spaceLeft >= cardW) {
        return { x: rect.x - cardW - 16, y: clamp(rect.y + rect.h / 2 - cardH / 2, m, vh - cardH - m) };
      }
    }
    const spaceBelow = vh - (rect.y + rect.h) - m;
    if (spaceBelow >= cardH + 8) {
      return { x: clamp(rect.x + rect.w / 2 - cardW / 2, m, vw - cardW - m), y: rect.y + rect.h + 16 };
    }
    const spaceAbove = rect.y - m;
    if (spaceAbove >= cardH + 8) {
      return { x: clamp(rect.x + rect.w / 2 - cardW / 2, m, vw - cardW - m), y: rect.y - cardH - 16 };
    }
    // Large highlight: sit inside it, bottom-left.
    return { x: clamp(rect.x + 26, m, vw - cardW - m), y: clamp(rect.y + rect.h - cardH - 26, m, vh - cardH - m) };
  }

  private position(): void {
    if (!this.active) return;
    const step = this.steps[this.index];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let rect = step.target();
    if (!rect) rect = this.centerMap(360);
    // Keep the highlight on screen.
    const x = clamp(rect.x, 2, vw - 40);
    const y = clamp(rect.y, 2, vh - 40);
    const w = clamp(rect.w, 24, vw - x - 2);
    const h = clamp(rect.h, 24, vh - y - 2);
    const safe: TourRect = { x, y, w, h };
    this.hole.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    this.hole.style.width = `${Math.round(w)}px`;
    this.hole.style.height = `${Math.round(h)}px`;

    const [top, bottom, left, right] = this.blocks;
    if (top) Object.assign(top.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${Math.max(0, y)}px`, display: y > 0 ? 'block' : 'none' });
    if (bottom) Object.assign(bottom.style, { left: '0px', top: `${y + h}px`, width: `${vw}px`, height: `${Math.max(0, vh - y - h)}px`, display: vh - y - h > 0 ? 'block' : 'none' });
    if (left) Object.assign(left.style, { left: '0px', top: `${y}px`, width: `${Math.max(0, x)}px`, height: `${Math.round(h)}px`, display: x > 0 ? 'block' : 'none' });
    if (right) Object.assign(right.style, { left: `${x + w}px`, top: `${y}px`, width: `${Math.max(0, vw - x - w)}px`, height: `${Math.round(h)}px`, display: vw - x - w > 0 ? 'block' : 'none' });

    const cardW = Math.min(430, vw - 32);
    this.card.style.width = `${cardW}px`;
    const cardH = this.card.offsetHeight || 240;
    const pos = this.cardPlacement(safe, vw, vh, cardW, cardH);
    const hudBottom = this.q('.fh-hud')?.getBoundingClientRect().bottom ?? 92;
    if (safe.y >= hudBottom) pos.y = Math.max(pos.y, hudBottom + 12);
    this.card.style.transform = `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`;
    this.root.classList.toggle('is-card-above', pos.y + cardH / 2 < y + h / 2);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-act]') : null;
    if (!target) return;
    switch (target.dataset.act) {
      case 'next':
        this.next();
        break;
      case 'prev':
        this.prev();
        break;
      case 'skip':
        this.finish(true);
        break;
      case 'goto': {
        const i = Number(target.dataset.index);
        if (Number.isFinite(i)) {
          this.index = clamp(i, 0, this.steps.length - 1);
          this.renderStep();
        }
        break;
      }
      default:
        break;
    }
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.active) return;
    const key = ev.key;
    if (key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.finish(true);
      return;
    }
    if (key === 'ArrowRight' || key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      this.next();
      return;
    }
    if (key === 'ArrowLeft') {
      ev.preventDefault();
      ev.stopPropagation();
      this.prev();
      return;
    }
    if (key === 'Tab') {
      const focusables = Array.from(this.card.querySelectorAll<HTMLElement>('button:not([disabled])')).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === this.card)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };

  /** Focus the tour card for keyboard users. */
  focusCard(): void {
    this.card.focus({ preventScroll: true });
  }

  stepIndex(): number {
    return this.index;
  }

  stepCount(): number {
    return this.steps.length;
  }
}
