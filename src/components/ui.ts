import { attr, esc } from '../lib/dom'
import { compact, count, dateTime, day, duration, hours, month, time, widthVar } from '../lib/format'
import type { Build, SubagentRecord } from '../data/telemetry'
import { site } from '../data/registry'

/* ------------------------------------------------------------------
   Chrome: header, mobile nav, footer
   ------------------------------------------------------------------ */

const NAV = [
  { href: '/', label: 'The games' },
  { href: '/making-of', label: 'The receipts' },
  { href: '/about', label: 'About' },
]

function isActive(href: string, path: string): boolean {
  if (href === '/') return path === '/'
  return path === href || path.startsWith(href + '/')
}

export function renderHeader(path: string): string {
  const links = NAV.map(
    (item) =>
      `<a class="site-nav__link" href="${item.href}"${isActive(item.href, path) ? ' aria-current="page"' : ''}>${esc(item.label)}</a>`,
  ).join('')

  return `<div class="wrap site-header__inner">
    <a class="wordmark" href="/" aria-label="Game Board — home">
      <span class="wordmark__rule" aria-hidden="true"><i></i><i></i><i></i></span>Game Board
    </a>
    <nav class="site-nav" aria-label="Primary">
      ${links}
      <a class="site-nav__link site-nav__repo" href="${attr(site.repoUrl)}" target="_blank" rel="noopener">GitHub<span aria-hidden="true"> ↗</span></a>
    </nav>
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="mobile-nav">
      <span class="menu-button__bars" aria-hidden="true"><span></span><span></span></span>Menu
    </button>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">
    ${NAV.map((item) => `<a href="${item.href}">${esc(item.label)}</a>`).join('')}
    <a class="mobile-nav__repo" href="${attr(site.repoUrl)}" target="_blank" rel="noopener">GitHub repository ↗</a>
  </nav>`
}

export function renderFooter(): string {
  return `<div class="wrap">
    <p class="site-footer__mark">Game Board<span>.</span></p>
    <div class="site-footer__grid">
      <div>
        <p class="site-footer__tag">${esc(site.tagline)}</p>
      </div>
      <div>
        <h2>The games</h2>
        <ul class="site-footer__list">
          <li><a href="/#shelf">The shelf</a></li>
          <li><a href="/making-of">The receipts</a></li>
          <li><a href="/about">About this board</a></li>
        </ul>
      </div>
      <div>
        <h2>Elsewhere</h2>
        <ul class="site-footer__list">
          <li><a href="${attr(site.repoUrl)}" target="_blank" rel="noopener">Repository ↗</a></li>
          <li><a href="${attr(site.authorUrl)}" target="_blank" rel="noopener">${esc(site.author)} ↗</a></li>
          <li><a href="/making-of" >Build-history data</a></li>
        </ul>
      </div>
    </div>
    <div class="site-footer__colophon">
      <span>Set in Newsreader and IBM Plex Mono. No trackers, no analytics, no cookies.</span>
      <span>Built by prompting an agent, like everything else here.</span>
    </div>
  </div>`
}

export function mountHeader(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>('.menu-button')
  const panel = root.querySelector<HTMLElement>('#mobile-nav')
  if (!button || !panel) return

  const setOpen = (open: boolean): void => {
    button.setAttribute('aria-expanded', String(open))
    panel.dataset.open = String(open)
    document.body.dataset.navOpen = String(open)
  }

  button.addEventListener('click', () => setOpen(panel.dataset.open !== 'true'))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.dataset.open === 'true') {
      setOpen(false)
      button.focus()
    }
  })
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    if (panel.dataset.open === 'true' && target && !panel.contains(target) && !button.contains(target)) {
      setOpen(false)
    }
  })
  window.addEventListener('resize', () => {
    if (window.innerWidth > 780 && panel.dataset.open === 'true') setOpen(false)
  })
}

/* ------------------------------------------------------------------
   Cabinet frame
   ------------------------------------------------------------------ */

export interface Slide {
  src: string
  alt: string
  title: string
  caption: string
  meta?: string
}

export function frame(opts: {
  src: string
  alt: string
  title: string
  caption: string
  loading?: 'lazy' | 'eager'
  width?: number
  height?: number
  drift?: boolean
  aspect?: string
  className?: string
}): string {
  return `<figure class="frame ${opts.className ?? ''}">
    <div class="frame__inner"${opts.aspect ? ` style="aspect-ratio:${attr(opts.aspect)}"` : ''}>
      <img class="frame__img${opts.drift ? ' drift' : ''}" src="${attr(opts.src)}" alt="${attr(opts.alt)}"
        ${opts.width ? `width="${opts.width}"` : ''}${opts.height ? ` height="${opts.height}"` : ''}
        loading="${opts.loading ?? 'lazy'}" decoding="async" />
    </div>
    <figcaption class="frame__cap">
      <span class="frame__cap-mark" aria-hidden="true"></span>
      <span class="frame__cap-text"><strong>${esc(opts.title)}</strong> — ${esc(opts.caption)}</span>
    </figcaption>
  </figure>`
}

/** The signature move: a still that changes while you read. */
export function cabinet(opts: {
  slides: Slide[]
  id: string
  cycleMs?: number
  pager?: boolean
  wide?: boolean
}): string {
  const slides = opts.slides
    .map(
      (slide, index) =>
        `<img class="frame__img cabinet__slide${index === 0 ? ' is-active' : ''}" data-slide="${index}"
          src="${attr(slide.src)}" alt="${attr(slide.alt)}" loading="${index === 0 ? 'eager' : 'lazy'}"
          decoding="async" data-caption="${attr(slide.caption)}" data-title="${attr(slide.title)}" data-meta="${attr(slide.meta ?? '')}" />`,
    )
    .join('')

  const pager = opts.pager
    ? `<div class="cabinet__pager" role="group" aria-label="Choose a game">${opts.slides
        .map(
          (slide, index) =>
            `<button class="cabinet__dot" type="button" data-dot="${index}" aria-pressed="${index === 0}"
              aria-label="Show ${attr(slide.title)}"></button>`,
        )
        .join('')}</div>`
    : ''

  return `<div class="cabinet" data-cabinet="${attr(opts.id)}" data-cycle="${opts.cycleMs ?? 0}">
    <figure class="frame">
      <div class="frame__inner"${opts.wide ? '' : ''}>
        <div class="cabinet__stack">${slides}</div>
      </div>
      <figcaption class="frame__cap">
        <span class="frame__cap-mark" aria-hidden="true"></span>
        <span class="frame__cap-text"><strong data-cabinet-title>${esc(opts.slides[0]?.title ?? '')}</strong> — <span data-cabinet-caption>${esc(opts.slides[0]?.caption ?? '')}</span></span>
      </figcaption>
    </figure>
    <div class="cabinet__label">
      <span class="cabinet__title" data-cabinet-meta>${esc(opts.slides[0]?.meta ?? '')}</span>
      ${pager}
    </div>
  </div>`
}

/* ------------------------------------------------------------------
   Figures
   ------------------------------------------------------------------ */

export function fig(opts: {
  to: number
  format?: 'compact' | 'int' | 'hours'
  unit?: string
  caption: string
  accent?: boolean
  staticValue?: string
}): string {
  const value = opts.staticValue ?? '0'
  return `<div class="fig${opts.accent ? ' fig--accent' : ''}">
    <span class="fig__num count" data-to="${opts.to}" data-fmt="${opts.format ?? 'int'}">${esc(value)}</span>
    <span class="fig__cap">${esc(opts.caption)}${opts.unit ? ` <span class="mono">${esc(opts.unit)}</span>` : ''}</span>
  </div>`
}

export function staticFig(value: string, caption: string, accent = false): string {
  return `<div class="fig${accent ? ' fig--accent' : ''}">
    <span class="fig__num">${esc(value)}</span>
    <span class="fig__cap">${esc(caption)}</span>
  </div>`
}

export function ledger(items: Array<{ to?: number; value?: string; format?: 'compact' | 'int' | 'hours'; caption: string }>): string {
  return `<div class="ledger">${items
    .map(
      (item) => `<div class="ledger__item">
      ${item.to != null ? `<span class="fig__num count" data-to="${item.to}" data-fmt="${item.format ?? 'int'}">0</span>` : `<span class="fig__num">${esc(item.value ?? '')}</span>`}
      <span class="fig__cap">${esc(item.caption)}</span>
    </div>`,
    )
    .join('')}</div>`
}

/* ------------------------------------------------------------------
   Bars
   ------------------------------------------------------------------ */

export function bars(
  rows: Array<{ label: string; value: string; ratio: number; accent?: boolean }>,
): string {
  return `<div class="bars">${rows
    .map(
      (row) => `<div class="bar-row">
      <span class="bar-row__label">${esc(row.label)}</span>
      <span class="bar-row__track"><span class="bar-row__fill${row.accent ? ' bar-row__fill--accent' : ''}" style="${widthVar(row.ratio, 1)}"></span></span>
      <span class="bar-row__value">${esc(row.value)}</span>
    </div>`,
    )
    .join('')}</div>`
}

export function tokenStack(build: Build): string {
  const total = build.totalTokens || 1
  const seg = (value: number, cls: string): string =>
    `<span class="stack__seg stack__seg--${cls}" style="${widthVar(value, total)}"></span>`
  return `<div class="stack" role="img" aria-label="Token mix: ${count(build.outputTokens)} output, ${count(build.inputTokens)} input, ${count(build.cacheReadTokens)} cache read">
    ${seg(build.outputTokens, 'out')}${seg(build.inputTokens, 'in')}${seg(build.cacheReadTokens, 'cache')}
  </div>`
}

export function legend(items: Array<{ cls: string; label: string }>): string {
  return `<div class="legend">${items
    .map(
      (item) =>
        `<span class="legend__item"><span class="legend__swatch${item.cls ? ` legend__swatch--${item.cls}` : ''}" aria-hidden="true"></span>${esc(item.label)}</span>`,
    )
    .join('')}</div>`
}

/* ------------------------------------------------------------------
   Timeline: wall-clock spans + prompt marks
   ------------------------------------------------------------------ */

export function timelineChart(
  builds: Build[],
  span: { from: number; to: number },
  accentFor: (slug: string) => string,
): string {
  const width = span.to - span.from || 1
  const at = (iso: string | undefined): number =>
    iso ? Math.max(0, Math.min(100, ((new Date(iso).getTime() - span.from) / width) * 100)) : 0

  const lanes = builds
    .map((build) => {
      const start = at(build.raw.startedAt)
      const end = at(build.raw.endedAt)
      const prompts = build.prompts
        .map((prompt) => (prompt.at ? `<span class="tl-mark tl-mark--prompt" style="left:${at(prompt.at).toFixed(3)}%" title="Prompt: ${attr((prompt.textEn ?? prompt.text ?? '').slice(0, 90))}"></span>` : ''))
        .join('')
      return `<div class="tl-lane">
        <span class="tl-lane__label" style="border-left:3px solid ${attr(accentFor(build.slug))};padding-left:.6rem">${esc(build.title)}</span>
        <span class="tl-lane__track">
          <span class="tl-lane__span" style="left:${start.toFixed(3)}%;width:${Math.max(0.4, end - start).toFixed(3)}%"></span>
          ${prompts}
        </span>
      </div>`
    })
    .join('')

  const ticks = Array.from({ length: 5 }, (_, index) => {
    const t = new Date(span.from + (width / 4) * index)
    const label = `${day(t.toISOString())} ${month(t.toISOString())} ${time(t.toISOString())}`
    return `<span class="tl-axis__tick" style="left:${((index / 4) * 100).toFixed(3)}%">${esc(label)}</span>`
  }).join('')

  return `<div class="timeline">
    ${lanes}
    <div class="tl-axis"><span></span><span class="tl-axis__ticks">${ticks}</span></div>
  </div>
  <div class="timeline__legend">
    <span class="tl-key"><span class="tl-key__span" aria-hidden="true"></span>session window (wall clock)</span>
    <span class="tl-key"><span class="tl-key__mark" aria-hidden="true"></span>a human prompt</span>
  </div>`
}

/* ------------------------------------------------------------------
   Team roster + token share
   ------------------------------------------------------------------ */

export function rosterHead(hasTeams: boolean): string {
  return `<div class="roster__head"${hasTeams ? '' : ' hidden'}><span>agent</span><span>role</span><span>steps</span><span>tokens</span><span>minutes</span></div>`
}

export function rosterRow(subagent: SubagentRecord): string {
  const label = subagent.label ?? 'subagent'
  const name = label.split(' — ')[0] ?? label
  const role = label.includes(' — ') ? label.split(' — ').slice(1).join(' — ') : 'Specialist'
  return `<div class="roster__row">
    <span class="roster__name">${esc(name)}</span>
    <span class="roster__role">${esc(role)}</span>
    <span class="roster__stat">${count(subagent.steps ?? 0)}<span>steps</span></span>
    <span class="roster__stat">${esc(compact(subagent.tokens ?? 0))}<span>tokens</span></span>
    <span class="roster__stat">${Math.round((subagent.durationMs ?? 0) / 60_000)}<span>min</span></span>
  </div>`
}

export function shareBar(subagents: SubagentRecord[], accent: string, accent2: string): string {
  const total = subagents.reduce((sum, subagent) => sum + (subagent.tokens ?? 0), 0) || 1
  const shades = [accent, accent2, '#efe9df', '#9d9689', '#5f5a52', '#cdc6b9', '#6f6961', '#3a3733']
  const segments = subagents
    .map((subagent, index) => {
      const share = ((subagent.tokens ?? 0) / total) * 100
      const color = shades[index % shades.length] ?? accent
      return `<span class="share__seg" style="width:${share.toFixed(2)}%;background:${attr(color)}" title="${attr((subagent.label ?? '').split(' — ')[0] ?? '')} — ${esc(compact(subagent.tokens ?? 0))} tokens"></span>`
    })
    .join('')
  const keys = subagents
    .map((subagent, index) => {
      const share = Math.round(((subagent.tokens ?? 0) / total) * 100)
      const color = shades[index % shades.length] ?? accent
      const name = (subagent.label ?? 'agent').split(' — ')[0] ?? 'agent'
      return `<span class="share__key"><span class="share__dot" style="background:${attr(color)}" aria-hidden="true"></span>${esc(name)} ${share}%</span>`
    })
    .join('')
  return `<div class="share" role="img" aria-label="Share of subagent tokens">${segments}</div>
    <div class="share__legend">${keys}</div>`
}

/* ------------------------------------------------------------------
   Build timeline grouped by kind
   ------------------------------------------------------------------ */

const KIND_ORDER = ['plan', 'scaffold', 'implement', 'art', 'test', 'build', 'qa', 'commit', 'ship']

const KIND_LABEL: Record<string, string> = {
  plan: 'planned',
  scaffold: 'scaffolded',
  implement: 'built',
  art: 'designed',
  test: 'tested',
  build: 'compiled',
  qa: 'verified',
  commit: 'committed',
  ship: 'shipped',
}

function kindIcon(kind: string): string {
  const paths: Record<string, string> = {
    plan: '<path d="M3 4h10M3 7.5h10M3 11h6"/>',
    scaffold: '<path d="M3 3h10v10H3z"/><path d="M3 7h10M7 3v10"/>',
    implement: '<path d="M5.5 4 2.5 8l3 4M10.5 4l3 4-3 4"/>',
    art: '<path d="M8 2 2.5 13h11z"/>',
    test: '<path d="M2.5 8.5 6 12l5.5-7"/>',
    build: '<path d="M2.5 12h11M3.5 9.5h9M4.5 7h7"/>',
    qa: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.6"/>',
    commit: '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v4M8 10.5v4"/>',
    ship: '<path d="M2 11 11 2M11 2H6M11 2v5"/>',
  }
  return `<svg class="tl-group__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square" aria-hidden="true">${paths[kind] ?? paths.implement}</svg>`
}

export function milestoneGroups(milestones: Build['milestones']): string {
  const groups = new Map<string, Build['milestones']>()
  for (const milestone of milestones) {
    const kind = milestone.kind ?? 'implement'
    const list = groups.get(kind) ?? []
    list.push(milestone)
    groups.set(kind, list)
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]),
  )
  return `<div class="tl-groups">${ordered
    .map(
      ([kind, items]) => `<div class="tl-group">
      <div class="tl-group__head">
        ${kindIcon(kind)}
        <span class="tl-group__kind">${esc(KIND_LABEL[kind] ?? kind)}</span>
        <span class="tl-group__count">${items.length}</span>
      </div>
      <div class="tl-items">
        ${items
          .map(
            (item) => `<div class="tl-item${kind === 'commit' ? ' tl-item--commit' : ''}">
            <time datetime="${attr(item.at ?? '')}">${esc(time(item.at))}</time>
            <p>${esc(item.label ?? '')}</p>
          </div>`,
          )
          .join('')}
      </div>
    </div>`,
    )
    .join('')}</div>`
}

/* ------------------------------------------------------------------
   Prompt
   ------------------------------------------------------------------ */

export function promptBlock(opts: {
  index: number
  at: string | undefined
  text: string
  chars: number
  translated: boolean
  lang: string
}): string {
  const long = opts.text.length > 620
  return `<article class="prompt">
    <div class="prompt__meta">
      <time datetime="${attr(opts.at ?? '')}">${esc(dateTime(opts.at))}</time>
      <span class="prompt__tag">${count(opts.chars)} characters</span>
      <span class="prompt__tag">${opts.translated ? `translated from ${esc(opts.lang.toUpperCase())}` : 'written in English'}</span>
    </div>
    <div class="prompt__text${long ? ' is-clamped' : ''}" data-prompt-body>${esc(opts.text)}</div>
    ${long ? `<button class="prompt__toggle" type="button" data-prompt-toggle aria-expanded="false">Read the full prompt</button>` : ''}
  </article>`
}

/* ------------------------------------------------------------------
   Quotes
   ------------------------------------------------------------------ */

export function quoteBlock(opts: { at?: string; text: string; label?: string }): string {
  return `<blockquote class="quote">
    <p class="quote__text">${esc(opts.text)}</p>
    <footer class="quote__meta">
      <span>${esc(opts.label ?? 'agent reasoning')}</span>
      ${opts.at ? `<time datetime="${attr(opts.at)}">${esc(dateTime(opts.at))}</time>` : ''}
    </footer>
  </blockquote>`
}

/* ------------------------------------------------------------------
   Section head
   ------------------------------------------------------------------ */

export function sectionHead(title: string, note?: string): string {
  return `<div class="story-section__head">
    <h2 class="story-section__title">${esc(title)}</h2>
    ${note ? `<span class="story-section__note">${esc(note)}</span>` : ''}
  </div>`
}

export function playButton(url: string, label = 'Play the game'): string {
  if (url) {
    return `<a class="btn btn--accent" href="${attr(url)}" target="_blank" rel="noopener">${esc(label)}<span class="btn__arrow" aria-hidden="true">↗</span></a>`
  }
  return `<span class="btn btn--pending" aria-disabled="true">Deploy pending</span>`
}

export function hoursCaption(build: Build): string {
  return `${hours(build.activeMs)} h of agent work · ${duration(build.wallMs)} wall clock`
}
