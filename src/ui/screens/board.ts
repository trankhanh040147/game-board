/** Tournament board (bracket + wagers) and the round intro banner. */

import type { GameMode, RoundIntroView, TournamentTeam, TournamentView } from '../../core/types';
import { TOURNAMENT } from '../../core/config';
import { iconMarkup } from '../icons';
import type { UIEnv } from '../shared';
import {
  button, chip, crest, divider, emptyNote, loadoutCard, roundProgress, screenShell,
  sectionTitle, teamCard,
} from '../shared';
import { append, div, el, num, roman, span } from '../util';

const BET_STEPS = [0, 25, 50, 100, 150];

function shortRoundName(index: number): string {
  const def = TOURNAMENT.rounds[index - 1];
  if (!def) return `Round ${roman(index)}`;
  return def.name.replace(/^The\s+/i, '');
}

function aliveCount(teams: TournamentTeam[]): { alive: number; total: number } {
  let alive = 0;
  let total = 0;
  for (const team of teams) {
    alive += Math.max(team.alive, team.members.filter((m) => m.alive).length);
    total += team.members.length;
  }
  return { alive, total };
}

function wagerRow(
  env: UIEnv,
  view: TournamentView,
  selected: number,
  onPick: (amount: number) => void,
): HTMLDivElement {
  const row = div('bm-bets');
  for (const amount of BET_STEPS) {
    const disabled = !view.canBet || amount > view.maxBet;
    const btn = el('button', `bm-betchip${amount === selected ? ' is-selected' : ''}${amount === 0 ? ' bm-betchip--none' : ''}`);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.setAttribute('aria-pressed', amount === selected ? 'true' : 'false');
    btn.innerHTML = amount === 0
      ? `<span class="bm-betchip-none">No wager</span>`
      : `<span class="bm-betchip-coin">${iconMarkup('coin')}</span><span class="bm-betchip-value">${amount}</span>`;
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) env.hover();
    });
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      env.click();
      onPick(amount);
    });
    row.appendChild(btn);
  }
  return row;
}

export function renderBracket(env: UIEnv, view: TournamentView): HTMLElement {
  const tr = env.tr;
  const counts = aliveCount(view.teams);
  const shell = screenShell('bracket', {
    className: 'bm-frame--board',
    kicker: tr('boardKicker'),
    title: view.isFinal ? tr('boardFinal') : view.roundName,
    subtitle: `${tr('boardRound')} ${roman(view.round)} ${tr('hudOf')} ${roman(view.totalRounds)} · ${view.arenaName}`,
    tone: view.isFinal ? 'gold' : null,
  });

  const headExtra = div('bm-board-head');
  headExtra.appendChild(roundProgress(env, view.round, view.totalRounds, shortRoundName));
  const objective = div('bm-board-objective');
  const objIco = span('bm-board-objective-ico');
  objIco.innerHTML = iconMarkup('banner');
  append(objective, objIco, span('', view.roundObjective));
  headExtra.appendChild(objective);

  const body = div('bm-board');
  const main = div('bm-board-main');
  main.appendChild(sectionTitle(
    tr('boardHouses'),
    `${counts.alive}/${counts.total} ${tr('hudStanding')}`,
  ));
  const teams = div(`bm-teams${view.teams.length <= 2 ? ' bm-teams--final' : ''}`);
  for (const team of view.teams) {
    teams.appendChild(teamCard(env, team, { compact: view.teams.length > 2 }));
  }
  main.appendChild(teams);

  const extra = div('bm-board-extra');
  extra.appendChild(sectionTitle(tr('introArms')));
  extra.appendChild(loadoutCard(env, view.playerLoadout));
  main.appendChild(extra);
  body.appendChild(main);

  const side = div('bm-board-side');

  const purse = div('bm-purse-panel');
  const purseHead = div('bm-purse-head');
  append(purseHead, span('bm-purse-kicker', tr('boardPurse')));
  const purseAmount = div('bm-purse-amount');
  const purseIco = span('bm-purse-amount-ico');
  purseIco.innerHTML = iconMarkup('coin');
  append(purseAmount, purseIco, span('bm-purse-amount-value', num(view.purse)), span('bm-purse-amount-label', tr('rewardDenars')));
  purse.appendChild(purseHead);
  purse.appendChild(purseAmount);
  const purseRows: [string, string][] = [
    [tr('boardYourPurse'), num(view.denars)],
    [tr('boardRound'), `${roman(view.round)} / ${roman(view.totalRounds)}`],
  ];
  for (const [key, value] of purseRows) {
    const row = div('bm-purse-row');
    append(row, span('bm-purse-row-label', key), span('bm-purse-row-value', value));
    purse.appendChild(row);
  }
  side.appendChild(purse);

  const survivors = div('bm-survivors');
  survivors.appendChild(sectionTitle(tr('boardSurvivors')));
  const survivorRow = div('bm-survivor-row');
  if (view.survivors.length === 0) survivorRow.appendChild(emptyNote(tr('boardNoSurvivors')));
  for (const member of view.survivors) {
    const node = div(`bm-survivor${member.isPlayer ? ' is-player' : ''}`);
    append(node,
      span('bm-survivor-name', member.name),
      span('bm-survivor-kills', num(member.kills)));
    survivorRow.appendChild(node);
  }
  survivors.appendChild(survivorRow);
  side.appendChild(survivors);

  const wager = div('bm-wager');
  wager.appendChild(sectionTitle(tr('boardWager')));
  let selected = view.bet;
  const wagerNote = div('bm-wager-note', view.canBet ? tr('boardBetNote') : tr('boardBetClosed'));
  const rowWrap = div('bm-wager-content');
  const refresh = () => {
    const next = wagerRow(env, view, selected, (amount) => {
      selected = amount;
      env.handlers.onBet(amount);
      refresh();
    });
    const existing = rowWrap.querySelector('.bm-bets');
    if (existing) existing.replaceWith(next);
    else rowWrap.prepend(next);
  };
  refresh();
  wager.appendChild(rowWrap);
  wager.appendChild(wagerNote);
  side.appendChild(wager);

  body.appendChild(side);
  shell.body.appendChild(headExtra);
  shell.body.appendChild(body);
  shell.body.appendChild(divider('bm-divider--tight'));

  shell.foot.appendChild(button(env, tr('withdraw'), {
    kind: 'ghost', icon: 'close', onClick: () => env.handlers.onQuitToMenu(),
  }));
  const footNote = div('bm-foot-note', tr('boardEntryHint'));
  shell.foot.appendChild(footNote);
  shell.foot.appendChild(button(env, view.isFinal ? tr('enterChampionship') : tr('enterLists'), {
    kind: 'primary', icon: view.isFinal ? 'crown' : 'sword',
    onClick: () => env.handlers.onEnterRound(),
  }));

  return shell.root;
}

/* ------------------------------------------------------------------ */
/* Round intro                                                         */
/* ------------------------------------------------------------------ */

function roundKicker(view: RoundIntroView, modeLabel: string): string {
  if (view.mode === 'melee') return modeLabel;
  if (view.isFinal) return 'THE CHAMPIONSHIP';
  return `ROUND ${roman(view.round)} OF ${roman(view.totalRounds)}`;
}

function duelCard(env: UIEnv, team: TournamentTeam, side: 'left' | 'right'): HTMLElement {
  const card = div(`bm-duel bm-duel--${side}${team.isPlayerTeam ? ' is-player' : ''}`);
  card.style.setProperty('--team-color', team.color);
  card.appendChild(crest(team, 'bm-duel-crest'));
  const member = team.members[0];
  card.appendChild(div('bm-duel-house', team.name));
  card.appendChild(div('bm-duel-name', member ? member.name : '—'));
  if (member) {
    card.appendChild(div('bm-duel-kills', `${num(member.kills)} ${env.tr('boardKills')}`));
  }
  return card;
}

export function renderRoundIntro(env: UIEnv, view: RoundIntroView): HTMLElement {
  const tr = env.tr;
  const mode: GameMode = view.mode;
  const isMelee = mode === 'melee';
  const duel = view.teams.length === 2 && view.teams.every((team) => team.members.length === 1);
  const shell = screenShell('intro', {
    className: `bm-frame--intro${duel ? ' bm-frame--duel' : ''}${isMelee ? ' is-melee' : ''}`,
    kicker: roundKicker(view, tr('modeMelee')),
    title: view.isFinal ? tr('introFinal') : view.roundName,
    subtitle: view.objective,
    tone: view.isFinal ? 'gold' : null,
  });

  if (duel) {
    const stage = div('bm-duel-stage');
    stage.appendChild(duelCard(env, view.teams[0], 'left'));
    const vs = div('bm-duel-vs');
    vs.appendChild(span('bm-duel-vs-rule'));
    vs.appendChild(span('bm-duel-vs-text', tr('introVs')));
    vs.appendChild(span('bm-duel-vs-rule'));
    stage.appendChild(vs);
    stage.appendChild(duelCard(env, view.teams[1], 'right'));
    shell.body.appendChild(stage);
  } else {
    const teams = div('bm-intro-teams');
    for (const team of view.teams) {
      teams.appendChild(teamCard(env, team, { compact: view.teams.length > 2, showKills: false }));
    }
    shell.body.appendChild(teams);
  }

  const lower = div('bm-intro-lower');
  lower.appendChild(loadoutCard(env, view.loadout));
  const roundMeta = div('bm-intro-meta');
  if (!isMelee) roundMeta.appendChild(roundProgress(env, view.round, view.totalRounds, shortRoundName));
  const note = div('bm-intro-note');
  const noteIco = span('bm-intro-note-ico');
  noteIco.innerHTML = iconMarkup('sword');
  append(note, noteIco, span('', tr('introAwait')));
  roundMeta.appendChild(note);
  lower.appendChild(roundMeta);
  shell.body.appendChild(lower);

  if (isMelee) {
    const footnote = div('bm-intro-footnote');
    footnote.appendChild(chip(`${tr('modeMelee')} · ${tr('introArms')}`, 'bm-chip--muted'));
    shell.foot.appendChild(footnote);
  } else {
    const foot = div('bm-intro-footnote');
    append(foot,
      chip(tr('modeTournament'), 'bm-chip--muted'),
      span('bm-intro-footnote-sep', '·'),
      span('', tr('introArms')),
      span('bm-intro-footnote-sep', '·'),
      span('', view.loadout.title));
    shell.foot.appendChild(foot);
  }

  const skip = div('bm-intro-skip');
  for (const key of ['Enter', 'Space']) {
    const cap = el('kbd', 'bm-key', key);
    skip.appendChild(cap);
    if (key === 'Enter') skip.appendChild(span('bm-intro-skip-or', tr('introOr')));
  }
  append(skip, span('bm-intro-skip-text', `— ${tr('introSkip')}`));
  shell.foot.appendChild(skip);
  return shell.root;
}
