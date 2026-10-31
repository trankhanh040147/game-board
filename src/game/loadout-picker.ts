import type { GameMode, Loadout } from '../core/types';
import type { LoadoutChoice } from './loadouts';
import { audio } from '../audio/audio';
import { weaponStats } from './loadouts';

export interface LoadoutPickerContext {
  mode: GameMode;
  heading: string;
  subtitle: string;
}

type Confirm = (loadout: Loadout, choice: LoadoutChoice) => void;
type Cancel = () => void;

const ICONS: Record<LoadoutChoice['icon'], string> = {
  sword: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M46 6l8 2-2 8-24 32-8-4L46 6z" fill="#d9dde2" stroke="#5b4632" stroke-width="2"/><path d="M16 48l8-8 6 6-8 8z" fill="#8a6a3c"/><path d="M12 54l6-6" stroke="#d9dde2" stroke-width="4"/></svg>`,
  greatsword: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M44 4l10 2-2 10-22 30-8-6L44 4z" fill="#cfd6dd" stroke="#4b3a28" stroke-width="2"/><path d="M16 40l14 10" stroke="#b08d57" stroke-width="5"/><path d="M12 50l10-10 6 6-10 10z" fill="#5b4632"/></svg>`,
  spear: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 58L46 10" stroke="#8a6a3c" stroke-width="4"/><path d="M42 4l12 12-14 4 2-16z" fill="#d9dde2" stroke="#5b4632" stroke-width="2"/><path d="M12 56l8-8" stroke="#b08d57" stroke-width="3"/></svg>`,
  axe: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M26 58L38 8" stroke="#8a6a3c" stroke-width="5"/><path d="M34 10c14-4 22 2 20 12-2 9-12 12-24 8l4-20z" fill="#cfd6dd" stroke="#4b3a28" stroke-width="2"/><path d="M30 20c8-2 14 0 16 4" stroke="#7a5b38" stroke-width="2"/></svg>`,
};

export class LoadoutPicker {
  private root: HTMLDivElement;
  private content: HTMLDivElement;
  private choices: LoadoutChoice[] = [];
  private selected = 0;
  private confirm: Confirm | null = null;
  private cancel: Cancel | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (this.root.classList.contains('is-hidden')) return;
    if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3' || e.code === 'Digit4') {
      this.select(Number(e.code.slice(-1)) - 1);
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      this.choose();
    } else if (e.code === 'Escape') {
      this.back();
    }
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'lpick is-hidden';
    this.root.innerHTML = '<div class="lpick-backdrop"></div><div class="lpick-panel"><div class="lpick-content"></div></div>';
    document.body.appendChild(this.root);
    this.content = this.root.querySelector('.lpick-content') as HTMLDivElement;
    this.injectStyles();
    window.addEventListener('keydown', this.onKey);
  }

  private injectStyles(): void {
    if (document.getElementById('lpick-styles')) return;
    const style = document.createElement('style');
    style.id = 'lpick-styles';
    style.textContent = `
      .lpick { position: fixed; inset: 0; z-index: 24; display: flex; align-items: center; justify-content: center;
        font-family: 'EB Garamond', Georgia, serif; color: #efe3c9; opacity: 1; transition: opacity .28s ease; }
      .lpick.is-hidden { opacity: 0; pointer-events: none; }
      .lpick-backdrop { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, rgba(16,12,8,.72), rgba(5,4,3,.92)); }
      .lpick-panel { position: relative; width: min(1080px, 92vw); max-height: 92vh; overflow: auto;
        background: linear-gradient(170deg, rgba(27,21,15,.98), rgba(12,9,6,.98));
        border: 1px solid #8a6a3c; box-shadow: 0 30px 100px rgba(0,0,0,.7), inset 0 0 0 1px rgba(201,162,74,.12); padding: 26px 30px 22px; }
      .lpick-panel::before { content: ''; position: absolute; inset: 7px; border: 1px solid rgba(176,141,87,.22); pointer-events: none; }
      .lpick-head { text-align: center; margin-bottom: 14px; position: relative; }
      .lpick-kicker { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; letter-spacing: 5px; color: #b08d57; text-transform: uppercase; }
      .lpick-title { font-family: 'Cinzel', Georgia, serif; font-size: 34px; letter-spacing: 5px; color: #f1e4c8; margin: 2px 0 2px; text-shadow: 0 2px 18px rgba(0,0,0,.6); }
      .lpick-sub { font-size: 15px; color: #cbbfa6; font-style: italic; }
      .lpick-rule { height: 1px; background: linear-gradient(90deg, transparent, rgba(201,162,74,.65), transparent); margin: 12px 0 16px; }
      .lpick-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .lpick-card { position: relative; text-align: left; cursor: pointer; padding: 14px 14px 12px; min-height: 250px;
        background: linear-gradient(180deg, rgba(49,37,25,.72), rgba(20,15,10,.85));
        border: 1px solid rgba(176,141,87,.32); color: inherit; font: inherit; transition: transform .12s ease, border-color .12s ease, background .12s ease; }
      .lpick-card:hover { border-color: rgba(232,198,122,.7); background: linear-gradient(180deg, rgba(63,48,32,.85), rgba(24,18,12,.9)); transform: translateY(-2px); }
      .lpick-card.selected { border-color: #e8c67a; box-shadow: 0 0 0 1px rgba(232,198,122,.45), 0 10px 30px rgba(0,0,0,.45); background: linear-gradient(180deg, rgba(74,56,34,.9), rgba(28,21,13,.95)); }
      .lpick-card.selected::after { content: 'CHOSEN'; position: absolute; top: 10px; right: 10px; font-family: 'Barlow Condensed', sans-serif; font-size: 10px; letter-spacing: 1.6px; color: #e8c67a; }
      .lpick-num { position: absolute; top: 10px; left: 12px; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: rgba(232,220,192,.45); }
      .lpick-icon { height: 74px; display: flex; align-items: center; justify-content: center; margin: 12px 0 6px; }
      .lpick-icon svg { width: 70px; height: 70px; filter: drop-shadow(0 3px 8px rgba(0,0,0,.45)); }
      .lpick-name { font-family: 'Cinzel', Georgia, serif; font-size: 16px; letter-spacing: 1.2px; color: #f0dfba; text-align: center; }
      .lpick-tag { text-align: center; font-size: 12px; color: #a99778; margin-top: 1px; font-style: italic; }
      .lpick-stats { margin-top: 9px; display: grid; gap: 3px; }
      .lpick-stat { display: grid; grid-template-columns: 44px 1fr 26px; align-items: center; gap: 6px; font-family: 'Barlow Condensed', sans-serif; font-size: 10.5px; letter-spacing: 1px; color: #bcae92; }
      .lpick-stat .bar { height: 4px; background: rgba(240,230,210,.1); }
      .lpick-stat .bar i { display: block; height: 100%; background: linear-gradient(90deg, #8a6a3c, #d3ae4f); }
      .lpick-note { margin-top: 9px; font-size: 11.5px; line-height: 1.35; color: #a99b80; min-height: 32px; }
      .lpick-foot { margin-top: 16px; display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .lpick-arms { font-family: 'Barlow Condensed', sans-serif; font-size: 12px; letter-spacing: 1.2px; color: #b7a888; }
      .lpick-arms b { color: #e6d4ae; font-weight: 500; }
      .lpick-actions { display: flex; gap: 10px; align-items: center; }
      .lpick-btn { font-family: 'Cinzel', Georgia, serif; font-size: 13px; letter-spacing: 2px; cursor: pointer; padding: 9px 22px;
        background: linear-gradient(180deg, #5c452b, #2b1f12); color: #f3e6c8; border: 1px solid #c9a24a; }
      .lpick-btn:hover { background: linear-gradient(180deg, #7c5d37, #3a2a19); }
      .lpick-back { font-family: 'Barlow Condensed', sans-serif; font-size: 12px; letter-spacing: 2px; color: #b7a888; cursor: pointer; background: none; border: none; }
      .lpick-back:hover { color: #f0d9a4; }
      .lpick-hint { margin-top: 10px; text-align: center; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; letter-spacing: 1.5px; color: rgba(200,185,158,.55); }
      @media (max-width: 900px) { .lpick-grid { grid-template-columns: repeat(2, 1fr); } .lpick-card { min-height: 220px; } }
    `;
    document.head.appendChild(style);
  }

  show(ctx: LoadoutPickerContext, choices: LoadoutChoice[], confirm: Confirm, cancel: Cancel): void {
    this.choices = choices;
    this.confirm = confirm;
    this.cancel = cancel;
    this.selected = 0;
    this.content.innerHTML = `
      <div class="lpick-head">
        <div class="lpick-kicker">Blade &amp; Mount · ${ctx.mode === 'tournament' ? 'Tournament of the Realm' : 'Arena Melee'}</div>
        <div class="lpick-title">CHOOSE YOUR ARMS</div>
        <div class="lpick-sub">${ctx.heading}</div>
        <div class="lpick-rule"></div>
      </div>
      <div class="lpick-grid">
        ${choices.map((c, i) => {
          const stats = weaponStats(c.loadout);
          const dm = Math.round((stats.damage / 45) * 100);
          const sp = Math.round((stats.speed / 1.2) * 100);
          const rh = Math.round((stats.reach / 3.3) * 100);
          return `<button class="lpick-card" data-index="${i}">
            <span class="lpick-num">0${i + 1}</span>
            <div class="lpick-icon">${ICONS[c.icon]}</div>
            <div class="lpick-name">${c.name}</div>
            <div class="lpick-tag">${c.subtitle}</div>
            <div class="lpick-stats">
              <div class="lpick-stat"><span>DMG</span><span class="bar"><i style="width:${dm}%"></i></span><span>${stats.damage}</span></div>
              <div class="lpick-stat"><span>SPD</span><span class="bar"><i style="width:${sp}%"></i></span><span>${stats.speed.toFixed(2)}</span></div>
              <div class="lpick-stat"><span>RCH</span><span class="bar"><i style="width:${rh}%"></i></span><span>${stats.reach.toFixed(2)}</span></div>
            </div>
            <div class="lpick-note">${c.note}</div>
          </button>`;
        }).join('')}
      </div>
      <div class="lpick-foot">
        <div class="lpick-arms">ARMOUR <b>${choices[0]?.loadout.armor.name ?? '—'}</b> · HELMET <b>${choices[0]?.loadout.helmet.name ?? '—'}</b> · ${choices[0]?.loadout.shield ? 'SHIELD GRANTED' : 'NO SHIELD'}</div>
        <div class="lpick-actions">
          <button class="lpick-back" data-act="back">${ctx.mode === 'tournament' ? 'BACK TO THE BOARD' : 'BACK'}</button>
          <button class="lpick-btn" data-act="confirm">TAKE THE FIELD</button>
        </div>
      </div>
      <div class="lpick-hint">CLICK A CARD OR PRESS 1–4 · ENTER TO TAKE THE FIELD · ESC TO GO BACK</div>
    `;
    this.root.classList.remove('is-hidden');
    this.content.querySelectorAll<HTMLButtonElement>('.lpick-card').forEach((card) => {
      card.addEventListener('click', () => this.select(Number(card.dataset.index)));
      card.addEventListener('dblclick', () => { this.select(Number(card.dataset.index)); this.choose(); });
    });
    (this.content.querySelector('[data-act="confirm"]') as HTMLButtonElement).addEventListener('click', () => this.choose());
    (this.content.querySelector('[data-act="back"]') as HTMLButtonElement).addEventListener('click', () => this.back());
    this.refreshSelection();
  }

  hide(): void {
    this.root.classList.add('is-hidden');
    this.confirm = null;
    this.cancel = null;
  }

  private select(index: number): void {
    if (index < 0 || index >= this.choices.length) return;
    this.selected = index;
    this.refreshSelection();
    audio.play('ui-click', { volume: 0.35 });
  }

  private refreshSelection(): void {
    this.content.querySelectorAll<HTMLElement>('.lpick-card').forEach((card, i) => {
      card.classList.toggle('selected', i === this.selected);
    });
    const arms = this.content.querySelector('.lpick-arms');
    const chosen = this.choices[this.selected];
    if (arms && chosen) {
      arms.innerHTML = `ARMOUR <b>${chosen.loadout.armor.name}</b> · HELMET <b>${chosen.loadout.helmet.name}</b> · ${chosen.loadout.shield ? 'SHIELD GRANTED' : 'NO SHIELD'}`;
    }
  }

  private choose(): void {
    const chosen = this.choices[this.selected];
    if (!chosen) return;
    const cb = this.confirm;
    this.hide();
    audio.play('ui-click', { volume: 0.5 });
    cb?.(chosen.loadout, chosen);
  }

  private back(): void {
    const cb = this.cancel;
    this.hide();
    cb?.();
  }

  isOpen(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
