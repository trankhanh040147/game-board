/** Shared UI building blocks: shells, buttons, headings, stats, heraldry. */

import type {
  Loadout, MatchStatsView, Profile, Settings, TournamentMember, TournamentTeam, UIHandlers,
} from '../core/types';
import { TEAM_PALETTE, rankForLevel, xpProgress } from '../core/config';
import { formatNumber, formatTime } from '../core/utils';
import type { Lang, Translator } from './i18n';
import { makeTranslator } from './i18n';
import { crestSvg, flourishSvg, iconMarkup, portraitSvg } from './icons';
import { append, div, el, icon, num, span } from './util';

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export interface UIEnv {
  handlers: UIHandlers;
  profile: Profile;
  settings: Settings;
  lang: Lang;
  tr: Translator;
  click(): void;
  hover(): void;
  applySettings(next: Settings): void;
  openCredits(): void;
}

export function makeEnv(
  handlers: UIHandlers,
  profile: Profile,
  settings: Settings,
  click: () => void,
  hover: () => void,
  applySettings: (next: Settings) => void,
  openCredits: () => void,
): UIEnv {
  return {
    handlers,
    profile,
    settings,
    lang: settings.language,
    tr: makeTranslator(settings.language),
    click,
    hover,
    applySettings,
    openCredits,
  };
}

export function toneClass(tone?: string | null): string {
  return tone ? ` bm-tone--${tone}` : '';
}

/* ------------------------------------------------------------------ */
/* Shells                                                              */
/* ------------------------------------------------------------------ */

export interface Shell {
  root: HTMLDivElement;
  panel: HTMLDivElement;
  head: HTMLDivElement;
  body: HTMLDivElement;
  foot: HTMLDivElement;
}

export interface ShellOptions {
  className?: string;
  kicker?: string;
  title?: string;
  subtitle?: string;
  heroIcon?: string;
  tone?: 'victory' | 'defeat' | 'gold' | 'blood' | null;
  /** Optional extra node inserted between title and body (e.g. tabs). */
  headerExtra?: HTMLElement;
}

export function kickerLine(text: string): HTMLDivElement {
  const row = div('bm-kicker');
  append(row, span('bm-kicker-rule'), span('bm-kicker-text', text), span('bm-kicker-rule'));
  return row;
}

export function divider(cls = ''): HTMLDivElement {
  const node = div(`bm-divider${cls ? ' ' + cls : ''}`);
  node.innerHTML = flourishSvg();
  return node;
}

export function screenShell(key: string, opts: ShellOptions): Shell {
  const root = div(`bm-overlay bm-overlay--${key}`);
  root.dataset.screen = key;
  const panel = div(`bm-frame bm-frame--${key}${opts.className ? ' ' + opts.className : ''}`);
  const corners = div('bm-corners');
  append(corners, span('bm-corner bm-corner--tl'), span('bm-corner bm-corner--tr'),
    span('bm-corner bm-corner--bl'), span('bm-corner bm-corner--br'));
  panel.appendChild(corners);

  const head = div('bm-head');
  if (opts.heroIcon) {
    const hero = div(`bm-hero${toneClass(opts.tone)}`);
    hero.innerHTML = `<span class="bm-hero-glyph">${iconMarkup(opts.heroIcon)}</span>`;
    head.appendChild(hero);
  }
  if (opts.kicker) head.appendChild(kickerLine(opts.kicker));
  if (opts.title) {
    const h1 = el('h1', `bm-title${toneClass(opts.tone)}`, opts.title);
    head.appendChild(h1);
  }
  if (opts.subtitle) head.appendChild(el('p', 'bm-sub', opts.subtitle));
  if (opts.title || opts.kicker) head.appendChild(divider());
  if (opts.headerExtra) head.appendChild(opts.headerExtra);

  const body = div('bm-body');
  const foot = div('bm-foot');

  append(panel, head, body, foot);
  root.appendChild(panel);
  return { root, panel, head, body, foot };
}



/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonOptions {
  kind?: ButtonKind;
  meta?: string;
  icon?: string;
  index?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}

export function button(env: UIEnv, label: string, opts: ButtonOptions): HTMLButtonElement {
  const kind = opts.kind ?? 'secondary';
  const node = el('button', `bm-btn bm-btn--${kind}`, undefined);
  node.type = 'button';
  node.disabled = Boolean(opts.disabled);
  if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel);

  if (opts.index) append(node, span('bm-btn-idx', opts.index));
  if (opts.icon) {
    const glyph = span('bm-btn-glyph');
    glyph.innerHTML = iconMarkup(opts.icon);
    node.appendChild(glyph);
  }
  const text = span('bm-btn-text');
  text.appendChild(span('bm-btn-label', label));
  if (opts.meta) text.appendChild(span('bm-btn-meta', opts.meta));
  node.appendChild(text);
  const arrow = span('bm-btn-arrow');
  arrow.innerHTML = iconMarkup('chevron');
  node.appendChild(arrow);

  node.addEventListener('mouseenter', () => {
    if (!node.disabled) env.hover();
  });
  node.addEventListener('click', () => {
    if (node.disabled) return;
    env.click();
    opts.onClick();
  });
  return node;
}

export function iconButton(env: UIEnv, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'bm-iconbtn', undefined);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.innerHTML = iconMarkup('close');
  node.addEventListener('mouseenter', () => env.hover());
  node.addEventListener('click', () => {
    env.click();
    onClick();
  });
  return node;
}

export function keycap(text: string, wide = false): HTMLElement {
  return el('kbd', `bm-key${wide ? ' bm-key--wide' : ''}`, text);
}

export function keyRow(keys: string[], label: string): HTMLDivElement {
  const row = div('bm-keyrow');
  const keysWrap = span('bm-keyrow-keys');
  for (const key of keys) keysWrap.appendChild(keycap(key, key.length > 3));
  append(row, keysWrap, span('bm-keyrow-label', label));
  return row;
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

export function medallion(size = 64, cls = ''): HTMLDivElement {
  const node = div(`bm-medallion${cls ? ' ' + cls : ''}`);
  node.style.setProperty('--med-size', `${size}px`);
  node.innerHTML = portraitSvg();
  return node;
}

export function crest(team: Pick<TournamentTeam, 'id' | 'color'>, cls = ''): HTMLDivElement {
  const node = div(`bm-crestwrap${cls ? ' ' + cls : ''}`);
  const palette = TEAM_PALETTE[team.id % TEAM_PALETTE.length];
  const color2 = palette ? '#' + palette.secondary.toString(16).padStart(6, '0') : '#d9c9a3';
  node.innerHTML = crestSvg(team.id, team.color, color2);
  return node;
}

export function emptyNote(text: string): HTMLDivElement {
  return div('bm-empty', text);
}

export function bar(value: number, max: number, kind: 'hp' | 'stamina' | 'xp' | 'stand' = 'hp'): HTMLDivElement {
  const wrap = div(`bm-meter bm-meter--${kind}`);
  const fill = div('bm-meter-fill');
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  fill.style.width = `${pct}%`;
  append(wrap, fill);
  return wrap;
}

export function chip(txt: string, cls = ''): HTMLSpanElement {
  return span(`bm-chip${cls ? ' ' + cls : ''}`, txt);
}

export function iconChip(iconName: string, txt: string, cls = ''): HTMLSpanElement {
  const node = span(`bm-iconchip${cls ? ' ' + cls : ''}`);
  node.appendChild(icon(iconName));
  node.appendChild(span('bm-iconchip-txt', txt));
  return node;
}

export function statCell(iconName: string, label: string, value: string, cls = ''): HTMLDivElement {
  const cell = div(`bm-stat${cls ? ' ' + cls : ''}`);
  const ico = span('bm-stat-ico');
  ico.innerHTML = iconMarkup(iconName);
  append(cell, ico, span('bm-stat-value', value), span('bm-stat-label', label));
  return cell;
}

export function statsGrid(env: UIEnv, stats: MatchStatsView): HTMLDivElement {
  const grid = div('bm-stats');
  grid.appendChild(statCell('swords', env.tr('resultKills'), num(stats.kills)));
  grid.appendChild(statCell('assists', env.tr('resultAssists'), num(stats.assists)));
  grid.appendChild(statCell('damage', env.tr('resultDamage'), num(stats.damageDealt)));
  grid.appendChild(statCell('taken', env.tr('resultTaken'), num(stats.damageTaken)));
  grid.appendChild(statCell('blocks', env.tr('resultBlocks'), num(stats.blocks)));
  grid.appendChild(statCell('helm', env.tr('resultHeadshots'), num(stats.headshots)));
  grid.appendChild(statCell('clock', env.tr('resultTime'), formatTime(stats.time)));
  return grid;
}

export interface RewardInput {
  denars: number;
  xp: number;
  renown: number;
  bet?: number;
  betWon?: number;
  purse?: number;
}

export function rewardsStrip(env: UIEnv, input: RewardInput): HTMLDivElement {
  const row = div('bm-rewards');
  const add = (iconName: string, value: string, label: string, cls = '') => {
    const cell = div(`bm-reward${cls ? ' ' + cls : ''}`);
    const ico = span('bm-reward-ico');
    ico.innerHTML = iconMarkup(iconName);
    append(cell, ico, span('bm-reward-value', value), span('bm-reward-label', label));
    row.appendChild(cell);
  };
  add('coin', `+${num(input.denars)}`, env.tr('rewardDenars'), input.denars > 0 ? 'is-positive' : 'is-muted');
  add('star', `+${num(input.xp)}`, env.tr('rewardXp'), input.xp > 0 ? 'is-positive' : 'is-muted');
  add('medal', `+${num(input.renown)}`, env.tr('rewardRenown'), input.renown > 0 ? 'is-positive' : 'is-muted');

  if (typeof input.bet === 'number' && input.bet > 0) {
    const won = (input.betWon ?? 0) > 0;
    add('coin', `${won ? '+' : '−'}${num(won ? input.betWon ?? 0 : input.bet)}`,
      won ? env.tr('resultBetWon') : env.tr('resultBetLost'),
      won ? 'is-win' : 'is-loss');
  }
  return row;
}

export function standingsList(
  env: UIEnv,
  members: TournamentMember[],
  limit = 16,
): HTMLDivElement {
  const wrap = div('bm-standings');
  const sorted = [...members].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.name.localeCompare(b.name);
  });
  const shown = sorted.slice(0, limit);
  for (const member of shown) {
    const row = div(`bm-standing${member.alive ? '' : ' is-dead'}${member.isPlayer ? ' is-player' : ''}`);
    const mark = span('bm-standing-mark');
    if (member.isPlayer) mark.innerHTML = iconMarkup('star');
    else if (!member.alive) mark.innerHTML = iconMarkup('skull');
    else mark.innerHTML = iconMarkup('diamond');
    append(row,
      mark,
      span('bm-standing-name', member.name),
      span('bm-standing-kills', num(member.kills)),
      span('bm-standing-state', member.alive ? env.tr('standingsAlive') : env.tr('standingsDown')));
    wrap.appendChild(row);
  }
  const rest = sorted.length - shown.length;
  if (rest > 0) wrap.appendChild(div('bm-standing bm-standing--more', `+${rest} more`));
  return wrap;
}

export function profileStrip(env: UIEnv): HTMLDivElement {
  const profile = env.profile;
  const wrap = div('bm-profile');
  wrap.appendChild(medallion(58));

  const who = div('bm-profile-who');
  who.appendChild(el('div', 'bm-profile-name', profile.name));
  const rank = rankForLevel(profile.level);
  who.appendChild(div('bm-profile-rank',
    span('', rank),
    span('bm-dot-sep', '·'),
    span('', env.tr('profileLevel', { n: profile.level }))));
  const xp = xpProgress(profile.xp);
  const xpBar = div('bm-profile-xp');
  xpBar.appendChild(bar(xp.into, xp.needed, 'xp'));
  who.appendChild(xpBar);
  wrap.appendChild(who);

  wrap.appendChild(div('bm-profile-sep'));

  const stats = div('bm-profile-stats');
  const add = (iconName: string, value: string, label: string) => {
    const cell = div('bm-profile-stat');
    const ico = span('bm-profile-statico');
    ico.innerHTML = iconMarkup(iconName);
    append(cell, ico, span('bm-profile-statval', value), span('bm-profile-statlabel', label));
    stats.appendChild(cell);
  };
  add('coin', formatNumber(profile.denars), env.tr('profileDenars'));
  add('medal', formatNumber(profile.renown), env.tr('profileRenown'));
  add('crown', formatNumber(profile.tournamentsWon), env.tr('profileWins'));
  wrap.appendChild(stats);
  return wrap;
}

export function loadoutCard(env: UIEnv, loadout: Loadout): HTMLDivElement {
  const card = div('bm-loadout');
  card.appendChild(div('bm-loadout-title', loadout.title));
  const rows: [string, string, string][] = [
    ['sword', env.tr('hudBlade'), loadout.weapon.name],
    ['shield', env.tr('hudShield'), loadout.shield ? loadout.shield.name : '—'],
    ['blocks', 'Armour', loadout.armor.name],
    ['helm', 'Helmet', loadout.helmet.name],
  ];
  const grid = div('bm-loadout-grid');
  for (const [ico, label, value] of rows) {
    const row = div('bm-loadout-row');
    const glyph = span('bm-loadout-ico');
    glyph.innerHTML = iconMarkup(ico);
    append(row, glyph, span('bm-loadout-label', label), span('bm-loadout-value', value));
    grid.appendChild(row);
  }
  card.appendChild(grid);
  return card;
}

export function teamCard(env: UIEnv, team: TournamentTeam, opts: { compact?: boolean; showKills?: boolean } = {}): HTMLDivElement {
  const card = div(`bm-team${team.isPlayerTeam ? ' is-player' : ''}${opts.compact ? ' is-compact' : ''}`);
  card.style.setProperty('--team-color', team.color);
  const rosterAlive = team.members.filter((m) => m.alive).length;
  const alive = Math.max(team.alive, rosterAlive);

  const head = div('bm-team-head');
  head.appendChild(crest(team, 'bm-team-crest'));
  const title = div('bm-team-title');
  title.appendChild(el('h3', 'bm-team-name', team.name));
  title.appendChild(div('bm-team-colour',
    team.isPlayerTeam ? env.tr('boardYourHouse') : team.colorName));
  head.appendChild(title);

  const score = div('bm-team-score');
  append(score,
    span('bm-team-alive', String(alive)),
    span('bm-team-total', `/${team.members.length}`));
  head.appendChild(score);
  card.appendChild(head);

  const list = el('ul', 'bm-team-roster');
  for (const member of team.members) {
    const row = el('li', `bm-team-member${member.alive ? '' : ' is-dead'}${member.isPlayer ? ' is-player' : ''}`);
    const mark = span('bm-team-mark');
    if (member.isPlayer) mark.innerHTML = iconMarkup('star');
    append(row,
      mark,
      span('bm-team-member-name', member.name),
      opts.showKills === false ? null : span('bm-team-member-kills', `${num(member.kills)}`));
    list.appendChild(row);
  }
  card.appendChild(list);

  const foot = div('bm-team-foot');
  const meter = bar(alive, Math.max(1, team.members.length), 'stand');
  append(foot, meter, span('bm-team-foot-label',
    `${alive}/${team.members.length} ${env.tr('hudStanding')}`));
  card.appendChild(foot);
  return card;
}

export function roundProgress(
  _env: UIEnv,
  round: number,
  total: number,
  labelFor: (index: number) => string,
): HTMLDivElement {
  const wrap = div('bm-roundtrack');
  for (let i = 1; i <= total; i++) {
    const node = div(`bm-roundnode${i < round ? ' is-done' : i === round ? ' is-current' : ''}`);
    const dot = div('bm-roundnode-dot');
    if (i < round) dot.innerHTML = iconMarkup('check');
    else dot.appendChild(span('', String(i)));
    append(node, dot, span('bm-roundnode-label', labelFor(i)));
    wrap.appendChild(node);
    if (i < total) wrap.appendChild(div('bm-roundline'));
  }
  return wrap;
}

export function sectionTitle(text: string, meta?: string): HTMLDivElement {
  const row = div('bm-section-head');
  row.appendChild(el('h2', 'bm-section-title', text));
  row.appendChild(span('bm-section-rule'));
  if (meta) row.appendChild(span('bm-section-meta', meta));
  return row;
}

