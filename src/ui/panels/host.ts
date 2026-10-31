/**
 * The docked centre panel shell. Panels are plain objects: they render an HTML
 * string from current state, and the host diffs it on a slow cadence so focus,
 * hover and scroll survive.
 */
import type { PanelId, Services } from '../util';
import { esc, escAttr, tipText } from '../util';
import { icon } from '../icons';

export interface GamePanel {
  readonly id: PanelId;
  readonly subtitle: string;
  eyebrow(): string;
  title(): string;
  render(): string;
  onOpen?(): void;
  onClose?(): void;
  afterRender?(body: HTMLElement, host: PanelHost): void;
  handleAction?(act: string, el: HTMLElement, host: PanelHost): void;
  handleInput?(input: HTMLInputElement, host: PanelHost): void;
}

interface PanelMeta {
  eyebrow: string;
  title: string;
  subtitle: string;
  icon: string;
}

const META: Record<PanelId, PanelMeta> = {
  codex: { eyebrow: 'The Codex', title: 'Discoveries', subtitle: 'Knowledge, its branches and its cost', icon: 'book' },
  society: { eyebrow: 'The Commons', title: 'Society', subtitle: 'Law, labour and the shape of your people', icon: 'crown' },
  market: { eyebrow: 'The Exchange', title: 'Market', subtitle: 'Prices, trade and what the world will pay', icon: 'market' },
  people: { eyebrow: 'The Ledger', title: 'People', subtitle: 'Who your settlement is made of', icon: 'people' },
  almanac: { eyebrow: 'The Almanac', title: 'The Long Record', subtitle: 'Charts and chronicle of the years', icon: 'chart' },
  diplomacy: { eyebrow: 'The Marches', title: 'Diplomacy', subtitle: 'Neighbour civilisations and their moods', icon: 'handshake' },
  expeditions: { eyebrow: 'The Horizon', title: 'Expeditions', subtitle: 'Send scouts, surveyors and settlers into the unknown', icon: 'compass' },
  wonders: { eyebrow: 'The Great Works', title: 'Wonders', subtitle: 'Undertakings that outlast a lifetime', icon: 'megaproject' },
  objectives: { eyebrow: 'The Path', title: 'Objectives', subtitle: 'What the hearth asks of you next', icon: 'objective' },
};

export class PanelHost {
  readonly root: HTMLElement;
  private headerHost!: HTMLElement;
  private bodyHost!: HTMLElement;
  private panels = new Map<PanelId, GamePanel>();
  private current: GamePanel | null = null;
  private lastHtml = '';
  private lastRender = 0;
  private refreshTimer = 0;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('section');
    this.root.className = 'fh-game-panel';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Game panels');
    this.root.innerHTML = `
      <div class="fh-gp-head" data-js="head"></div>
      <div class="fh-gp-body" data-js="body" tabindex="-1"></div>
    `;
    this.headerHost = this.root.querySelector('[data-js="head"]') as HTMLElement;
    this.bodyHost = this.root.querySelector('[data-js="body"]') as HTMLElement;
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
  }

  destroy(): void {
    window.clearInterval(this.refreshTimer);
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('input', this.onInput);
  }

  register(panel: GamePanel): void {
    this.panels.set(panel.id, panel);
  }

  isOpen(id?: PanelId): boolean {
    if (!this.current) return false;
    return id ? this.current.id === id : true;
  }

  currentId(): PanelId | null {
    return this.current?.id ?? null;
  }

  open(id: PanelId): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    if (this.current && this.current.id !== id) this.current.onClose?.();
    this.current = panel;
    this.root.hidden = false;
    this.root.classList.add('is-open');
    this.root.dataset.panel = id;
    this.lastHtml = '';
    this.headerHost.innerHTML = this.headerHtml(panel);
    panel.onOpen?.();
    this.renderNow(true);
    this.bodyHost.scrollTop = 0;
  }

  close(): void {
    if (!this.current) return;
    this.current.onClose?.();
    this.current = null;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
    this.lastHtml = '';
  }

  toggle(id: PanelId): void {
    if (this.current?.id === id) this.close();
    else this.open(id);
  }

  /** Force an immediate re-render (after a player action). */
  reload(): void {
    if (!this.current) return;
    this.lastRender = 0;
    this.lastHtml = '';
    this.renderNow(true);
    this.refreshHeader();
  }

  /** Slow refresh while open; diffs the rendered HTML. */
  refresh(): void {
    if (!this.current) return;
    const now = performance.now();
    if (now - this.lastRender < 550) return;
    this.renderNow(false);
  }

  private renderNow(force: boolean): void {
    if (!this.current) return;
    // Never rebuild while a slider is being dragged.
    if (!force && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'range' && this.bodyHost.contains(document.activeElement)) return;
    this.lastRender = performance.now();
    let html = '';
    try {
      html = this.current.render();
    } catch (err) {
      console.error('[ui] panel render failed', err);
      html = `<div class="fh-empty"><p class="fh-empty-title">This ledger is unavailable</p><p class="fh-empty-body">${esc((err as Error).message)}</p></div>`;
    }
    if (!force && html === this.lastHtml) return;
    this.lastHtml = html;
    // Preserve focus for search fields.
    const active = document.activeElement;
    let focusKey: string | null = null;
    let caret: number | null = null;
    if (active instanceof HTMLElement && this.bodyHost.contains(active)) {
      focusKey = active.getAttribute('data-focus-key');
      if (active instanceof HTMLInputElement && active.type !== 'range') caret = active.selectionStart;
    }
    this.bodyHost.innerHTML = html;
    if (focusKey) {
      const next = this.bodyHost.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (next instanceof HTMLInputElement) {
        next.focus({ preventScroll: true });
        if (caret !== null) {
          try {
            next.setSelectionRange(caret, caret);
          } catch {
            /* ignore */
          }
        }
      } else if (next) next.focus({ preventScroll: true });
    }
    this.current.afterRender?.(this.bodyHost, this);
  }

  refreshHeader(): void {
    if (!this.current) return;
    this.headerHost.innerHTML = this.headerHtml(this.current);
  }

  private headerHtml(panel: GamePanel): string {
    const meta = META[panel.id];
    return `
      <div class="fh-gp-titles">
        <span class="fh-eyebrow">${icon(meta.icon, 'fh-icon is-tiny')} ${esc(panel.eyebrow())}</span>
        <h2 class="display">${esc(panel.title())}</h2>
        <p class="fh-gp-sub">${esc(panel.subtitle)}</p>
      </div>
      <div class="fh-gp-actions">
        <button type="button" class="fh-iconbtn clickable" data-panel-close aria-label="Close panel" ${tipText('Close (Esc)')}>${icon('close', 'fh-icon')}</button>
      </div>
    `;
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (target.closest('[data-panel-close]')) {
      this.close();
      return;
    }
    const actEl = target.closest<HTMLElement>('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act ?? '';
    if (act === 'panel-close') {
      this.close();
      return;
    }
    this.current?.handleAction?.(act, actEl, this);
  };

  private onInput = (ev: Event): void => {
    const input = ev.target;
    if (input instanceof HTMLInputElement) this.current?.handleInput?.(input, this);
    if (input instanceof HTMLTextAreaElement) {
      /* panels with textareas handle via actions */
    }
  };
}

/** Small helper: accessible section wrapper shared by panel bodies. */
export function panelSection(title: string, body: string, extra = '', hint?: string): string {
  return `<section class="fh-gp-section"${hint ? ` data-tip="${escAttr(hint)}"` : ''}>
    <div class="fh-gp-section-head"><h3>${esc(title)}</h3>${extra ? `<span class="fh-gp-section-extra">${extra}</span>` : ''}</div>
    ${body}
  </section>`;
}
