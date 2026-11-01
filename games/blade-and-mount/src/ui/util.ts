/** Small DOM + formatting helpers shared by every UI screen. */

import { iconMarkup } from './icons';

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
}

export function div(cls = '', ...children: Child[]): HTMLDivElement {
  const node = el('div', cls);
  append(node, ...children);
  return node;
}

export function span(cls = '', ...children: Child[]): HTMLSpanElement {
  const node = el('span', cls);
  append(node, ...children);
  return node;
}

export function icon(name: string, cls = ''): HTMLSpanElement {
  const node = el('span', `bm-ico bm-ico--${name}${cls ? ' ' + cls : ''}`);
  node.innerHTML = iconMarkup(name);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function setHtml(node: HTMLElement, markup: string): HTMLElement {
  node.innerHTML = markup;
  return node;
}

const ROMAN_UNITS: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function roman(value: number): string {
  let n = Math.max(0, Math.round(value));
  if (n <= 0) return '—';
  let out = '';
  for (const [amount, glyph] of ROMAN_UNITS) {
    while (n >= amount) {
      out += glyph;
      n -= amount;
    }
  }
  return out;
}

export function pct(value: number, max: number): string {
  const m = max <= 0 ? 1 : max;
  return `${Math.max(0, Math.min(100, (value / m) * 100)).toFixed(2)}%`;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function num(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

export function time(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function signed(value: number): string {
  const v = Math.round(value);
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US')}`;
}

/** Adds an enter transition class on the next frame. */
export function animateIn(node: HTMLElement, cls = 'is-in'): void {
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add(cls)));
}
