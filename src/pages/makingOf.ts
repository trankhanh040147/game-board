import { attr, esc, qs, qsa } from '../lib/dom'
import { compact, count, duration, hours, time } from '../lib/format'
import { aggregate, builds, MODEL_LABEL, spanOfPrompts } from '../data/telemetry'
import { gameBySlug } from '../data/registry'
import { legend, timelineChart, tokenStack } from '../components/ui'
import type { PageView } from './home'

const MEASURES: Array<{
  id: string
  label: string
  value: (build: (typeof builds)[number]) => number
  format: (build: (typeof builds)[number]) => string
}> = [
  { id: 'active', label: 'Agent-hours', value: (b) => b.activeMs, format: (b) => `${hours(b.activeMs)} h` },
  { id: 'wall', label: 'Wall clock', value: (b) => b.wallMs, format: (b) => duration(b.wallMs) },
  { id: 'prompts', label: 'Prompts', value: (b) => b.prompts.length, format: (b) => count(b.prompts.length) },
  { id: 'turns', label: 'Agent turns', value: (b) => b.agentTurns, format: (b) => count(b.agentTurns) },
  { id: 'tokens', label: 'Tokens', value: (b) => b.totalTokens, format: (b) => compact(b.totalTokens) },
  { id: 'tools', label: 'Tool calls', value: (b) => b.toolCalls, format: (b) => count(b.toolCalls) },
  { id: 'files', label: 'Files', value: (b) => b.filesCreated, format: (b) => count(b.filesCreated) },
]

const DEFAULT_MEASURE = MEASURES[0]!
const state = { measure: DEFAULT_MEASURE.id }

function accentOf(slug: string): string {
  return gameBySlug(slug)?.accent ?? '#efe9df'
}

function accentStyle(slug: string): string {
  const game = gameBySlug(slug)
  if (!game) return ''
  const accentInk = slug === 'blade-and-mount' ? '#efe9df' : '#0b0b0c'
  return ` style="--accent:${attr(game.accent)};--accent-ink:${accentInk};--accent-deep:${attr(game.accent2)}"`
}

function rankingRows(measureId: string): string {
  const measure = MEASURES.find((item) => item.id === measureId) ?? DEFAULT_MEASURE
  const ranked = [...builds].sort((a, b) => measure.value(b) - measure.value(a))
  const max = Math.max(...ranked.map((build) => measure.value(build)), 1)
  return ranked
    .map(
      (build) => `<a class="build-row" href="/making-of/${attr(build.slug)}"${accentStyle(build.slug)}>
        <span class="build-row__name">
          <span class="build-row__accent" aria-hidden="true"></span>
          <span>
            <strong>${esc(build.title)}</strong>
            <span class="build-row__genre">${esc(build.genre)}</span>
          </span>
        </span>
        <span class="build-row__bars">
          <span class="build-row__bar">
            <span class="build-row__track"><span class="build-row__fill build-row__fill--primary" style="--w:${((measure.value(build) / max) * 100).toFixed(2)}%"></span></span>
            <span class="build-row__val">${esc(measure.format(build))}</span>
          </span>
        </span>
        <span class="build-row__meta">
          ${count(build.prompts.length)} ${build.prompts.length === 1 ? 'prompt' : 'prompts'} · ${count(build.agentTurns)} turns<br />
          ${esc(compact(build.totalTokens))} tokens · ${count(build.filesCreated)} files
        </span>
      </a>`,
    )
    .join('')
}

function toggle(): string {
  return `<div class="toggle" role="group" aria-label="Rank the builds by">
    ${MEASURES.map(
      (measure) =>
        `<button class="toggle__btn" type="button" data-measure="${measure.id}" aria-pressed="${measure.id === state.measure}">${esc(measure.label)}</button>`,
    ).join('')}
  </div>`
}

function clocksChart(): string {
  const maxWall = Math.max(...builds.map((build) => build.wallMs), 1)
  return `<div class="clocks">
    ${builds
      .map(
        (build) => `<div class="clock-row"${accentStyle(build.slug)}>
          <div class="clock-row__name">
            <span class="clock-row__title">${esc(build.title)}</span>
            <span class="clock-row__detail">${count(build.prompts.length)} ${build.prompts.length === 1 ? 'prompt' : 'prompts'} · ${count(build.leadSteps)} lead turns · ${count(build.subagentSteps)} subagent turns</span>
          </div>
          <div class="clock-row__tracks">
            <div class="clock-row__track"><span class="clock-row__fill clock-row__fill--wall" style="--w:${((build.wallMs / maxWall) * 100).toFixed(2)}%"></span></div>
            <div class="clock-row__track"><span class="clock-row__fill clock-row__fill--active" style="--w:${((build.activeMs / maxWall) * 100).toFixed(2)}%"></span></div>
          </div>
          <div class="clock-row__values">
            <span>${esc(duration(build.wallMs))} <em>wall clock</em></span>
            <span>${esc(hours(build.activeMs))} h <em>agent work</em></span>
          </div>
        </div>`,
      )
      .join('')}
    <div class="timeline__legend">
      <span class="tl-key"><span class="tl-key__span" aria-hidden="true"></span>wall-clock window, idle hours included</span>
      <span class="tl-key"><span class="tl-key__active" aria-hidden="true"></span>agent-hours, parallel subagents summed</span>
    </div>
  </div>`
}

function tokenChart(): string {
  return `<div class="token-mix">
    ${builds
      .map(
        (build) => `<div class="token-mix__row"${accentStyle(build.slug)}>
          <div class="token-mix__head">
            <span class="token-mix__name">${esc(build.title)}</span>
            <span class="token-mix__total">${esc(compact(build.totalTokens))}</span>
          </div>
          ${tokenStack(build)}
          <div class="token-mix__nums">
            <span><b>${esc(compact(build.outputTokens))}</b> output</span>
            <span><b>${esc(compact(build.inputTokens))}</b> input</span>
            <span><b>${esc(compact(build.cacheReadTokens))}</b> cache read</span>
          </div>
        </div>`,
      )
      .join('')}
    <div style="margin-top:1.25rem">
      ${legend([
        { cls: 'out', label: 'fresh output — what the model wrote' },
        { cls: 'in', label: 'input — what it read' },
        { cls: 'cache', label: 'cache read — context re-used, not re-derived' },
      ])}
    </div>
  </div>`
}

interface Column {
  key: string
  label: string
  value: (build: (typeof builds)[number]) => number | string
  numeric: boolean
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'build', value: (b) => b.title, numeric: false },
  { key: 'prompts', label: 'prompts', value: (b) => b.prompts.length, numeric: true },
  { key: 'lead', label: 'lead turns', value: (b) => b.leadSteps, numeric: true },
  { key: 'sub', label: 'subagent turns', value: (b) => b.subagentSteps, numeric: true },
  { key: 'agents', label: 'subagents', value: (b) => b.subagentSessions, numeric: true },
  { key: 'wall', label: 'wall clock', value: (b) => b.wallMs, numeric: true },
  { key: 'active', label: 'agent-hours', value: (b) => b.activeMs, numeric: true },
  { key: 'tokens', label: 'tokens', value: (b) => b.totalTokens, numeric: true },
  { key: 'out', label: 'output', value: (b) => b.outputTokens, numeric: true },
  { key: 'cache', label: 'cache read', value: (b) => b.cacheReadTokens, numeric: true },
  { key: 'tools', label: 'tool calls', value: (b) => b.toolCalls, numeric: true },
  { key: 'files', label: 'files', value: (b) => b.filesCreated, numeric: true },
]

const tableState = { key: 'active', dir: 'desc' as 'asc' | 'desc' }

function cell(column: Column, build: (typeof builds)[number]): string {
  if (column.key === 'name') {
    return `<a href="/making-of/${attr(build.slug)}">${esc(build.title)}</a>`
  }
  const value = column.value(build)
  if (column.key === 'wall' || column.key === 'active') {
    return column.key === 'active' ? `${esc(hours(build.activeMs))} h` : esc(duration(build.wallMs))
  }
  if (column.key === 'tokens' || column.key === 'out' || column.key === 'cache') {
    return esc(compact(Number(value)))
  }
  return count(Number(value))
}

function tableHead(): string {
  return `<tr>${COLUMNS.map((column) => {
    const sorted = tableState.key === column.key
    return `<th scope="col"${sorted ? ` aria-sort="${tableState.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
      <button class="th-btn" type="button" data-sort="${column.key}">${esc(column.label)}</button>
    </th>`
  }).join('')}</tr>`
}

function tableBody(): string {
  const column = COLUMNS.find((item) => item.key === tableState.key)
  const sorted = [...builds].sort((a, b) => {
    if (!column) return 0
    const av = column.value(a)
    const bv = column.value(b)
    const result = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return tableState.dir === 'asc' ? result : -result
  })
  return sorted
    .map(
      (build) => `<tr>${COLUMNS.map((col) => {
        if (col.key === 'name') {
          return `<td class="name">${cell(col, build)}<span class="mobile-only"> · ${esc(build.genre)}</span></td>`
        }
        return `<td class="${col.key === 'prompts' ? 'num' : 'dim'}">${cell(col, build)}</td>`
      }).join('')}</tr>`,
    )
    .join('')
}

export function view(): PageView {
  const span = spanOfPrompts()
  const prosePosition = `<style>@media (max-width: 720px){.mobile-only{display:block;font-size:11px;color:var(--ink-4)}}</style>`
  return {
    title: 'The receipts — Game Board',
    description:
      'Every prompt, token, agent turn and tool call behind three browser games built by an AI agent: the comparison table, the two clocks and the token mix.',
    html: `${prosePosition}
    <section class="wrap page-head" aria-labelledby="receipts-title">
      <div class="page-head__title">
        <h1 id="receipts-title">The receipts.</h1>
        <p class="page-head__lede">
          Three builds measured from their own session logs. Same person, same model,
          three very different ways to spend a night.
        </p>
      </div>
      <div class="page-head__side">
        <p class="page-head__note">
          ${count(aggregate.prompts)} human prompts · ${count(aggregate.agentTurns)} agent turns ·
          ${esc(compact(aggregate.totalTokens))} tokens · ${esc(hours(aggregate.activeMs))} agent-hours<br />
          Model ${esc(MODEL_LABEL)} · ${count(aggregate.subagentSessions)} subagent sessions ·
          ${esc(hours(aggregate.wallMs))} h wall clock
        </p>
      </div>
    </section>

    <section class="wrap section section--tight" aria-labelledby="rank-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="rank-title">Rank the builds</h2>
        <span class="story-section__note">one control, seven measures</span>
      </div>
      <div class="reveal">${toggle()}</div>
      <div class="builds reveal" id="build-ranking" aria-live="polite">${rankingRows(state.measure)}</div>
      <p class="prose" style="margin-top:1.5rem">
        <span class="meta">Read&nbsp;&nbsp;</span>
        Changing the measure changes the winner. Blade &amp; Mount is the biggest build by every measure;
        Alien Shooter wins on efficiency — one prompt, one agent, 39 minutes of work, and the game was
        playable before the session ended.
      </p>
    </section>

    <section class="wrap section" aria-labelledby="clocks-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="clocks-title">Two clocks</h2>
        <span class="story-section__note">wall clock ≠ work done</span>
      </div>
      <div class="reveal">
        <div class="chart__cap">
          <span class="chart__title">Hours per build</span>
          <span class="chart__note">First Hearth's turn ended at 00:11; the next prompt arrived at 07:59.</span>
        </div>
        ${clocksChart()}
      </div>
      <p class="prose" style="margin-top:1.75rem">
        Wall clock is the window from first prompt to last turn, and it includes the hours the human spent
        asleep. Agent-hours add up what the agent actually did, parallel subagents included — so the
        subagent time can exceed the window it sits in. Both are reported because neither is the truth on
        its own.
      </p>
    </section>

    <section class="wrap section" aria-labelledby="tokens-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="tokens-title">Where the tokens went</h2>
        <span class="story-section__note">${esc(compact(aggregate.totalTokens))} tokens, ${esc(compact(aggregate.cacheReadTokens))} of them re-used context</span>
      </div>
      <div class="reveal">
        <div class="chart__cap">
          <span class="chart__title">Token mix per build</span>
          <span class="chart__note">bars drawn to the same ${esc(compact(aggregate.totalTokens))} scale</span>
        </div>
        ${tokenChart()}
      </div>
      <p class="prose" style="margin-top:1.75rem">
        Cache reads dominate every build, which is what a long agent session looks like: the same long
        context re-sent thousands of times. The number that means "the model wrote this" is the output
        figure — ${esc(compact(aggregate.outputTokens))} tokens across three games, or about
        ${count(Math.round(aggregate.outputTokens / aggregate.prompts))} tokens of new code per human prompt.
      </p>
    </section>

    <section class="wrap section" aria-labelledby="when-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="when-title">When the work happened</h2>
        <span class="story-section__note">${count(aggregate.prompts)} prompts across 31 Oct – 1 Nov, UTC+7</span>
      </div>
      <div class="reveal">
        ${timelineChart(builds, span, accentOf)}
      </div>
      <p class="prose" style="margin-top:1.75rem">
        The gaps are the story. Three sessions ran in parallel from ~22:50 on 31 October; the human went to
        bed, the agents kept working, and the next prompt landed the following morning. The last spike is
        the ${time('2026-11-01T14:16:07.909+07:00')} “stop the server” and the workspace move.
      </p>
    </section>

    <section class="wrap section" aria-labelledby="table-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="table-title">The ledger</h2>
        <span class="story-section__note">click a column to sort</span>
      </div>
      <div class="table-wrap reveal">
        <table>
          <caption>Every build, every number. Wall clock and agent-hours are both shown; tokens include cache reads.</caption>
          <thead data-table-head>${tableHead()}</thead>
          <tbody data-table-body>${tableBody()}</tbody>
        </table>
      </div>
    </section>

    <section class="wrap section" aria-labelledby="exhibits-title">
      <div class="story-section__head">
        <h2 class="story-section__title" id="exhibits-title">The exhibits</h2>
        <span class="story-section__note">each one opens with its prompts</span>
      </div>
      <div class="tickets">
        ${builds
          .map(
            (build) => `<a class="ticket reveal" href="/making-of/${attr(build.slug)}"${accentStyle(build.slug)}>
              <span>
                <span class="ticket__title">${esc(build.title)}</span>
                <span class="build-row__genre">${esc(build.subtitle)}</span>
              </span>
              <span class="ticket__stats">
                <span>${count(build.prompts.length)} ${build.prompts.length === 1 ? 'prompt' : 'prompts'} · ${count(build.agentTurns)} turns</span>
                <span>${esc(compact(build.totalTokens))} tokens · ${count(build.filesCreated)} files</span>
                <span>${esc(hours(build.activeMs))} h of agent work</span>
              </span>
              <span class="ticket__cta">Open the exhibit →</span>
            </a>`,
          )
          .join('')}
      </div>
    </section>`,
    mount(root: HTMLElement) {
      mountControls(root)
    },
  }
}

function mountControls(root: HTMLElement): void {
  const ranking = qs<HTMLElement>(root, '#build-ranking')
  const buttons = qsa<HTMLButtonElement>(root, '[data-measure]')
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.measure
      if (!id) return
      state.measure = id
      buttons.forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.measure === id)))
      if (ranking) ranking.innerHTML = rankingRows(id)
      initRowBars(ranking)
    })
  })

  const thead = qs<HTMLElement>(root, '[data-table-head]')
  const tbody = qs<HTMLElement>(root, '[data-table-body]')
  const sort = (key: string): void => {
    if (tableState.key === key) tableState.dir = tableState.dir === 'asc' ? 'desc' : 'asc'
    else {
      tableState.key = key
      tableState.dir = key === 'name' ? 'asc' : 'desc'
    }
    if (thead) thead.innerHTML = tableHead()
    if (tbody) tbody.innerHTML = tableBody()
    bindSortButtons(root)
  }
  bindSortButtons(root)
  function bindSortButtons(scope: HTMLElement): void {
    qsa<HTMLButtonElement>(scope, '[data-sort]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.sort
        if (key) sort(key)
      })
    })
  }
  initRowBars(ranking)
}

/** Bars animate from zero on first paint; keep the transition honest on re-render. */
function initRowBars(scope: HTMLElement | null): void {
  if (!scope) return
  qsa<HTMLElement>(scope, '.build-row__fill').forEach((fill) => {
    const target = fill.style.getPropertyValue('--w')
    fill.style.setProperty('--w', '0%')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fill.style.setProperty('--w', target))
    })
  })
}
