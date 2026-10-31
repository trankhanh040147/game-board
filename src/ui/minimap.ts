/**
 * Minimap panel (bottom-left): creates the canvas the renderer paints into,
 * overlay selector and legend. The UI never draws into the canvas itself.
 */
import type { OverlayMode } from '../sim/types';
import { icon } from './icons';
import { escAttr, pct, stateOf, tipText, type Services } from './util';

interface OverlayMeta {
  mode: OverlayMode;
  label: string;
  icon: string;
  gradient: string;
  low: string;
  high: string;
}

const OVERLAYS: OverlayMeta[] = [
  { mode: 'fertility', label: 'Fertility', icon: 'wheat', gradient: 'linear-gradient(90deg,#3c4a2a,#9bc25e)', low: 'poor', high: 'rich' },
  { mode: 'forest', label: 'Forest', icon: 'tree', gradient: 'linear-gradient(90deg,#2c3524,#8fb56a)', low: 'bare', high: 'dense' },
  { mode: 'water', label: 'Water', icon: 'drop', gradient: 'linear-gradient(90deg,#2b3b40,#6fb7cf)', low: 'dry', high: 'wet' },
  { mode: 'pollution', label: 'Pollution', icon: 'cloud', gradient: 'linear-gradient(90deg,#3a2a22,#8a3d2c)', low: 'clean', high: 'foul' },
  { mode: 'beauty', label: 'Beauty', icon: 'leaf', gradient: 'linear-gradient(90deg,#3a3430,#d4a97a)', low: 'drab', high: 'sublime' },
  { mode: 'deposits', label: 'Deposits', icon: 'ore', gradient: 'linear-gradient(90deg,#4a3a26,#c9a55b)', low: 'none', high: 'rich' },
  { mode: 'roads', label: 'Roads', icon: 'road', gradient: 'linear-gradient(90deg,#3a3226,#cbb98f)', low: 'track', high: 'highway' },
  { mode: 'population', label: 'People', icon: 'people', gradient: 'linear-gradient(90deg,#3a2c24,#e07a37)', low: 'empty', high: 'crowded' },
  { mode: 'supply', label: 'Supply', icon: 'cart', gradient: 'linear-gradient(90deg,#34302a,#7fb069)', low: 'cut off', high: 'connected' },
  { mode: 'resources', label: 'Sites', icon: 'pin', gradient: 'linear-gradient(90deg,#3a3026,#b48ad6)', low: 'known', high: 'legendary' },
];

export class MinimapPanel {
  readonly root: HTMLElement;
  private legendHost!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private overlayHost!: HTMLElement;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('aside');
    this.root.className = 'fh-minimap';
    this.root.setAttribute('aria-label', 'Minimap and map overlays');
    this.root.innerHTML = `
      <div class="fh-mini-head">
        <span class="fh-eyebrow">The valley</span>
        <span class="fh-mini-reveal" data-js="reveal">—</span>
      </div>
      <div class="fh-mini-frame">
        <canvas id="minimap" width="336" height="336" aria-label="Minimap of the valley"></canvas>
        <div class="fh-mini-vignette" aria-hidden="true"></div>
      </div>
      <div class="fh-mini-overlays" data-js="overlays" role="group" aria-label="Map overlays"></div>
      <div class="fh-mini-legend" data-js="legend"></div>
    `;
    this.canvas = this.root.querySelector('#minimap') as HTMLCanvasElement;
    this.legendHost = this.root.querySelector('[data-js="legend"]') as HTMLElement;
    this.overlayHost = this.root.querySelector('[data-js="overlays"]') as HTMLElement;
    this.renderOverlays();
    this.root.addEventListener('click', this.onClick);
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
  }

  refresh(): void {
    const s = stateOf(this.svc);
    const reveal = this.root.querySelector('[data-js="reveal"]');
    if (reveal) reveal.textContent = `${pct(s.exploration.mapReveal)} charted`;
    const active = this.svc.app.view.overlay;
    for (const btn of this.overlayHost.querySelectorAll<HTMLElement>('[data-overlay]')) {
      const on = btn.dataset.overlay === active;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    const meta = OVERLAYS.find((o) => o.mode === active) ?? null;
    // Keep the legend in sync only when the overlay changes.
    const key = meta?.mode ?? 'none';
    if (this.legendHost.dataset.key !== key) {
      this.legendHost.dataset.key = key;
      this.legendHost.innerHTML = meta
        ? `<div class="fh-legend-grad" style="background:${escAttr(meta.gradient)}"></div><div class="fh-legend-labels"><span>${escAttr(meta.low)}</span><b>${icon(meta.icon, 'fh-icon is-tiny')} ${escAttr(meta.label)}</b><span>${escAttr(meta.high)}</span></div>`
        : `<div class="fh-legend-empty">${icon('map', 'fh-icon is-tiny')} no overlay</div>`;
    }
  }

  private renderOverlays(): void {
    this.overlayHost.innerHTML = OVERLAYS.map(
      (o) =>
        `<button type="button" class="fh-mini-ov clickable" data-overlay="${o.mode}" aria-pressed="false" aria-label="${escAttr(o.label)} overlay" ${tipText(`${o.label} overlay`)}>${icon(o.icon, 'fh-icon is-tiny')}</button>`,
    ).join('');
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-overlay]') : null;
    if (!target) return;
    const mode = target.dataset.overlay as OverlayMode;
    this.svc.app.setOverlay(this.svc.app.view.overlay === mode ? 'none' : mode);
    this.refresh();
    this.svc.refreshSoon();
  };
}
