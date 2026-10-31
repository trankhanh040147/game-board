import type {
  GameUIAPI, GameMode, HudState, LogEntry, LogKind, MeleeResultView, Profile, RoundIntroView,
  RoundResultView, Settings, TargetView, TournamentEndView, TournamentView, UIHandlers,
} from '../core/types';
import { TEAM_PALETTE } from '../core/config';

/**
 * TEMPORARY UI stub — ui-audio replaces this file and src/ui/ui.css.
 * Enough markup to make the loop testable.
 */
export class StubGameUI implements GameUIAPI {
  readonly root: HTMLElement;
  private handlers: UIHandlers;
  private profile: Profile | null = null;
  private logEl: HTMLElement;
  private hudEl: HTMLElement;
  private overlayEl: HTMLElement;
  private fadeEl: HTMLElement;
  private loadingEl: HTMLElement;
  private logId = 0;

  constructor(handlers: UIHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.id = 'ui-root';
    document.body.appendChild(this.root);
    const style = document.createElement('style');
    style.textContent = `
      #ui-root { position: fixed; inset: 0; pointer-events: none; font-family: Georgia, serif; color: #f0e6d2; z-index: 10; }
      #ui-root .panel { background: rgba(20,16,12,.82); border: 1px solid #8a6a3c; padding: 16px; pointer-events: auto; }
      #ui-root button { pointer-events: auto; background: #2a2118; color: #f0e6d2; border: 1px solid #8a6a3c; padding: 8px 14px; font: inherit; cursor: pointer; margin: 4px; }
      #ui-root button:hover { background: #4a3826; }
      #ui-root .menu { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); text-align: center; pointer-events: auto; }
      #ui-root .hud { position: absolute; inset: 0; pointer-events: none; }
      #ui-root .counters { position: absolute; top: 18px; left: 20px; text-shadow: 0 2px 4px #000; }
      #ui-root .counters b { display: block; font-size: 15px; font-weight: normal; }
      #ui-root .log { position: absolute; left: 20px; bottom: 24px; font-size: 13px; text-shadow: 0 1px 3px #000; max-width: 360px; }
      #ui-root .log div { margin: 1px 0; }
      #ui-root .health { position: absolute; right: 24px; bottom: 24px; width: 260px; }
      #ui-root .bar { height: 12px; background: #1a1410; border: 1px solid #8a6a3c; margin: 3px 0; }
      #ui-root .bar i { display: block; height: 100%; background: #a83232; }
      #ui-root .overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: auto; background: rgba(8,6,4,.55); }
      #ui-root .overlay .panel { min-width: 420px; max-width: 720px; text-align: center; }
      #ui-root h1 { font-size: 54px; letter-spacing: 6px; margin: 0 0 4px; }
      #ui-root h2 { font-weight: normal; letter-spacing: 3px; }
      #ui-root .fade { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity .5s; pointer-events: none; }
      #ui-root .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #0c0906; color: #c9a24a; font-size: 22px; letter-spacing: 4px; z-index: 20; }
      #ui-root .target { position: absolute; transform: translate(-50%,-100%); font-size: 12px; text-shadow: 0 1px 3px #000; text-align: center; }
      #ui-root .target .hp { width: 90px; height: 5px; background: #1a1410; border: 1px solid #000; margin: 2px auto; }
      #ui-root .target .hp i { display: block; height: 100%; background: #b8453f; }
      #ui-root .hint { position: absolute; bottom: 100px; left: 50%; transform: translateX(-50%); font-size: 13px; letter-spacing: 1px; text-shadow: 0 1px 4px #000; opacity: .8; }
      #ui-root .note { font-size: 12px; opacity: .7; }
      #ui-root .hidden { display: none !important; }
    `;
    document.head.appendChild(style);

    this.hudEl = document.createElement('div');
    this.hudEl.className = 'hud hidden';
    this.root.appendChild(this.hudEl);

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'overlay hidden';
    this.root.appendChild(this.overlayEl);

    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'fade';
    this.root.appendChild(this.fadeEl);

    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'loading';
    this.loadingEl.textContent = 'FORGING THE LISTS…';
    this.root.appendChild(this.loadingEl);

    this.logEl = document.createElement('div');
    this.logEl.className = 'log';
  }

  init(profile: Profile, _settings: Settings): void { this.profile = profile; }
  setProfile(profile: Profile): void { this.profile = profile; }
  updateSettings(_settings: Settings): void { /* stub */ }

  showMainMenu(profile: Profile): void {
    this.profile = profile;
    this.setLoading(null);
    this.hideHUD();
    this.overlayEl.classList.remove('hidden');
    this.overlayEl.style.background = 'rgba(8,6,4,.25)';
    this.overlayEl.innerHTML = `
      <div class="menu">
        <h1>BLADE &amp; MOUNT</h1>
        <div class="note">TOURNAMENT OF THE REALM</div>
        <p class="note">Denars ${profile.denars} · Renown ${profile.renown} · Level ${profile.level}</p>
        <button data-act="tournament">Tournament</button>
        <button data-act="melee">Arena Melee</button>
        <button data-act="controls">Controls</button>
        <button data-act="settings">Settings</button>
      </div>`;
    this.overlayEl.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = (b as HTMLElement).dataset.act;
        if (act === 'tournament') this.handlers.onStartTournament();
        if (act === 'melee') this.handlers.onStartMelee();
        if (act === 'controls') this.showControls();
        if (act === 'settings') this.showSettings();
      });
    });
  }

  hideMainMenu(): void { /* overlay controlled by callers */ }

  showHUD(mode: GameMode): void {
    this.hudEl.classList.remove('hidden');
    this.hudEl.innerHTML = `
      <div class="counters"></div>
      <div class="hint"></div>
      <div class="log"></div>
      <div class="health">
        <div class="bar"><i style="width:100%"></i></div>
        <div class="bar"><i style="width:100%;background:#c9a24a"></i></div>
      </div>
      <div class="target hidden"></div>`;
    this.logEl = this.hudEl.querySelector('.log') as HTMLElement;
    this.logEl.innerHTML = '';
    if (mode === 'melee') this.pushLog({ text: 'The gates open. Fight well, stranger.', kind: 'info' });
  }

  hideHUD(): void { this.hudEl.classList.add('hidden'); }

  updateHud(hud: HudState): void {
    const counters = this.hudEl.querySelector('.counters');
    if (counters) {
      counters.innerHTML = hud.mode === 'melee'
        ? `<b>Opponents Beaten: ${hud.opponentsBeaten}</b><b>Opponents Remaining: ${hud.opponentsRemaining}</b>`
        : `<b>${hud.roundLabel}</b><b>${hud.objective}</b>`;
    }
    const bars = this.hudEl.querySelectorAll('.bar i');
    if (bars.length >= 2) {
      (bars[0] as HTMLElement).style.width = `${(hud.health / hud.maxHealth) * 100}%`;
      (bars[1] as HTMLElement).style.width = `${(hud.stamina / hud.maxStamina) * 100}%`;
    }
    const hint = this.hudEl.querySelector('.hint') as HTMLElement;
    hint.textContent = hud.hint ?? '';
    this.setTargetOverlay(hud.target);
  }

  pushLog(entry: Omit<LogEntry, 'id'>): void {
    const div = document.createElement('div');
    div.textContent = entry.text;
    const colors: Record<LogKind, string> = {
      damage: '#f3dcc0', block: '#9db4c8', kill: '#e5b85c', xp: '#9fc98f',
      info: '#cbbfa6', warning: '#d88a6a', reward: '#e5c66c',
    };
    div.style.color = colors[entry.kind];
    this.logEl.prepend(div);
    const id = ++this.logId;
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 1.2s'; }, 9000);
    setTimeout(() => { if (div.parentElement) div.remove(); }, 10500);
    while (this.logEl.childElementCount > 9) this.logEl.lastElementChild?.remove();
    void id;
  }

  clearLog(): void { this.logEl.innerHTML = ''; }

  private showPanel(html: string, actions: Record<string, () => void> = {}): void {
    this.overlayEl.classList.remove('hidden');
    this.overlayEl.style.background = 'rgba(8,6,4,.55)';
    this.overlayEl.innerHTML = `<div class="panel">${html}</div>`;
    this.overlayEl.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = (b as HTMLElement).dataset.act as string;
        actions[act]?.();
      });
    });
  }

  showBracket(view: TournamentView): void {
    const teams = view.teams.map((t) => `<div style="border-left:4px solid ${t.color};padding-left:8px;margin:8px 0;text-align:left">
      <b>${t.name}</b> <span class="note">${t.alive}/${t.members.length} standing</span>
      <div class="note">${t.members.map((m) => `${m.isPlayer ? '★ ' : ''}${m.name}`).join(' · ')}</div></div>`).join('');
    this.showPanel(`
      <h2>${view.roundName}</h2>
      <div class="note">Round ${view.round} of ${view.totalRounds} — ${view.roundObjective}</div>
      <p>Purse: <b>${view.purse}</b> denars · Your purse: <b>${view.denars}</b> · Bet: <b>${view.bet}</b></p>
      ${teams}
      <div>${[0, 25, 50, 100, 150].map((amt) => `<button data-bet="${amt}" ${amt > view.maxBet || !view.canBet ? 'disabled' : ''}>Bet ${amt}</button>`).join('')}</div>
      <button data-act="enter">Enter the Lists</button>
      <button data-act="quit">Withdraw</button>`, {
      enter: () => this.handlers.onEnterRound(),
      quit: () => this.handlers.onQuitToMenu(),
    });
  }

  hideBracket(): void { this.overlayEl.classList.add('hidden'); }

  showRoundIntro(view: RoundIntroView): void {
    this.showPanel(`<h1 style="font-size:38px">ROUND ${view.round}</h1><h2>${view.roundName}</h2><p>${view.objective}</p>
      <div class="note">${view.teams.map((t) => `${t.name}: ${t.members.map((m) => m.name).join(', ')}`).join('<br>')}</div>`);
    setTimeout(() => this.hideRoundIntro(), 3200);
  }

  hideRoundIntro(): void { this.overlayEl.classList.add('hidden'); }

  showRoundResult(view: RoundResultView): void {
    this.showPanel(`<h2>${view.champion ? 'CHAMPION OF THE REALM' : view.victory ? 'ROUND WON' : 'DEFEAT'}</h2>
      <div class="note">${view.roundName} · Kills ${view.stats.kills} · Damage ${Math.round(view.stats.damageDealt)}</div>
      <p>Reward: ${view.rewardDenars} denars · ${view.rewardXp} XP · ${view.rewardRenown} renown</p>
      <button data-act="continue">${view.champion || view.eliminated ? 'Leave the Arena' : 'Onward'}</button>`, {
      continue: () => this.handlers.onContinue(),
    });
  }

  showTournamentEnd(view: TournamentEndView): void {
    this.showPanel(`<h1 style="font-size:40px">${view.champion ? 'CHAMPION' : 'ELIMINATED'}</h1>
      <p>${view.champion ? 'The crowd roars your name.' : `You fell in round ${view.round}.`}</p>
      <p>${view.rewardDenars} denars · ${view.rewardXp} XP · ${view.rewardRenown} renown</p>
      <button data-act="continue">Return to the Lists</button>`, {
      continue: () => this.handlers.onContinue(),
    });
  }

  showMeleeResult(view: MeleeResultView): void {
    this.showPanel(`<h1 style="font-size:40px">${view.victory ? 'ARENA CLEARED' : 'YOU FELL'}</h1>
      <p>Opponents beaten: <b>${view.beaten} / ${view.total}</b>${view.best ? ' · New best!' : ''}</p>
      <p>${view.rewardDenars} denars · ${view.rewardXp} XP · ${view.rewardRenown} renown</p>
      <button data-act="continue">Return to the Lists</button>`, {
      continue: () => this.handlers.onContinue(),
    });
  }

  showPause(): void {
    this.showPanel(`<h1 style="font-size:34px">PAUSED</h1>
      <button data-act="resume">Resume</button>
      <button data-act="controls">Controls</button>
      <button data-act="settings">Settings</button>
      <button data-act="quit">Abandon Match</button>`, {
      resume: () => this.handlers.onResume(),
      controls: () => this.showControls(),
      settings: () => this.showSettings(),
      quit: () => this.handlers.onQuitToMenu(),
    });
  }

  hidePause(): void { this.overlayEl.classList.add('hidden'); }

  showSettings(): void {
    this.showPanel(`<h2>SETTINGS</h2><p class="note">Settings panel is being forged.</p>
      <button data-act="back">Back</button>`, { back: () => this.handlers.onCloseOverlay() });
  }

  hideSettings(): void { this.overlayEl.classList.add('hidden'); }

  showControls(): void {
    this.showPanel(`<h2>CONTROLS</h2><p class="note">WASD move · Mouse look · LMB attack · RMB block · Shift sprint · Space dodge · F kick · Esc pause</p>
      <button data-act="back">Back</button>`, { back: () => this.handlers.onCloseOverlay() });
  }

  hideControls(): void { this.overlayEl.classList.add('hidden'); }

  toast(text: string, kind: LogKind = 'info'): void { this.pushLog({ text, kind }); }

  setDamagePulse(_amount: number): void { /* stub */ }

  setTargetOverlay(target: TargetView | null): void {
    const el = this.hudEl.querySelector('.target') as HTMLElement | null;
    if (!el) return;
    if (!target || !target.visible) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.style.left = `${target.screenX}px`;
    el.style.top = `${target.screenY}px`;
    el.style.color = target.teamColor;
    el.innerHTML = `${target.name}<div class="hp"><i style="width:${(target.hp / target.maxHp) * 100}%"></i></div>`;
  }

  fadeToBlack(ms = 500): Promise<void> {
    return new Promise((resolve) => {
      this.fadeEl.style.transition = `opacity ${ms}ms`;
      this.fadeEl.style.opacity = '1';
      setTimeout(resolve, ms);
    });
  }

  fadeFromBlack(ms = 500): Promise<void> {
    return new Promise((resolve) => {
      this.fadeEl.style.transition = `opacity ${ms}ms`;
      this.fadeEl.style.opacity = '0';
      setTimeout(resolve, ms);
    });
  }

  setLoading(progress: number | null, label?: string): void {
    if (progress === null) { this.loadingEl.classList.add('hidden'); return; }
    this.loadingEl.classList.remove('hidden');
    this.loadingEl.textContent = `${label ?? 'FORGING THE LISTS…'} ${Math.round(progress * 100)}%`;
  }

  dispose(): void { this.root.remove(); }
}

export { StubGameUI as GameUI };
void TEAM_PALETTE;
