import type { AttackDir, GuardDir } from '../core/types';

/**
 * Combat crosshair / stance / hit-feedback overlay. Lead-owned DOM layer that sits
 * between the WebGL canvas and the main UI. UI chrome (health, log, menus) is handled by src/ui.
 */
export class CombatOverlay {
  readonly root: HTMLDivElement;
  private reticle: HTMLDivElement;
  private ring: HTMLDivElement;
  private dirs = new Map<AttackDir, HTMLDivElement>();
  private centerDot: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private lockEl: HTMLDivElement;
  private stanceLabel: HTMLDivElement;
  private centerText: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private scoreboardEl: HTMLDivElement;
  private hitTimer = 0;
  private centerTimer = 0;
  private visible = true;
  private stance: 'idle' | 'attack' | 'block' = 'idle';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'combat-overlay';
    document.body.appendChild(this.root);
    this.root.innerHTML = `
      <div class="co-reticle">
        <div class="co-dot"></div>
        <div class="co-ring"></div>
        <div class="co-lock"></div>
        <div class="co-hitmarker"></div>
        <div class="co-stance-label"></div>
        <div class="co-dirs">
          <div class="co-dir co-dir-left" data-dir="left"><span>◤</span></div>
          <div class="co-dir co-dir-right" data-dir="right"><span>◥</span></div>
          <div class="co-dir co-dir-overhead" data-dir="overhead"><span>▲</span></div>
          <div class="co-dir co-dir-thrust" data-dir="thrust"><span>▼</span></div>
        </div>
      </div>
      <div class="co-center-text"></div>
      <div class="co-scoreboard"></div>
      <div class="co-hint"></div>
    `;
    this.reticle = this.root.querySelector('.co-reticle') as HTMLDivElement;
    this.ring = this.root.querySelector('.co-ring') as HTMLDivElement;
    this.centerDot = this.root.querySelector('.co-dot') as HTMLDivElement;
    this.hitMarker = this.root.querySelector('.co-hitmarker') as HTMLDivElement;
    this.lockEl = this.root.querySelector('.co-lock') as HTMLDivElement;
    this.stanceLabel = this.root.querySelector('.co-stance-label') as HTMLDivElement;
    this.centerText = this.root.querySelector('.co-center-text') as HTMLDivElement;
    this.hintEl = this.root.querySelector('.co-hint') as HTMLDivElement;
    this.scoreboardEl = this.root.querySelector('.co-scoreboard') as HTMLDivElement;
    this.root.querySelectorAll<HTMLDivElement>('.co-dir').forEach((el) => {
      this.dirs.set(el.dataset.dir as AttackDir, el);
    });
    this.injectStyles();
    this.setVisible(false);
    this.setStance('idle', null);
  }

  private injectStyles(): void {
    if (document.getElementById('co-styles')) return;
    const style = document.createElement('style');
    style.id = 'co-styles';
    style.textContent = `
      #combat-overlay {
        position: fixed; inset: 0; z-index: 6; pointer-events: none;
        font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif;
        opacity: 1; transition: opacity .25s ease;
      }
      #combat-overlay.co-hidden { opacity: 0; }
      #combat-overlay .co-reticle {
        position: absolute; left: 50%; top: 50%; width: 0; height: 0;
        color: #f2e6cc; transition: transform .18s ease;
      }
      #combat-overlay .co-reticle::before {
        content: ''; position: absolute; left: -38px; top: -38px; width: 76px; height: 76px;
        border-radius: 50%; pointer-events: none;
        background: radial-gradient(circle, rgba(10,8,4,0) 34%, rgba(10,8,4,.22) 58%, rgba(10,8,4,0) 72%);
      }
      #combat-overlay .co-dot {
        position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%;
        background: #ffe8b0; opacity: .95; box-shadow: 0 0 0 1px rgba(0,0,0,.65), 0 0 8px rgba(0,0,0,.9);
      }
      #combat-overlay .co-ring {
        position: absolute; left: -15px; top: -15px; width: 30px; height: 30px;
        border: 1px solid rgba(20,14,8,.55); border-radius: 50%; transition: all .16s ease;
        box-shadow: inset 0 0 0 1px rgba(255,244,214,.28);
      }
      #combat-overlay .co-lock {
        position: absolute; left: -24px; top: -24px; width: 48px; height: 48px;
        opacity: 0; transition: opacity .16s ease;
        background:
          radial-gradient(circle at 0 0, transparent 0 14px, rgba(240,220,170,.9) 14px 15.5px, transparent 15.5px),
          radial-gradient(circle at 100% 0, transparent 0 14px, rgba(240,220,170,.9) 14px 15.5px, transparent 15.5px),
          radial-gradient(circle at 0 100%, transparent 0 14px, rgba(240,220,170,.9) 14px 15.5px, transparent 15.5px),
          radial-gradient(circle at 100% 100%, transparent 0 14px, rgba(240,220,170,.9) 14px 15.5px, transparent 15.5px);
      }
      #combat-overlay .co-hitmarker {
        position: absolute; left: -10px; top: -10px; width: 20px; height: 20px; opacity: 0;
        transform: rotate(45deg);
        background:
          linear-gradient(90deg, transparent 45%, rgba(255,120,100,.95) 45% 55%, transparent 55%),
          linear-gradient(0deg, transparent 45%, rgba(255,120,100,.95) 45% 55%, transparent 55%);
        transition: opacity .08s ease;
      }
      #combat-overlay .co-hitmarker.block { background:
          linear-gradient(90deg, transparent 45%, rgba(170,205,255,.95) 45% 55%, transparent 55%),
          linear-gradient(0deg, transparent 45%, rgba(170,205,255,.95) 45% 55%, transparent 55%); }
      #combat-overlay .co-hitmarker.kill { transform: rotate(45deg) scale(1.6); background:
          linear-gradient(90deg, transparent 42%, rgba(255,196,90,.95) 42% 58%, transparent 58%),
          linear-gradient(0deg, transparent 42%, rgba(255,196,90,.95) 42% 58%, transparent 58%); }
      #combat-overlay .co-dirs { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity .1s ease; }
      #combat-overlay.stance-attack .co-dirs, #combat-overlay.stance-block .co-dirs { opacity: 1; }
      #combat-overlay .co-dir {
        position: absolute; width: 20px; height: 20px; margin-left: -10px; margin-top: -10px;
        display: flex; align-items: center; justify-content: center;
        color: rgba(255,244,220,.72); font-size: 16px;
        text-shadow: 0 0 2px #000, 0 2px 4px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.6);
        transition: color .1s ease, transform .1s ease, opacity .1s ease;
      }
      #combat-overlay .co-dir-left { left: -44px; top: 0; transform: rotate(-90deg); }
      #combat-overlay .co-dir-right { left: 44px; top: 0; transform: rotate(90deg); }
      #combat-overlay .co-dir-overhead { left: 0; top: -34px; }
      #combat-overlay .co-dir-thrust { left: 0; top: 34px; transform: rotate(180deg); }
      #combat-overlay .co-dir.selected { color: #ffd77e; transform: scale(1.55) rotate(var(--rot, 0deg)); text-shadow: 0 0 2px #000, 0 0 12px rgba(255,190,80,.95), 0 2px 5px #000; }
      #combat-overlay .co-dir-left.selected { --rot: -90deg; }
      #combat-overlay .co-dir-right.selected { --rot: 90deg; }
      #combat-overlay .co-dir-thrust.selected { --rot: 180deg; }
      #combat-overlay.stance-block .co-dir.selected { color: #a9c7e6; text-shadow: 0 0 10px rgba(130,180,255,.8); }
      #combat-overlay.stance-block .co-ring { border-color: rgba(150,190,235,.5); }
      #combat-overlay.locked .co-lock { opacity: 1; animation: co-lock-pulse 1.4s ease-in-out infinite; }
      #combat-overlay.locked .co-ring { border-color: rgba(240,220,170,.6); transform: scale(1.15); }
      @keyframes co-lock-pulse { 0%,100% { transform: scale(1); opacity: .95; } 50% { transform: scale(1.08); opacity: .6; } }
      #combat-overlay .co-stance-label {
        position: absolute; left: 50%; top: 66px; transform: translateX(-50%);
        font-size: 11px; letter-spacing: 2.8px; text-transform: uppercase; color: #f0d9a4;
        opacity: 0; transition: opacity .12s ease; white-space: nowrap;
        text-shadow: 0 1px 3px rgba(0,0,0,.95);
        background: rgba(12,9,5,.55); border: 1px solid rgba(190,158,100,.38);
        padding: 2px 9px 1px;
      }
      #combat-overlay.stance-attack .co-stance-label, #combat-overlay.stance-block .co-stance-label { opacity: .85; }
      #combat-overlay .co-center-text {
        position: absolute; left: 50%; top: 36%; transform: translate(-50%, -50%);
        font-family: 'Cinzel', Georgia, serif; font-size: 48px; letter-spacing: 10px; color: #f2e3c2;
        opacity: 0; transition: opacity .35s ease; text-shadow: 0 4px 24px rgba(0,0,0,.8);
        white-space: nowrap;
      }
      #combat-overlay .co-center-text.show { opacity: 1; }
      #combat-overlay .co-scoreboard {
        position: absolute; left: 50%; top: 92px; transform: translateX(-50%) translateY(-8px);
        min-width: 380px; padding: 12px 20px 11px;
        background: linear-gradient(180deg, rgba(18,13,8,.9), rgba(10,7,4,.82));
        border: 1px solid rgba(176,141,87,.55); box-shadow: 0 10px 30px rgba(0,0,0,.45);
        opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease;
        font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif;
      }
      #combat-overlay .co-scoreboard.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #combat-overlay .co-scoreboard h4 {
        margin: 0 0 7px; font-family: 'Cinzel', Georgia, serif; font-weight: 600;
        font-size: 11px; letter-spacing: 3px; color: #c9a24a; text-align: center;
      }
      #combat-overlay .co-scoreboard .row {
        display: flex; align-items: center; gap: 10px; margin: 3px 0;
        font-size: 15px; letter-spacing: .6px; color: #e9dcc0;
      }
      #combat-overlay .co-scoreboard .row .dot { width: 9px; height: 9px; transform: rotate(45deg); flex: none; }
      #combat-overlay .co-scoreboard .row .nm { flex: 1; }
      #combat-overlay .co-scoreboard .row .ct { color: #f0d9a4; font-variant-numeric: tabular-nums; }
      #combat-overlay .co-scoreboard .row.you .nm { color: #f3cf7a; }
      #combat-overlay .co-scoreboard .row .pips { display: flex; gap: 3px; }
      #combat-overlay .co-scoreboard .row .pip { width: 6px; height: 6px; border-radius: 50%; background: rgba(240,230,210,.16); }
      #combat-overlay .co-scoreboard .row .pip.on { background: #c9a24a; }
      #combat-overlay .co-scoreboard .sub {
        margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(176,141,87,.25);
        font-size: 12px; letter-spacing: 1.4px; color: rgba(233,220,192,.7); text-align: center;
      }
      #combat-overlay .co-hint {
        position: absolute; left: 50%; bottom: 8.5%; transform: translateX(-50%);
        font-family: 'EB Garamond', Georgia, serif; font-size: 14px; color: rgba(240,230,210,.75);
        text-shadow: 0 1px 4px rgba(0,0,0,.9); opacity: 0; transition: opacity .3s ease;
        letter-spacing: .4px; white-space: nowrap;
      }
      #combat-overlay .co-hint.show { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('co-hidden', !v);
  }

  setStance(stance: 'idle' | 'attack' | 'block', dir: AttackDir | GuardDir | null): void {
    this.stance = stance;
    this.root.classList.remove('stance-attack', 'stance-block');
    if (stance === 'attack') this.root.classList.add('stance-attack');
    if (stance === 'block') this.root.classList.add('stance-block');
    for (const [d, el] of this.dirs) el.classList.toggle('selected', d === dir);
    this.stanceLabel.textContent = stance === 'attack' ? 'ATTACK' : stance === 'block' ? 'GUARD' : '';
    this.reticle.style.transform = stance === 'idle' ? 'scale(1)' : 'scale(.92)';
    this.centerDot.style.background = stance === 'attack' ? '#f3cf7a' : stance === 'block' ? '#a9c7e6' : '#f2e6cc';
  }

  setLocked(locked: boolean): void {
    this.root.classList.toggle('locked', locked && this.visible);
  }

  hitFeedback(kind: 'hit' | 'block' | 'kill'): void {
    this.hitMarker.className = `co-hitmarker ${kind === 'block' ? 'block' : kind === 'kill' ? 'kill' : ''}`;
    this.hitMarker.style.opacity = '1';
    this.hitTimer = kind === 'kill' ? 0.28 : 0.16;
  }

  showCenterText(text: string, duration = 1.6): void {
    this.centerText.textContent = text;
    this.centerText.classList.add('show');
    this.centerTimer = duration;
  }

  setScoreboard(html: string | null): void {
    if (!html) {
      this.scoreboardEl.classList.remove('show');
      return;
    }
    this.scoreboardEl.innerHTML = html;
    this.scoreboardEl.classList.add('show');
  }

  setHint(text: string | null): void {
    if (!text) {
      this.hintEl.classList.remove('show');
      return;
    }
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
  }

  update(dt: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitMarker.style.opacity = '0';
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.centerText.classList.remove('show');
    }
    void this.stance;
  }

  dispose(): void {
    this.root.remove();
  }
}
