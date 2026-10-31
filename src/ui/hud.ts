/** In-game HUD: counters, objective, log, vitals, target plate, hints. */

import type { GameMode, HudState, Loadout, LogKind, TargetView, TournamentTeam } from '../core/types';
import { TEAM_PALETTE, rankForLevel } from '../core/config';
import { crestSvg, iconMarkup, portraitSvg } from './icons';
import type { UIEnv } from './shared';
import { append, div, el, num, pct, roman, span } from './util';

const LOG_DIM_MS = 4300;
const LOG_REMOVE_MS = 7600;
const MAX_LOG_LINES = 9;

const ROMAN_RE = /\bround\s+(I{1,3}|IV|V|VI|[1-9])\b/i;
const ROMAN_VALUES: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
};

function roundFromLabel(label: string): number | null {
  const match = ROMAN_RE.exec(label ?? '');
  if (!match) return null;
  const value = ROMAN_VALUES[match[1].toUpperCase()];
  return value ?? null;
}

interface LogTimer {
  id: number;
}

export class HudView {
  readonly root: HTMLDivElement;
  private env: UIEnv;
  private mode: GameMode = 'tournament';
  private logEl: HTMLDivElement;
  private hintsEnabled = true;
  private profileName = '—';
  private loadout: Loadout | null = null;
  private loadoutSig = '';
  private pipsSig = '';
  private lastHp = -1;
  private timers = new Set<number>();
  private hitTimer = 0;

  private q: (name: string) => HTMLElement;
  private refs: Record<string, HTMLElement> = {};

  constructor(env: UIEnv) {
    this.env = env;
    this.root = div('bm-hud is-hidden');
    this.root.dataset.mode = 'tournament';
    this.root.innerHTML = HUD_MARKUP;
    this.q = (name: string) => {
      const cached = this.refs[name];
      if (cached) return cached;
      const node = this.root.querySelector(`[data-ref="${name}"]`) as HTMLElement | null;
      if (!node) throw new Error(`HUD ref missing: ${name}`);
      this.refs[name] = node;
      return node;
    };

    const portrait = this.q('portrait');
    portrait.innerHTML = portraitSvg();
    this.q('targetLock').innerHTML = iconMarkup('target');
    this.q('crosshairDot').innerHTML = iconMarkup('target');
    this.logEl = this.q('log') as HTMLDivElement;
    this.applyLabels();
  }

  setEnv(env: UIEnv): void {
    this.env = env;
    this.hintsEnabled = env.settings.showHints;
    this.applyLabels();
  }

  setProfile(name: string, level: number): void {
    this.profileName = name;
    this.q('playerName').textContent = name;
    this.q('level').textContent = String(level);
    this.q('rank').textContent = rankForLevel(level);
  }

  setHintsEnabled(enabled: boolean): void {
    this.hintsEnabled = enabled;
    if (!enabled) this.q('hint').classList.remove('is-visible');
  }

  show(mode: GameMode): void {
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.root.classList.remove('is-hidden');
    this.clearLog();
    this.applyLabels();
    this.setLoadout(this.loadout);
    this.q('log').classList.add('is-fresh');
  }

  hide(): void {
    this.root.classList.add('is-hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  clearLog(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.logEl.replaceChildren();
  }

  setLoadout(loadout: Loadout | null): void {
    this.loadout = loadout;
    const sig = loadout
      ? `${loadout.weapon.id}|${loadout.shield ? loadout.shield.id : '-'}|${loadout.weapon.name}|${loadout.shield?.name ?? ''}`
      : 'none';
    if (sig === this.loadoutSig) return;
    this.loadoutSig = sig;
    const gear = this.q('wargear');
    gear.replaceChildren();

    const badge = (iconName: string, text: string | null, title: string) => {
      const node = div('bm-wargear-badge');
      node.title = title;
      const glyph = span('bm-wargear-ico');
      glyph.innerHTML = iconMarkup(iconName);
      node.appendChild(glyph);
      if (text) node.appendChild(span('bm-wargear-name', text));
      gear.appendChild(node);
    };

    if (loadout) {
      badge('sword', loadout.weapon.name, loadout.weapon.name);
      if (loadout.shield) badge('shield', loadout.shield.name, loadout.shield.name);
      else badge('shield', null, this.env.tr('hudShield'));
      badge('helm', loadout.armor.style ? loadout.armor.name : loadout.armor.name, loadout.armor.name);
    } else {
      badge('sword', this.env.tr('hudBlade'), this.env.tr('hudBlade'));
      badge('shield', this.env.tr('hudShield'), this.env.tr('hudShield'));
    }
  }

  private applyLabels(): void {
    const tr = this.env.tr;
    this.q('roundWord').textContent = tr('hudRound');
    this.q('beatenLabel').textContent = tr('hudOpponentsBeaten');
    this.q('remainingLabel').textContent = tr('hudOpponentsRemaining');
    this.q('denarsLabel').textContent = tr('hudDenars');
    this.q('betLabel').textContent = tr('hudBet');
    this.q('listsLabel').textContent = tr('hudLists');
    this.q('chestLabel').textContent = tr('hudHealth');
    this.q('staminaLabel').textContent = tr('hudStamina');
    this.q('spectateTitle').textContent = tr('hudSpectating');
    this.q('spectateSub').textContent = tr('hudSpectatingSub');
    this.q('playerName').textContent = this.profileName;
    this.q('rank').textContent = rankForLevel(this.env.profile.level);
    this.q('level').textContent = String(this.env.profile.level);
  }

  update(hud: HudState): void {
    this.mode = hud.mode;
    this.root.dataset.mode = hud.mode;
    const tr = this.env.tr;

    // Mode counters -------------------------------------------------
    if (hud.mode === 'melee') {
      this.q('beaten').textContent = num(hud.opponentsBeaten);
      this.q('remaining').textContent = num(hud.opponentsRemaining);
      const total = hud.opponentsTotal > 0 ? hud.opponentsTotal : 1;
      const cleared = Math.max(0, total - hud.opponentsRemaining);
      (this.q('remainingFill') as HTMLElement).style.width = pct(cleared, total);
    } else {
      const parsed = roundFromLabel(hud.roundLabel);
      const fallback = Math.min(Math.max(1, hud.roundIndex + 1), Math.max(1, hud.roundTotal));
      const index = parsed ?? fallback;
      this.q('roundNum').textContent = roman(index);
      this.q('roundOf').textContent = `${tr('hudOf')} ${roman(Math.max(index, hud.roundTotal))}`;
      // Strip a bare "Round N of M" prefix; keep evocative round names.
      const named = (hud.roundLabel ?? '').replace(
        /^round\s+[^\s]+\s+(?:of|—|–|-)\s+[^\s]+\s*[—–:·-]?\s*/i,
        '',
      ).trim();
      const labelEl = this.q('roundLabel');
      labelEl.textContent = named;
      labelEl.classList.toggle('is-empty', named.length === 0);
    }

    // Objective -----------------------------------------------------
    this.q('modeLabel').textContent = hud.mode === 'melee' ? tr('modeMelee') : tr('modeTournament');
    this.q('objective').textContent = hud.objective;

    // Team pips -----------------------------------------------------
    this.renderPips(hud.teams, hud.mode === 'tournament');

    // Purse ---------------------------------------------------------
    this.q('denars').textContent = num(hud.denars);
    const betWrap = this.q('betWrap');
    if (hud.bet > 0) {
      betWrap.classList.add('is-visible');
      this.q('bet').textContent = num(hud.bet);
    } else {
      betWrap.classList.remove('is-visible');
    }

    // Vitals --------------------------------------------------------
    const hp = Math.max(0, hud.health);
    const hpPct = hud.maxHealth > 0 ? hp / hud.maxHealth : 0;
    (this.q('hpFill') as HTMLElement).style.width = pct(hp, hud.maxHealth);
    (this.q('stFill') as HTMLElement).style.width = pct(hud.stamina, hud.maxStamina);
    this.q('hpVal').textContent = num(hp);
    this.q('stVal').textContent = num(hud.stamina);
    const vitals = this.q('vitals');
    vitals.classList.toggle('is-critical', hpPct <= 0.3 && hp > 0);
    vitals.classList.toggle('is-empty', hp <= 0);
    if (this.lastHp >= 0 && hp < this.lastHp) {
      vitals.classList.add('is-hit');
      window.clearTimeout(this.hitTimer);
      this.hitTimer = window.setTimeout(() => vitals.classList.remove('is-hit'), 320);
    }
    this.lastHp = hp;

    // Hint ----------------------------------------------------------
    const hintEl = this.q('hint');
    if (hud.hint && this.hintsEnabled) {
      hintEl.classList.add('is-visible');
      this.q('hintText').textContent = hud.hint;
    } else {
      hintEl.classList.remove('is-visible');
    }

    // Spectating ----------------------------------------------------
    this.root.classList.toggle('is-spectating', !hud.playerAlive);
    this.q('spectate').classList.toggle('is-visible', !hud.playerAlive);

    // Target --------------------------------------------------------
    this.setTarget(hud.target);
  }

  private renderPips(teams: TournamentTeam[] | undefined, visible: boolean): void {
    const wrap = this.q('pips');
    const list = visible && teams ? teams : [];
    const sig = list.map((t) => `${t.id}:${t.alive}:${t.members.length}:${t.isPlayerTeam ? 1 : 0}`).join('|');
    wrap.classList.toggle('is-visible', list.length > 0);
    if (sig === this.pipsSig) return;
    this.pipsSig = sig;
    wrap.replaceChildren();
    for (const team of list) {
      const palette = TEAM_PALETTE[team.id % TEAM_PALETTE.length];
      const color2 = palette ? '#' + palette.secondary.toString(16).padStart(6, '0') : '#d9c9a3';
      const pip = div(`bm-pip${team.isPlayerTeam ? ' is-player' : ''}`);
      pip.style.setProperty('--pip-color', team.color);
      pip.innerHTML = `<span class="bm-pip-crest">${crestSvg(team.id, team.color, color2)}</span>
        <span class="bm-pip-count">${team.alive}<em>/${team.members.length}</em></span>`;
      pip.title = `${team.name} — ${team.alive}/${team.members.length}`;
      wrap.appendChild(pip);
    }
  }

  setTarget(target: TargetView | null): void {
    const wrap = this.q('target');
    if (!target || !target.visible) {
      wrap.classList.remove('is-visible', 'is-locked', 'is-friendly');
      return;
    }
    wrap.classList.add('is-visible');
    wrap.classList.toggle('is-locked', target.isLocked);
    wrap.classList.toggle('is-friendly', target.isPlayerTeam);
    const x = Math.round(target.screenX);
    const y = Math.round(target.screenY);
    wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    wrap.style.setProperty('--target-color', target.teamColor || '#d9c9a3');

    // Keep the nameplate inside the viewport while the brackets stay on target.
    const vw = window.innerWidth || 1280;
    const plate = this.q('targetPlate');
    const halfW = 88;
    const clampedX = Math.min(Math.max(x, halfW + 10), Math.max(halfW + 10, vw - halfW - 10));
    const below = y < 150;
    plate.classList.toggle('is-below', below);
    plate.style.left = `${clampedX - x}px`;
    plate.style.top = below ? '20px' : '-22px';
    this.q('targetName').textContent = target.name;
    this.q('targetMeta').textContent = `${Math.round(target.distance)} m${target.isLocked ? ' · ' + this.env.tr('hudLocked') : ''}`;
    (this.q('targetHp') as HTMLElement).style.width = pct(target.hp, target.maxHp);
    this.q('targetTeam').style.background = target.teamColor || '#d9c9a3';
  }

  pushLog(entry: { text: string; kind: LogKind }): void {
    const line = div(`bm-logline bm-logline--${entry.kind}`);
    const mark = span('bm-logline-mark');
    const text = span('bm-logline-text', entry.text);
    append(line, mark, text);
    this.logEl.prepend(line);
    while (this.logEl.childElementCount > MAX_LOG_LINES) {
      this.logEl.lastElementChild?.remove();
    }

    const dim = window.setTimeout(() => {
      line.classList.add('is-old');
      this.timers.delete(dim);
    }, LOG_DIM_MS);
    const remove = window.setTimeout(() => {
      line.remove();
      this.timers.delete(remove);
    }, LOG_REMOVE_MS);
    this.timers.add(dim);
    this.timers.add(remove);
  }

  toastSlot(): HTMLElement {
    return this.q('log');
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    window.clearTimeout(this.hitTimer);
    this.root.remove();
  }
}

const HUD_MARKUP = `
<div class="bm-hud-counts">
  <div class="bm-counts-melee">
    <div class="bm-counter">
      <span class="bm-counter-label" data-ref="beatenLabel">Opponents Beaten:</span>
      <b class="bm-counter-value" data-ref="beaten">0</b>
    </div>
    <div class="bm-counter bm-counter--remain">
      <span class="bm-counter-label" data-ref="remainingLabel">Opponents Remaining:</span>
      <b class="bm-counter-value" data-ref="remaining">0</b>
    </div>
    <div class="bm-counter-track"><i data-ref="remainingFill"></i></div>
  </div>
  <div class="bm-counts-tour">
    <div class="bm-hud-roundrow">
      <span class="bm-hud-roundword" data-ref="roundWord">Round</span>
      <span class="bm-hud-roundnum" data-ref="roundNum">I</span>
      <span class="bm-hud-roundof" data-ref="roundOf">of IV</span>
    </div>
    <div class="bm-hud-roundlabel" data-ref="roundLabel"></div>
  </div>
  <div class="bm-pips" data-ref="pips"></div>
</div>

<div class="bm-hud-objective">
  <span class="bm-hud-mode" data-ref="modeLabel"></span>
  <span class="bm-hud-objtext" data-ref="objective"></span>
</div>

<div class="bm-hud-purse">
  <div class="bm-purse-main">
    <span class="bm-purse-ico" aria-hidden="true">${iconMarkup('coin')}</span>
    <b class="bm-purse-value" data-ref="denars">0</b>
    <span class="bm-purse-label" data-ref="denarsLabel">denars</span>
  </div>
  <div class="bm-purse-bet" data-ref="betWrap">
    <span class="bm-purse-betlabel" data-ref="betLabel">Bet</span>
    <b data-ref="bet">0</b>
  </div>
  <div class="bm-hud-boardhint">
    <kbd class="bm-key">Tab</kbd>
    <span data-ref="listsLabel">Lists</span>
  </div>
</div>

<div class="bm-hud-log" data-ref="log" role="log" aria-live="polite"></div>

<div class="bm-hud-crosshair" aria-hidden="true">
  <span class="bm-ch-dot" data-ref="crosshairDot"></span>
</div>

<div class="bm-hud-hint" data-ref="hint">
  <span class="bm-hud-hint-mark" aria-hidden="true"></span>
  <span data-ref="hintText"></span>
</div>

<div class="bm-vitals" data-ref="vitals">
  <div class="bm-vitals-portrait">
    <span class="bm-medallion" data-ref="portrait"></span>
    <span class="bm-vitals-level" data-ref="level">1</span>
  </div>
  <div class="bm-vitals-bars">
    <div class="bm-vitals-name">
      <span class="bm-vitals-playername" data-ref="playerName">—</span>
      <span class="bm-vitals-rank" data-ref="rank"></span>
    </div>
    <div class="bm-barline">
      <span class="bm-bar-tag" data-ref="chestLabel">Health</span>
      <div class="bm-hbar bm-hbar--hp" role="meter" aria-label="Health">
        <i data-ref="hpFill"></i>
        <span class="bm-hbar-ticks" aria-hidden="true"></span>
        <span class="bm-hbar-gloss" aria-hidden="true"></span>
      </div>
      <b class="bm-barval" data-ref="hpVal">100</b>
    </div>
    <div class="bm-barline bm-barline--stamina">
      <span class="bm-bar-tag" data-ref="staminaLabel">Stamina</span>
      <div class="bm-hbar bm-hbar--st" role="meter" aria-label="Stamina">
        <i data-ref="stFill"></i>
        <span class="bm-hbar-gloss" aria-hidden="true"></span>
      </div>
      <b class="bm-barval" data-ref="stVal">100</b>
    </div>
    <div class="bm-wargear" data-ref="wargear"></div>
  </div>
</div>

<div class="bm-target" data-ref="target">
  <div class="bm-target-plate" data-ref="targetPlate">
    <span class="bm-target-team" data-ref="targetTeam"></span>
    <span class="bm-target-name" data-ref="targetName"></span>
    <span class="bm-target-meta" data-ref="targetMeta"></span>
    <div class="bm-target-hp"><i data-ref="targetHp"></i></div>
    <span class="bm-target-lock" data-ref="targetLock" aria-hidden="true"></span>
  </div>
  <span class="bm-target-bracket bm-target-bracket--tl" aria-hidden="true"></span>
  <span class="bm-target-bracket bm-target-bracket--tr" aria-hidden="true"></span>
  <span class="bm-target-bracket bm-target-bracket--bl" aria-hidden="true"></span>
  <span class="bm-target-bracket bm-target-bracket--br" aria-hidden="true"></span>
</div>

<div class="bm-spectate" data-ref="spectate">
  <span class="bm-spectate-title" data-ref="spectateTitle"></span>
  <span class="bm-spectate-sub" data-ref="spectateSub"></span>
</div>
`;
