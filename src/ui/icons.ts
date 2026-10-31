/**
 * Vector icon set + heraldry generated inline (no external assets).
 * All icons paint with `currentColor`; CSS controls size/weight.
 */

function svg(viewBox: string, body: string): string {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;
}

const SWORD = `
  <path d="M12 2.6 14.5 7.2v7.4H9.5V7.2L12 2.6Z"/>
  <path d="M6.8 14.6h10.4"/>
  <path d="M12 14.6v5.6"/>
  <circle cx="12" cy="21.2" r="1.1"/>
`;

const CROSSED_SWORDS = `
  <path d="M4.4 20.6 17.6 7.4"/>
  <path d="M15.2 4.2 20 4l-.4 4.8"/>
  <path d="M19.6 20.6 6.4 7.4"/>
  <path d="M8.8 4.2 4 4l.4 4.8"/>
`;

const SHIELD = `
  <path d="M12 2.6 20.2 5.6v6.2c0 5.1-3.7 8.6-8.2 10.2-4.5-1.6-8.2-5.1-8.2-10.2V5.6L12 2.6Z"/>
  <path d="M12 6.4v13.4"/>
`;

const HELM = `
  <path d="M12 2.6c-4.3 0-6.9 2.8-6.9 6.8v4.1c0 4.6 2.8 7.6 6.9 8.2 4.1-.6 6.9-3.6 6.9-8.2V9.4c0-4-2.6-6.8-6.9-6.8Z"/>
  <path d="M5.7 11.8h12.6"/>
  <path d="M12 11.8v7.4"/>
  <circle cx="9.2" cy="15.4" r=".85" fill="currentColor" stroke="none"/>
  <circle cx="14.8" cy="15.4" r=".85" fill="currentColor" stroke="none"/>
`;

const COIN = `
  <circle cx="12" cy="12" r="8.8"/>
  <circle cx="12" cy="12" r="6"/>
  <path d="M12 8.2v7.6M9.9 9.9h3.3a1.7 1.7 0 0 1 0 3.4H9.9"/>
`;

const CROWN = `
  <path d="M3.6 17.2 5 7.4l4.2 3.9L12 5.2l2.8 6.1L19 7.4l1.4 9.8"/>
  <path d="M4.2 20.2h15.6"/>
  <circle cx="5" cy="6.6" r=".9" fill="currentColor" stroke="none"/>
  <circle cx="19" cy="6.6" r=".9" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="4.6" r=".9" fill="currentColor" stroke="none"/>
`;

const WREATH = `
  <path d="M12 21.4C6.6 21.4 3 17.3 3 12.3c0-3 1.2-5.6 3.3-7.4"/>
  <path d="M12 21.4c5.4 0 9-4.1 9-9.1 0-3-1.2-5.6-3.3-7.4"/>
  <path d="M5.4 8.2 2.9 7.5M4.2 11.9 1.8 11M4.7 15.6l-2.1 1.3M6.9 18.4l-1.5 2M9.8 20.4l-.7 2"/>
  <path d="M16.4 6.6l2.2-1.5M18.9 10.4l2.3-1M19.2 14.4l2.2.8M17.4 18l1.6 1.9M14.2 20.4l.7 2"/>
  <path d="M12 7.6v8.2M8.8 11.2l3.2 2.6 3.2-2.6"/>
`;

const MEDAL = `
  <path d="M9 13.8 6.2 21.2l5.8-2.9 5.8 2.9L15 13.8"/>
  <circle cx="12" cy="8.4" r="5.6"/>
  <path d="m12 5.2 1.05 2.2 2.4.32-1.76 1.66.43 2.4L12 10.62l-2.12 1.16.43-2.4L8.55 7.72l2.4-.32L12 5.2Z" fill="currentColor" stroke="none"/>
`;

const STAR4 = `
  <path d="M12 2.4 13.9 9.5 21 11.4l-7.1 1.9L12 20.4l-1.9-7.1L3 11.4l7.1-1.9L12 2.4Z"/>
`;

const ASSISTS = `
  <circle cx="8.6" cy="8.8" r="2.7"/>
  <circle cx="16.8" cy="10.2" r="2.1"/>
  <path d="M3.2 19.8c.7-3.3 2.6-5.1 5.2-5.1 2.7 0 4.6 1.8 5.3 5.1"/>
  <path d="M14.6 16.6c.8-2 2.2-3.1 3.8-3.1 2.2 0 3.7 1.9 4.2 5"/>
`;

const BURST = `
  <path d="M12 2.6 13.9 8.9 19.8 7.1 16.1 12.2 20.9 15.6 14.7 15.8 15.2 21.6 12 16.4 8.8 21.6 9.3 15.8 3.1 15.6 7.9 12.2 4.2 7.1 10.1 8.9 12 2.6Z"/>
`;

const TAKEN = `
  <path d="M12 2.6 20.2 5.6v6.2c0 5.1-3.7 8.6-8.2 10.2-4.5-1.6-8.2-5.1-8.2-10.2V5.6L12 2.6Z"/>
  <path d="m12.4 7.2 2.3 3.7-2.4 2.1 2.2 2.9-1.2 2.4"/>
`;

const BLOCKS = `
  <path d="M12 2.6 20.2 5.6v6.2c0 5.1-3.7 8.6-8.2 10.2-4.5-1.6-8.2-5.1-8.2-10.2V5.6L12 2.6Z"/>
  <path d="m8.2 11.6 2.6 2.7 5.2-5.4"/>
`;

const CLOCK = `
  <circle cx="12" cy="12.4" r="8.6"/>
  <path d="M12 7.4v5.4l3.6 2.2"/>
  <path d="M9.4 2.6h5.2"/>
`;

const SCROLL = `
  <path d="M6.4 4.4h11.2a2.2 2.2 0 0 1 2.2 2.2v12.9H8.2a2.2 2.2 0 0 1-2.2-2.2V6.6c0-1.2-.4-2.2.4-2.2Z"/>
  <path d="M8.8 8.9h7.4M8.8 12.1h7.4M8.8 15.3h4.8"/>
`;

const TARGET = `
  <circle cx="12" cy="12" r="6.3"/>
  <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
  <path d="M12 2.4v3.2M12 18.4v3.2M2.4 12h3.2M18.4 12h3.2"/>
`;

const CHEVRON = `<path d="m9.2 5.2 6.8 6.8-6.8 6.8"/>`;

const CHECK = `<path d="m4.8 12.4 4.6 4.9L19.4 6.4"/>`;

const CLOSE = `<path d="M6 6l12 12M18 6 6 18"/>`;

const GEAR = `
  <circle cx="12" cy="12" r="3.4"/>
  <path d="M12 2.6v2.8M12 18.6v2.8M2.6 12h2.8M18.6 12h2.8M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2"/>
`;

const KEY = `
  <circle cx="8.4" cy="8.4" r="4.2"/>
  <path d="m11.4 11.4 8 8M16.2 16.2l2.2-2.2M18.6 18.6l2.1-2.1"/>
`;

const ARROW = `<path d="M4.4 12h14.4M13.4 6.6 19 12l-5.6 5.4"/>`;

const DIAMOND = `<path d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/>`;

const SKULL = `
  <path d="M12 2.8c-4.7 0-7.7 3.3-7.7 7.5v3.1c0 1.7.9 3 2.3 3.5v3.3h10.8v-3.3c1.4-.5 2.3-1.8 2.3-3.5v-3.1c0-4.2-3-7.5-7.7-7.5Z"/>
  <circle cx="9" cy="10.8" r="1.55" fill="currentColor" stroke="none"/>
  <circle cx="15" cy="10.8" r="1.55" fill="currentColor" stroke="none"/>
  <path d="M10.4 20.2v-2.4M13.6 20.2v-2.4"/>
`;

const BANNER = `
  <path d="M5.2 2.8v18.4"/>
  <path d="M5.2 4.2h13.6l-2.7 4.2 2.7 4.2H5.2"/>
`;

const FLAME = `
  <path d="M12 2.8c3.4 3.5 5.6 6.2 5.6 9.4a5.6 5.6 0 0 1-11.2 0c0-1.8.9-3.5 2.4-5.2.3 1.6 1.1 2.6 2.2 3 .9-2.6.9-4.7 1-7.2Z"/>
`;

const ICONS: Record<string, string> = {
  sword: SWORD,
  swords: CROSSED_SWORDS,
  shield: SHIELD,
  helm: HELM,
  coin: COIN,
  crown: CROWN,
  wreath: WREATH,
  medal: MEDAL,
  star: STAR4,
  assists: ASSISTS,
  damage: BURST,
  taken: TAKEN,
  blocks: BLOCKS,
  clock: CLOCK,
  scroll: SCROLL,
  target: TARGET,
  chevron: CHEVRON,
  check: CHECK,
  close: CLOSE,
  gear: GEAR,
  key: KEY,
  arrow: ARROW,
  diamond: DIAMOND,
  skull: SKULL,
  banner: BANNER,
  flame: FLAME,
};

export type IconName = keyof typeof ICONS;

const BOXES: Record<string, string> = {};

export function iconMarkup(name: string): string {
  const body = ICONS[name];
  if (!body) return '';
  return svg(BOXES[name] ?? '0 0 24 24', body);
}

/* ------------------------------------------------------------------ */
/* Heraldry                                                            */
/* ------------------------------------------------------------------ */

const SHIELD_PATH = 'M20 2 38 7v12c0 10-7 17-18 21C9 36 2 29 2 19V7L20 2Z';
const SHIELD_STROKE = 'M20 2 38 7v12c0 10-7 17-18 21C9 36 2 29 2 19V7L20 2Z';

const EMBLEMS: ((c: string) => string)[] = [
  // cross
  (c) => `<rect x="17" y="7" width="6" height="31" fill="${c}" opacity=".92"/>
          <rect x="6" y="17" width="28" height="6" fill="${c}" opacity=".92"/>`,
  // chevron
  (c) => `<path d="M0 30 20 9l20 21" fill="none" stroke="${c}" stroke-width="7" opacity=".92"/>`,
  // bars
  (c) => `<rect x="0" y="11" width="40" height="4.4" fill="${c}" opacity=".9"/>
          <rect x="0" y="19" width="40" height="4.4" fill="${c}" opacity=".9"/>
          <rect x="0" y="27" width="40" height="4.4" fill="${c}" opacity=".9"/>`,
  // sun / star
  (c) => `<path d="M20 6.5 22.6 17.4 33.5 20 22.6 22.6 20 33.5 17.4 22.6 6.5 20 17.4 17.4Z" fill="${c}" opacity=".92"/>`,
  // bend
  (c) => `<path d="M-8 34 34 -8 42 0 0 42Z" fill="${c}" opacity=".85"/>`,
  // roundel
  (c) => `<circle cx="20" cy="20" r="8.4" fill="${c}" opacity=".92"/>
          <circle cx="20" cy="20" r="3.2" fill="rgba(10,8,5,.6)"/>`,
];

let crestSeq = 0;

/** Heraldic shield SVG for a team/house. */
export function crestSvg(teamIndex: number, color: string, color2 = '#d9c9a3'): string {
  const id = `bm-crest-clip-${++crestSeq}`;
  const emblem = (EMBLEMS[((teamIndex % EMBLEMS.length) + EMBLEMS.length) % EMBLEMS.length])(color2);
  return `<svg class="bm-crest" viewBox="0 0 40 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <defs><clipPath id="${id}"><path d="${SHIELD_PATH}"/></clipPath></defs>
    <path d="${SHIELD_PATH}" fill="${color}"/>
    <g clip-path="url(#${id})">${emblem}</g>
    <path d="${SHIELD_STROKE}" stroke="rgba(12,9,6,.85)" stroke-width="2.4"/>
    <path d="M20 3.4 36.6 8v11c0 9.4-6.7 16.1-16.6 19.8C10.1 35.1 3.4 28.4 3.4 19V8L20 3.4Z" stroke="rgba(240,230,210,.34)" stroke-width=".9"/>
  </svg>`;
}

/** Portrait medallion: a great helm, framed by bronze. */
export function portraitSvg(): string {
  return `<svg class="bm-portrait" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="31" fill="#211810"/>
    <circle cx="32" cy="32" r="30.2" fill="none" stroke="rgba(201,162,74,.5)" stroke-width=".9"/>
    <path d="M32 11.4c-9.9 0-15.4 5.7-15.4 13.6v7.2c0 9.9 6.2 16.1 15.4 17.4 9.2-1.3 15.4-7.5 15.4-17.4V25c0-7.9-5.5-13.6-15.4-13.6Z" fill="#43321f" stroke="#e6c88a" stroke-width="1.4"/>
    <path d="M17.6 30.4h28.8" stroke="#d9b978" stroke-width="1.5"/>
    <path d="M32 30.4v15.2" stroke="#d9b978" stroke-width="1.2"/>
    <path d="M21.4 34.6h7.2M35.4 34.6h7.2" stroke="#0a0705" stroke-width="2.8" stroke-linecap="round"/>
    <circle cx="21.8" cy="25.4" r="1" fill="#e6cf9c"/>
    <circle cx="42.2" cy="25.4" r="1" fill="#e6cf9c"/>
    <circle cx="32" cy="20.6" r="1" fill="#e6cf9c"/>
    <path d="M11.4 58.6c4.6-6.1 11.8-9.2 20.6-9.2s16 3.1 20.6 9.2" fill="#1d150d" stroke="#6b5233" stroke-width="1.1"/>
    <path d="M18.4 50.6c3.6-2.4 8.4-3.6 13.6-3.6s10 1.2 13.6 3.6" stroke="rgba(201,162,74,.32)" stroke-width=".9"/>
  </svg>`;
}

/** Decorative diamond/laurel flourish used between headings and rules. */
export function flourishSvg(): string {
  return `<svg class="bm-flourish" viewBox="0 0 120 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <path d="M2 6h38M80 6h38" stroke="currentColor" stroke-width=".8" opacity=".55"/>
    <path d="m60 1.4 4.6 4.6L60 10.6 55.4 6 60 1.4Z" stroke="currentColor" stroke-width=".9"/>
    <path d="m48 6 3-2.6M72 6l-3-2.6M48 6l3 2.6M72 6l-3 2.6" stroke="currentColor" stroke-width=".8" opacity=".7"/>
  </svg>`;
}
