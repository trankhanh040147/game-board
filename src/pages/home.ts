import { attr, esc } from '../lib/dom'
import { compact, count, dateTime, hours, duration } from '../lib/format'
import {
  aggregate,
  builds,
  buildBySlug,
  generatedAt,
  MODEL_LABEL,
  promptEn,
  allPrompts,
} from '../data/telemetry'
import { gameBySlug, site } from '../data/registry'
import { deployUrl } from '../data/deploy'
import {
  bars,
  cabinet,
  frame,
  ledger,
  playButton,
  quoteBlock,
  type Slide,
} from '../components/ui'

export interface PageView {
  title: string
  description: string
  gameSlug?: string
  html: string
  mount?: (root: HTMLElement) => void
}

function accentStyle(slug: string): string {
  const game = gameBySlug(slug)
  if (!game) return ''
  const accentInk = slug === 'blade-and-mount' ? '#efe9df' : '#0b0b0c'
  return ` style="--accent:${attr(game.accent)};--accent-ink:${accentInk};--accent-deep:${attr(game.accent2)}"`
}

const PLAY: Record<string, string | undefined> = {
  'first-hearth': deployUrl('first-hearth') || gameBySlug('first-hearth')?.playUrl,
  'blade-and-mount': deployUrl('blade-and-mount') || gameBySlug('blade-and-mount')?.playUrl,
  'alien-shooter': deployUrl('alien-shooter') || gameBySlug('alien-shooter')?.playUrl,
}

function heroSlides(): Slide[] {
  return builds.map((build) => ({
    src: build.media.hero,
    alt: build.media.heroAlt,
    title: build.title,
    caption: build.oneLiner,
    meta: `${build.genre} · ${build.prompts.length} ${build.prompts.length === 1 ? 'prompt' : 'prompts'} · ${hours(build.activeMs)} agent-hours`,
  }))
}

function hero(): string {
  return `<section class="wrap hero" aria-labelledby="hero-title">
    <div class="hero__text">
      <h1 class="hero__title" id="hero-title">Three games.<br />No hands.</h1>
      <p class="hero__lede reveal">
        A person typed <strong>${count(aggregate.prompts)} prompts</strong>. An AI agent typed everything else:
        every system, every sprite, every line of CSS. Play the games, then read the receipts.
      </p>
      <div class="actions reveal">
        <a class="btn" href="#shelf">Play the games</a>
        <a class="link-arrow" href="/making-of">Open the receipts <span class="link-arrow__arrow" aria-hidden="true">→</span></a>
      </div>
      <p class="hero__quick reveal">
        <span><b>${esc(MODEL_LABEL)}</b> · ${count(aggregate.subagentSessions)} specialist agents</span>
        <span>Every figure below is summed from session logs — not an estimate.</span>
      </p>
    </div>
    <div class="hero__cabinet reveal">
      ${cabinet({ slides: heroSlides(), id: 'hero', cycleMs: 6200, pager: true })}
    </div>
  </section>`
}

function ledgerSection(): string {
  return `<section class="wrap section section--tight" aria-labelledby="ledger-title">
    <div class="story-section__head">
      <h2 class="story-section__title" id="ledger-title">What it took</h2>
      <span class="story-section__note">all three builds, subagents included</span>
    </div>
    <div class="reveal">
      ${ledger([
        { to: aggregate.prompts, format: 'int', caption: 'prompts typed by a human' },
        { to: aggregate.agentTurns, format: 'int', caption: 'agent turns, lead and subagents' },
        { to: aggregate.activeMs, format: 'hours', caption: 'agent-hours of work' },
        { to: aggregate.totalTokens, format: 'compact', caption: 'tokens processed' },
        { to: aggregate.toolCalls, format: 'int', caption: 'tool calls' },
        { to: aggregate.filesCreated, format: 'int', caption: 'files written (a floor)' },
      ])}
    </div>
    <p class="prose" style="margin-top:1.75rem">
      <span class="meta">Note&nbsp;&nbsp;</span>
      Of those ${esc(compact(aggregate.totalTokens))} tokens, ${esc(compact(aggregate.cacheReadTokens))} are
      cache reads — context the model re-used rather than wrote. Fresh output is
      ${esc(compact(aggregate.outputTokens))} tokens. Agent-hours sum parallel subagents; wall-clock time is longer
      because the sessions sat idle overnight. <a href="/making-of">The receipts page</a> breaks all three clocks apart.
    </p>
  </section>`
}

function shelfSection(): string {
  return `<section class="wrap section" id="shelf" aria-labelledby="shelf-title">
    <div class="story-section__head">
      <h2 class="story-section__title" id="shelf-title">The shelf</h2>
      <span class="story-section__note">three genres, three very different ways of getting there</span>
    </div>
    <div class="shelf">
      ${builds.map((build, index) => gameRow(build.slug, index)).join('')}
    </div>
  </section>`
}

function gameRow(slug: string, index: number): string {
  const build = buildBySlug(slug)
  if (!build) return ''
  const play = PLAY[slug]
  const flip = index % 2 === 1
  return `<article class="game-row${flip ? ' game-row--flip' : ''}"${accentStyle(slug)} aria-labelledby="game-${attr(slug)}">
    <div class="game-row__media reveal">
      ${frame({
        src: build.media.hero,
        alt: build.media.heroAlt,
        title: build.title,
        caption: `${build.genre} · ${count(build.filesCreated)} files · ${count(build.prompts.length)} ${build.prompts.length === 1 ? 'prompt' : 'prompts'}`,
        loading: 'lazy',
      })}
    </div>
    <div class="game-row__body">
      <div class="game-row__spine reveal" aria-hidden="true"></div>
      <h3 class="game-row__title reveal" id="game-${attr(slug)}">${esc(build.title)}</h3>
      <p class="game-row__meta reveal">
        <span>${esc(build.genre)}</span><span class="sep">/</span>
        <span>${build.tech.map((tech) => esc(tech)).join(' · ')}</span>
      </p>
      <p class="game-row__line reveal">${esc(build.oneLiner)}</p>
      <ul class="game-row__highlights reveal">
        ${build.highlights.slice(0, 3).map((highlight) => `<li>${esc(highlight)}</li>`).join('')}
      </ul>
      <div class="game-row__specs reveal">
        <div><span class="spec__num">${count(build.prompts.length)}</span><span class="spec__cap">prompts</span></div>
        <div><span class="spec__num">${esc(hours(build.activeMs))} h</span><span class="spec__cap">agent work</span></div>
        <div><span class="spec__num">${esc(compact(build.totalTokens))}</span><span class="spec__cap">tokens</span></div>
        <div><span class="spec__num">${count(build.agentTurns)}</span><span class="spec__cap">agent turns</span></div>
      </div>
      <div class="actions reveal">
        ${playButton(play ?? '', 'Play ' + build.title)}
        <a class="link-arrow" href="/making-of/${attr(build.slug)}">How it was made <span class="link-arrow__arrow" aria-hidden="true">→</span></a>
      </div>
    </div>
  </article>`
}

function engineSection(): string {
  const blade = buildBySlug('blade-and-mount')
  const humanQuote = blade?.prompts[1] ? promptEn(blade.prompts[1]) : ''
  const topTools = aggregate.tools.slice(0, 9)
  const maxTool = topTools[0]?.count ?? 1

  return `<section class="wrap section" aria-labelledby="engine-title">
    <div class="engine">
      <div class="engine__intro">
        <h2 class="story-section__title" id="engine-title">The engine room</h2>
        <div class="prose reveal">
          <p>
            Nobody opened an editor. DeepSeek Harness is an agent runtime: it hands a model tools — a
            shell, a file system, a real browser, a shared task board — and the model works the way a
            small studio would.
          </p>
          <p>
            For the two larger games a lead agent split the work and spawned specialists: an arena
            artist, a character artist, a combat AI, a UI and audio engineer, a QA tester. They wrote to
            the same repository at the same time, and the lead merged, built and fixed.
          </p>
          <p>
            The part that decides quality is not the writing. It is the looking: open the game in a real
            browser, take a screenshot, read it, decide what is wrong, repair it. Across these three
            builds that loop ran ${count(aggregate.toolCalls)} times, and
            ${count(aggregate.tools.find((tool) => tool.name === 'read_image')?.count ?? 0)} of those calls
            were the agent looking at its own screenshots.
          </p>
        </div>
      </div>
      <div class="engine__viz">
        <div class="loop reveal">
          ${([
            ['the prompt', 'One paragraph, usually in Vietnamese. Scope, reference, taste.'],
            ['the plan', 'A design doc, then a task board: what exists, who writes what.'],
            ['the team', 'Specialist subagents spawn in parallel, each with one directory.'],
            ['the build', 'Files, tests, builds. The lead fixes what the specialists leave broken.'],
            ['the proof', 'A headless browser plays the game and screenshots it.'],
            ['the repair', 'The agent reads its own screenshot, decides it is not good enough, goes again.'],
          ] as Array<[string, string]>)
            .map(
              ([kind, body]) => `<div class="loop__step">
                <span class="loop__kind">${esc(kind)}</span>
                <span class="loop__title">${esc(body.split('.')[0] ?? body)}</span>
                <p class="loop__body">${esc(body.split('.').slice(1).join('.').trim())}</p>
              </div>`,
            )
            .join('')}
        </div>
        <div class="chart reveal">
          <div class="chart__cap">
            <span class="chart__title">What the agents actually did</span>
            <span class="chart__note">${count(aggregate.toolCalls)} tool calls, all three builds</span>
          </div>
          ${bars(
            topTools.map((tool) => ({
              label: tool.name,
              value: count(tool.count),
              ratio: tool.count / maxTool,
              accent: tool.name === 'read_image' || tool.name === 'bash',
            })),
          )}
        </div>
        ${
          humanQuote
            ? `<div class="engine__pull reveal">
          ${quoteBlock({ text: humanQuote, label: 'the human, second prompt on Blade & Mount', at: undefined })}
        </div>`
            : ''
        }
      </div>
    </div>
    <div class="actions reveal" style="margin-top:clamp(2.5rem,4vw,3.5rem)">
      <a class="btn btn--ghost" href="/making-of">See every prompt, token and fix <span class="btn__arrow" aria-hidden="true">→</span></a>
    </div>
  </section>`
}

function honestClose(): string {
  const latest = allPrompts[allPrompts.length - 1]
  return `<section class="wrap section section--tight" aria-labelledby="close-title">
    <div class="split-2">
      <div class="reveal">
        <h2 class="story-section__title" id="close-title">Why publish the receipts</h2>
      </div>
      <div class="prose reveal">
        <p>
          Because the interesting part of vibe coding is not the output. It is the cost, the dead ends and
          the loop. ${count(aggregate.prompts)} human prompts produced ${count(aggregate.filesCreated)}+ files and
          three playable games — but also ${esc(compact(aggregate.cacheReadTokens))} tokens of re-read context,
          ${count(aggregate.toolCalls)} tool calls and hours of the agent disagreeing with itself.
        </p>
        <p>
          Every prompt on this site is the human's actual words, translated where they were typed in
          Vietnamese${latest ? `; the last one was “${esc((promptEn(latest)).slice(0, 48))}”` : ''}. The
          reasoning excerpts are the agent's own, unedited. The numbers are sums over session logs, and the
          caveats are on <a href="/about">the about page</a>.
        </p>
        <p class="meta" style="margin-top:1.5rem">
          Telemetry generated ${esc(dateTime(generatedAt))} (UTC+7) · ${count(aggregate.prompts)} prompts ·
          ${esc(duration(aggregate.wallMs))} of wall clock across three build windows
        </p>
      </div>
    </div>
  </section>`
}

export function view(): PageView {
  return {
    title: 'Game Board — three browser games, zero hand-written lines',
    description: site.tagline,
    html: `${hero()}${ledgerSection()}${shelfSection()}${engineSection()}${honestClose()}`,
  }
}
