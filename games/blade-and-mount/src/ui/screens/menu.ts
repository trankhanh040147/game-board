/** Main menu over the live scene, plus the credits scroll. */

import type { Profile } from '../../core/types';
import { GAME_SUBTITLE, GAME_TITLE } from '../../core/config';
import { iconMarkup } from '../icons';
import type { UIEnv } from '../shared';
import { button, divider, profileStrip, screenShell } from '../shared';
import { append, div, el, span } from '../util';

const TIPS_EN = [
  'A knight who forgets his shield is a knight who forgets his name.',
  'The crowd remembers kills. The purse remembers victories.',
  'Hold the guard, read the windup, then answer it.',
  'Stamina is the true armour of the lists.',
  'Two houses advance from the grand melee. Do not spend your strength early.',
];

const TIPS_VI = [
  'Kẻ quên khiên là kẻ quên tên mình.',
  'Khán đài nhớ những mạng hạ. Túi tiền nhớ những trận thắng.',
  'Giữ thế thủ, đọc đòn mở, rồi đáp trả.',
  'Thể lực mới là bộ giáp thật của đấu trường.',
  'Hai nhà tiến tiếp từ hỗn chiến. Đừng tiêu hết sức từ đầu.',
];

function titleParts(): [string, string] {
  const [left, right] = GAME_TITLE.split('&').map((part) => part.trim());
  return [left, right ?? ''];
}

export function renderMainMenu(env: UIEnv): HTMLElement {
  const root = div('bm-menu');
  root.dataset.screen = 'menu';

  append(root,
    div('bm-menu-scrim bm-menu-scrim--left'),
    div('bm-menu-scrim bm-menu-scrim--top'),
    div('bm-menu-scrim bm-menu-scrim--bottom'),
    div('bm-menu-vignette'));

  const inner = div('bm-menu-inner');

  const head = el('header', 'bm-menu-head');
  const overline = div('bm-menu-overline');
  const dia = span('bm-menu-overline-diamond');
  dia.innerHTML = iconMarkup('diamond');
  append(overline, dia, span('bm-menu-overline-text', env.tr('menuOverline')), dia.cloneNode(true) as HTMLElement);
  head.appendChild(overline);

  const [first, second] = titleParts();
  const title = el('h1', 'bm-menu-title');
  title.setAttribute('aria-label', GAME_TITLE);
  append(title, span('bm-menu-title-word', first), span('bm-menu-title-amp', '&'), span('bm-menu-title-word', second));
  head.appendChild(title);

  const subtitle = div('bm-menu-subtitle');
  append(subtitle, span('bm-menu-subtitle-rule'), span('bm-menu-subtitle-text', GAME_SUBTITLE), span('bm-menu-subtitle-rule'));
  head.appendChild(subtitle);
  inner.appendChild(head);

  const nav = el('nav', 'bm-menu-nav');
  nav.setAttribute('aria-label', 'Main');
  const navItems: { label: string; meta: string; icon: string; index: string; act: () => void; primary?: boolean }[] = [
    {
      label: env.tr('menuTournament'), meta: env.tr('menuTournamentMeta'), icon: 'sword', index: 'I',
      act: () => env.handlers.onStartTournament(), primary: true,
    },
    {
      label: env.tr('menuMelee'), meta: env.tr('menuMeleeMeta'), icon: 'swords', index: 'II',
      act: () => env.handlers.onStartMelee(),
    },
    {
      label: env.tr('menuControls'), meta: env.tr('menuControlsMeta'), icon: 'key', index: 'III',
      act: () => env.handlers.onOpenControls(),
    },
    {
      label: env.tr('menuSettings'), meta: env.tr('menuSettingsMeta'), icon: 'gear', index: 'IV',
      act: () => env.handlers.onOpenSettings(),
    },
    {
      label: env.tr('menuCredits'), meta: env.tr('menuCreditsMeta'), icon: 'scroll', index: 'V',
      act: () => env.openCredits(),
    },
  ];
  for (const item of navItems) {
    const btn = button(env, item.label, {
      kind: item.primary ? 'primary' : 'secondary',
      meta: item.meta,
      icon: item.icon,
      index: item.index,
      onClick: item.act,
    });
    btn.classList.add('bm-menu-btn');
    nav.appendChild(btn);
  }
  inner.appendChild(nav);
  root.appendChild(inner);

  const profileWrap = div('bm-menu-profile');
  profileWrap.appendChild(profileStrip(env));
  root.appendChild(profileWrap);

  const tip = div('bm-menu-tip');
  const tips = env.lang === 'vi' ? TIPS_VI : TIPS_EN;
  const pick = Math.abs(env.profile.totalKills + env.profile.denars + env.profile.renown) % tips.length;
  append(tip,
    div('bm-menu-tip-kicker', env.tr('menuTipKicker')),
    div('bm-menu-tip-text', tips[pick]));
  root.appendChild(tip);

  const edition = div('bm-menu-edition');
  append(edition, span('bm-menu-edition-dot'), env.tr('menuEdition'));
  root.appendChild(edition);

  root.appendChild(div('bm-menu-fade'));
  return root;
}

export function renderCredits(env: UIEnv, onBack: () => void): HTMLElement {
  const shell = screenShell('credits', {
    kicker: env.tr('menuOverline'),
    title: env.tr('creditsTitle'),
    subtitle: env.tr('creditsSub'),
    heroIcon: 'scroll',
    className: 'bm-frame--narrow',
  });

  const prose = div('bm-credits-prose');
  prose.appendChild(el('p', 'bm-credits-lead', env.tr('creditsBody')));
  shell.body.appendChild(prose);
  shell.body.appendChild(divider('bm-divider--tight'));

  const rows: [string, string, string][] = [
    ['banner', env.tr('roleArena'), 'Arena & atmosphere'],
    ['helm', env.tr('roleFighters'), 'Characters & animation'],
    ['swords', env.tr('roleAi'), 'Combat intelligence'],
    ['scroll', env.tr('roleUi'), 'Interface & audio'],
  ];
  const grid = div('bm-credits-grid');
  for (const [ico, role, detail] of rows) {
    const cell = div('bm-credit');
    const glyph = span('bm-credit-ico');
    glyph.innerHTML = iconMarkup(ico);
    append(cell, glyph, span('bm-credit-role', role), span('bm-credit-detail', detail));
    grid.appendChild(cell);
  }
  shell.body.appendChild(grid);

  const tech = div('bm-credits-tech');
  const techRows: [string, string][] = [
    [env.tr('creditsEngine'), env.tr('roleEngine')],
    [env.tr('creditsType'), env.tr('roleType')],
    [env.tr('creditsSound'), env.tr('roleSound')],
  ];
  for (const [label, value] of techRows) {
    const row = div('bm-techrow');
    append(row, span('bm-techrow-label', label), span('bm-techrow-value', value));
    tech.appendChild(row);
  }
  shell.body.appendChild(tech);

  shell.body.appendChild(el('p', 'bm-credits-closing', env.tr('creditsClosing')));

  shell.foot.appendChild(button(env, env.tr('back'), {
    kind: 'secondary', icon: 'chevron', onClick: onBack,
  }));
  return shell.root;
}

/** Profile strip used by the lab to preview other screens in the menu frame. */
export function menuProfile(env: UIEnv, profile: Profile): HTMLElement {
  const previous = env.profile;
  env.profile = profile;
  const node = profileStrip(env);
  env.profile = previous;
  return node;
}
