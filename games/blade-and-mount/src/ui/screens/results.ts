/** Round result, tournament end and arena melee outcome screens. */

import type {
  MatchStatsView, MeleeResultView, RoundResultView, TournamentEndView, TournamentMember,
} from '../../core/types';
import { xpProgress } from '../../core/config';
import { iconMarkup } from '../icons';
import type { RewardInput, UIEnv } from '../shared';
import {
  bar, button, chip, divider, rewardsStrip, screenShell, sectionTitle, standingsList, statsGrid,
} from '../shared';
import { append, div, el, num, roman, span } from '../util';

interface PlayerSummary {
  level: number;
  xp: number;
  denars: number;
  renown: number;
}

function playerProgress(env: UIEnv, player: PlayerSummary): HTMLElement {
  const wrap = div('bm-playerprogress');
  const levelWrap = div('bm-playerprogress-level');
  append(levelWrap,
    span('bm-playerprogress-kicker', env.tr('resultLevel', { n: '' }).replace(/\s*\d+\s*/, ' ').trim() || 'Level'),
    span('bm-playerprogress-value', String(player.level)));
  wrap.appendChild(levelWrap);

  const xp = xpProgress(player.xp);
  const xpWrap = div('bm-playerprogress-xp');
  append(xpWrap, bar(xp.into, xp.needed, 'xp'));
  const xpText = span('bm-playerprogress-xptext', `${num(xp.into)} / ${num(xp.needed)} XP`);
  xpWrap.appendChild(xpText);
  wrap.appendChild(xpWrap);

  const totals = div('bm-playerprogress-totals');
  const add = (iconName: string, value: string, label: string) => {
    const cell = div('bm-playerprogress-total');
    const ico = span('bm-playerprogress-ico');
    ico.innerHTML = iconMarkup(iconName);
    append(cell, ico, span('bm-playerprogress-totalval', value), span('bm-playerprogress-totallabel', label));
    totals.appendChild(cell);
  };
  add('coin', num(player.denars), env.tr('profileDenars'));
  add('medal', num(player.renown), env.tr('profileRenown'));
  wrap.appendChild(totals);
  return wrap;
}

interface OutcomeOptions {
  key: string;
  kicker: string;
  title: string;
  subtitle: string;
  tone: 'victory' | 'defeat' | 'gold';
  heroIcon: string;
  stats: MatchStatsView;
  rewards: RewardInput;
  statsLabel?: string;
  hidePurse?: boolean;
  standings?: TournamentMember[];
  standingsLabel?: string;
  player: PlayerSummary;
  extra?: HTMLElement;
  footerNote?: string;
  primaryLabel: string;
  primaryIcon: string;
  onPrimary: () => void;
}

function renderOutcome(env: UIEnv, opts: OutcomeOptions): HTMLElement {
  const shell = screenShell(opts.key, {
    className: 'bm-frame--outcome',
    kicker: opts.kicker,
    title: opts.title,
    subtitle: opts.subtitle,
    heroIcon: opts.heroIcon,
    tone: opts.tone,
  });

  if (opts.extra) shell.body.appendChild(opts.extra);

  const mid = div('bm-outcome-mid');
  const left = div('bm-outcome-col bm-outcome-col--deeds');
  left.appendChild(sectionTitle(opts.statsLabel ?? env.tr('resultStats')));
  left.appendChild(statsGrid(env, opts.stats));
  mid.appendChild(left);

  const right = div('bm-outcome-col bm-outcome-col--rewards');
  right.appendChild(sectionTitle(env.tr('resultRewards')));
  right.appendChild(rewardsStrip(env, opts.rewards));

  if (!opts.hidePurse) {
    const purse = div('bm-purse');
    const purseRows: [string, string][] = [
      [env.tr('resultPurse'), num(opts.rewards.purse ?? 0)],
      [env.tr('resultWager'), opts.rewards.bet ? num(opts.rewards.bet) : '—'],
    ];
    for (const [label, value] of purseRows) {
      const row = div('bm-purse-row');
      append(row, span('bm-purse-label', label), span('bm-purse-value', value));
      purse.appendChild(row);
    }
    right.appendChild(purse);
  }
  mid.appendChild(right);
  shell.body.appendChild(mid);

  if (opts.standings && opts.standings.length > 0) {
    const standings = div('bm-outcome-standings');
    standings.appendChild(sectionTitle(opts.standingsLabel ?? env.tr('resultStandings')));
    standings.appendChild(standingsList(env, opts.standings, 16));
    shell.body.appendChild(standings);
  }

  shell.body.appendChild(divider('bm-divider--tight'));
  shell.body.appendChild(playerProgress(env, opts.player));

  if (opts.footerNote) {
    const note = div('bm-outcome-note');
    append(note, span('bm-outcome-note-rule'), span('', opts.footerNote), span('bm-outcome-note-rule'));
    shell.foot.appendChild(note);
  }
  shell.foot.appendChild(button(env, opts.primaryLabel, {
    kind: 'primary', icon: opts.primaryIcon, onClick: opts.onPrimary,
  }));
  return shell.root;
}

/* ------------------------------------------------------------------ */

export function renderRoundResult(env: UIEnv, view: RoundResultView): HTMLElement {
  const tr = env.tr;
  const champion = view.champion;
  const victory = champion || view.victory;
  const advanced = view.advanced;
  const title = champion
    ? tr('resultChampion')
    : victory
      ? tr('resultVictory')
      : advanced
        ? tr('resultYouStand')
        : tr('resultDefeat');
  const subtitle = champion
    ? tr('resultChampionSub')
    : advanced
      ? (view.playerSurvived ? tr('resultAdvancedSub') : tr('resultYouStandSub'))
      : tr('resultEliminatedSub');
  const tone: OutcomeOptions['tone'] = champion ? 'gold' : victory ? 'victory' : advanced ? 'gold' : 'defeat';
  const heroIcon = champion ? 'crown' : victory ? 'wreath' : advanced ? 'shield' : 'skull';

  let extra: HTMLElement | undefined;
  if (advanced && view.nextRoundName) {
    extra = div('bm-outcome-badges');
    extra.appendChild(chip(`${tr('resultNext', { name: view.nextRoundName })}`, 'bm-chip--gold'));
    if (!view.playerSurvived) extra.appendChild(chip(tr('resultYouStand'), 'bm-chip--muted'));
  }

  const primaryLabel = champion
    ? tr('claimCrown')
    : advanced
      ? tr('onward')
      : tr('returnToLists');

  return renderOutcome(env, {
    key: 'roundresult',
    kicker: `${view.roundName} · ${tr('hudRound')} ${roman(view.round)} ${tr('hudOf')} ${roman(view.totalRounds)}`,
    title,
    subtitle,
    tone,
    heroIcon,
    stats: view.stats,
    rewards: {
      denars: view.rewardDenars,
      xp: view.rewardXp,
      renown: view.rewardRenown,
      bet: view.bet,
      betWon: view.betWon,
      purse: view.purse,
    },
    standings: view.standings,
    player: {
      level: view.playerLevel, xp: view.playerXp, denars: view.playerDenars, renown: view.playerRenown,
    },
    extra,
    footerNote: champion ? tr('tournamentChampionLine', { name: env.profile.name }) : undefined,
    primaryLabel,
    primaryIcon: champion ? 'crown' : advanced ? 'sword' : 'scroll',
    onPrimary: () => env.handlers.onContinue(),
  });
}

export function renderTournamentEnd(env: UIEnv, view: TournamentEndView): HTMLElement {
  const tr = env.tr;
  const champion = view.champion;
  const title = champion ? tr('resultChampion') : tr('resultEndDefeat');
  const subtitle = champion
    ? tr('resultChampionSub')
    : tr('resultEndEliminated', { n: roman(view.round) });

  const extra = div('bm-outcome-badges');
  if (champion) {
    extra.appendChild(chip(tr('resultWins', { n: view.tournamentsWon }), 'bm-chip--gold'));
  } else {
    extra.appendChild(chip(`${tr('hudRound')} ${roman(view.round)} ${tr('hudOf')} ${roman(view.totalRounds)}`, 'bm-chip--muted'));
    extra.appendChild(chip(tr('resultWins', { n: view.tournamentsWon }), 'bm-chip--muted'));
  }

  return renderOutcome(env, {
    key: 'tournamentend',
    kicker: tr('resultEndKicker'),
    title,
    subtitle,
    tone: champion ? 'gold' : 'defeat',
    heroIcon: champion ? 'crown' : 'skull',
    stats: view.stats,
    statsLabel: tr('resultStatsEnd'),
    rewards: {
      denars: view.rewardDenars,
      xp: view.rewardXp,
      renown: view.rewardRenown,
      bet: view.bet,
      betWon: view.betWon,
      purse: view.purse,
    },
    standings: view.standings,
    standingsLabel: tr('resultStandingsEnd'),
    player: {
      level: view.playerLevel, xp: view.playerXp, denars: view.playerDenars, renown: view.playerRenown,
    },
    extra,
    primaryLabel: tr('returnToLists'),
    primaryIcon: 'scroll',
    onPrimary: () => env.handlers.onContinue(),
  });
}

export function renderMeleeResult(env: UIEnv, view: MeleeResultView): HTMLElement {
  const tr = env.tr;
  const extra = div('bm-melee-hero');
  const score = div('bm-melee-score');
  append(score,
    span('bm-melee-score-value', num(view.beaten)),
    span('bm-melee-score-sep', '/'),
    span('bm-melee-score-total', num(view.total)));
  const scoreLabel = div('bm-melee-score-label');
  append(scoreLabel, span('', tr('meleeBeaten')), span('bm-melee-score-of', tr('meleeOf', { n: view.total })));
  extra.appendChild(score);
  extra.appendChild(scoreLabel);
  const meter = bar(view.beaten, Math.max(1, view.total), 'stand');
  extra.appendChild(meter);
  if (view.best) extra.appendChild(chip(tr('meleeBest'), 'bm-chip--gold'));

  return renderOutcome(env, {
    key: 'meleeresult',
    kicker: tr('modeMelee'),
    title: view.victory ? tr('meleeCleared') : tr('meleeFell'),
    subtitle: view.victory ? tr('meleeSubCleared') : tr('meleeSubFell'),
    tone: view.victory ? 'victory' : 'defeat',
    heroIcon: view.victory ? 'crown' : 'skull',
    stats: view.stats,
    statsLabel: tr('resultStatsMelee'),
    hidePurse: true,
    rewards: {
      denars: view.rewardDenars,
      xp: view.rewardXp,
      renown: view.rewardRenown,
    },
    player: {
      level: view.playerLevel, xp: view.playerXp, denars: view.playerDenars, renown: view.playerRenown,
    },
    extra,
    primaryLabel: view.victory ? tr('claimRewards') : tr('leaveArena'),
    primaryIcon: view.victory ? 'crown' : 'scroll',
    onPrimary: () => env.handlers.onContinue(),
  });
}

export { playerProgress };
export type { PlayerSummary };
