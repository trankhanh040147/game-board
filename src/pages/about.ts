import { attr, esc } from '../lib/dom'
import { compact, count, dateTime, duration, hours } from '../lib/format'
import { aggregate, generatedAt, MODEL_LABEL, summary } from '../data/telemetry'
import { games, site } from '../data/registry'
import type { PageView } from './home'

const CAVEATS: Array<{ label: string; body: string }> = [
  {
    label: 'wall clock',
    body: 'A build window runs from the first prompt to the last turn and includes the hours the human spent asleep. The three windows total 37.5 hours, and because they overlapped, about 22.3 hours of calendar time passed between the first prompt and the last turn. None of that is hours of work.',
  },
  {
    label: 'agent-hours',
    body: 'Agent hours are the sum of turn durations, with parallel subagents added together — so three specialists working at once count three times. It measures effort spent, not elapsed time, and it includes tool wait.',
  },
  {
    label: 'session span',
    body: 'Each build family also has a span that runs to the final bookkeeping pass on 1 November, where the sessions were renamed and one game was moved into this repository. That span is not build time either.',
  },
  {
    label: 'tokens',
    body: 'Token totals are what the provider reported and should be read as floors. Cache reads dominate them; they are context the model re-used, not text it produced. The honest "written" figure is output tokens.',
  },
  {
    label: 'files',
    body: 'File counts come from write tool calls, so they are a floor. Edits, generated builds and files written by shell commands are not counted.',
  },
  {
    label: 'prompts and steps',
    body: 'Only human messages are counted as prompts. Agent-to-agent messages, subagent briefs and harness plumbing are excluded, so a build with one prompt is not a build with one instruction. A step is one assistant message — a tool call, a decision or a reply.',
  },
  {
    label: 'translation',
    body: 'Prompts typed in Vietnamese are shown in English, translated into English for publication. The extractor stores one fixed English rendering per prompt; the verbatim Vietnamese originals remain in the data. Pasted media URLs were removed from the display because they are unreadable, not to change the wording.',
  },
  {
    label: 'screenshots',
    body: 'Every screenshot on this site was captured from the games as they run today, then cropped and compressed. Nothing was re-staged. The first build of Alien Shooter had a Vietnamese interface; it was localised to English afterwards and its screenshots were re-captured from the English build.',
  },
  {
    label: 'not cherry-picked',
    body: 'Every prompt in each build appears on its exhibit page, including the ones that are not about the game — "stop the server" and "move this conversation into the game-board workspace" are part of the record.',
  },
]

export function view(): PageView {
  return {
    title: 'About the board — Game Board',
    description:
      'What this board is, what "vibe coding" means here, how the agent harness worked, and the caveats behind every number on the site.',
    html: `<section class="wrap page-head" aria-labelledby="about-title">
      <div class="page-head__title">
        <h1 id="about-title">About the board.</h1>
        <p class="page-head__lede">
          Three browser games, made by one person typing into an agent runtime. This is the method,
          the numbers, and the caveats — including the ones that make the numbers less impressive.
        </p>
      </div>
      <div class="page-head__side">
        <p class="page-head__note">
          ${count(aggregate.games)} games · ${count(aggregate.prompts)} human prompts ·
          ${count(aggregate.totalSteps)} agent steps · ${esc(hours(aggregate.activeMs))} agent-hours<br />
          ${esc(compact(aggregate.totalTokens))} tokens · ${count(aggregate.toolCalls)} tool calls ·
          ${count(aggregate.filesCreated)} files
        </p>
      </div>
    </section>

    <div class="wrap">
      <figure class="about-banner reveal">
        <img src="/media/blade-and-mount/hero.webp" alt="The tournament board of Blade &amp; Mount: four houses advancing to the lists" width="1600" height="900" loading="lazy" decoding="async" />
        <figcaption>Blade &amp; Mount, one of three builds on this board — the tournament board the agent built for round one.</figcaption>
      </figure>
    </div>

    <div class="wrap about-grid">
      <nav class="about-index" aria-label="On this page">
        <a href="#what">What this is</a>
        <a href="#vibe">What vibe coding means here</a>
        <a href="#harness">The harness</a>
        <a href="#numbers">What the numbers are</a>
        <a href="#credits">Credits</a>
      </nav>
      <div class="about-body">
        <h2 id="what">What this is</h2>
        <div class="prose">
          <p>
            Game Board is a shelf and a receipt. The shelf holds three games that run in a browser tab:
            a civilization simulation, a 3D tournament fighter, a top-down arena shooter. The receipt is
            everything else on this site — the prompts that started them, the tokens they burned, the
            agents that built them, the screenshots that caught what was wrong.
          </p>
          <p>
            The games live in <a href="${attr(site.repoUrl)}" target="_blank" rel="noopener">the repository</a>
            under <span class="mono">games/</span>. This site is at its root, and its build-history data is
            extracted from the same session logs the agent wrote while working.
          </p>
        </div>

        <h2 id="vibe">What vibe coding means here</h2>
        <div class="prose">
          <p>
            Not autocomplete. Not a diff the human approves line by line. The human wrote a prompt,
            then ran the game, then said what was wrong — in plain language, usually in the register of a
            person who just wants the movement to stop looking stupid.
          </p>
          <p>
            The agent did the engineering: architecture, files, tests, builds, browser automation,
            screenshots. The human's leverage was taste, scope and patience, not typing speed.
            ${count(aggregate.prompts)} prompts across three games is, depending on how you look at it,
            an extraordinary ratio or a suspicious one — the receipts are here so you can decide.
          </p>
        </div>

        <h2 id="harness">The harness</h2>
        <div class="prose">
          <p>
            ${esc(MODEL_LABEL)} ran inside DeepSeek Harness, which gives a model a shell, a file system, a
            real browser, a shared task board and the ability to spawn specialists. For the two larger
            games a lead agent spawned subagents — arena artist, character artist, combat AI, UI, audio,
            QA — who wrote into different directories at the same time while the lead merged and fixed.
          </p>
          <p>
            Verification is the part that made the difference. The agents ran unit tests, then drove the
            finished game in headless Chrome: move, attack, level up, screenshot. Across the three builds
            the agent spent ${count(aggregate.tools.find((tool) => tool.name === 'read_image')?.count ?? 0)}
            calls looking at its own screenshots and
            ${count(aggregate.tools.find((tool) => tool.name === 'bash')?.count ?? 0)} shell calls running
            things. The most-used tool in this dataset is not writing.
          </p>
          <p class="meta">
            ${count(aggregate.subagentSessions)} subagent sessions · ${count(aggregate.thinkingChars)} characters
            of reasoning captured · telemetry generated ${esc(dateTime(generatedAt))} (UTC+7) from
            ${count(summary.sessionsInScope ?? 0)} sessions in scope
          </p>
        </div>

        <h2 id="numbers">What the numbers are</h2>
        <div class="prose">
          <p>
            Every figure comes from a script that walks the session family for each build, decompresses
            the JSONL logs and sums the usage events per session. Some fields are exact; some are floors.
            The caveats below are the same ones the build-history report carries.
          </p>
        </div>
        <div class="caveats reveal">
          ${CAVEATS.map(
            (caveat) => `<div class="caveat">
              <span class="caveat__label">${esc(caveat.label)}</span>
              <p class="caveat__body">${esc(caveat.body)}</p>
            </div>`,
          ).join('')}
        </div>

        <h2 id="proof">The proof</h2>
        <div class="prose">
          <p>
            Three screenshots, one per build, taken by the agents themselves while testing. Every image on
            this site comes from that loop — no renders, no mockups, no marketing frames.
          </p>
        </div>
        <div class="about-proof reveal">
          ${games
            .map(
              (game) => `<figure class="about-proof__item" style="--accent:${attr(game.accent)}">
                <img src="${attr(game.media.hero)}" alt="${attr(game.media.heroAlt)}" loading="lazy" decoding="async" width="640" height="400" />
                <figcaption>${esc(game.title)} — ${esc(game.genre)}</figcaption>
              </figure>`,
            )
            .join('')}
        </div>

        <h2 id="credits">Credits</h2>
        <div class="prose">
          <p>
            Built by <a href="${attr(site.authorUrl)}" target="_blank" rel="noopener">${esc(site.author)}</a>.
            The games, the prompts and the taste are his; the game code underneath them was written by
            ${esc(MODEL_LABEL)}. Screenshots come from each game's own QA runs. This showcase site was built
            the same way it describes: prompts, an agent, a headless browser and a lot of screenshots.
          </p>
          <p>
            Type is <span class="mono">Newsreader</span> and <span class="mono">IBM Plex Mono</span>,
            self-hosted. Charts are hand-authored SVG and CSS — no chart library. No analytics, no cookies,
            no third-party requests at runtime. Source under the MIT licence:
            <a href="${attr(site.repoUrl)}" target="_blank" rel="noopener">github.com/trankhanh040147/game-board</a>.
          </p>
          <p class="meta" style="margin-top:1.5rem">
            Total wall clock across the three build windows: ${esc(duration(aggregate.wallMs))} ·
            agent work: ${esc(hours(aggregate.activeMs))} h · last extraction
            ${esc(dateTime(generatedAt))}
          </p>
        </div>
      </div>
    </div>
    <div class="wrap">
      <div class="about-foot">
        <span class="meta">${count(aggregate.games)} games · ${count(aggregate.prompts)} prompts · ${count(aggregate.totalSteps)} agent steps · ${esc(compact(aggregate.totalTokens))} tokens</span>
        <a href="/making-of">Open the receipts →</a>
      </div>
    </div>`,
  }
}

export function notFoundView(): PageView {
  return {
    title: 'Not found — Game Board',
    description: 'That page does not exist on the board.',
    html: `<section class="wrap notfound">
      <h1 class="notfound__title">Off the board.</h1>
      <p class="notfound__body">
        There is no page at this address. Three games were built and every one of them is on the shelf;
        the receipts are one click away.
      </p>
      <div class="actions">
        <a class="btn" href="/">The shelf</a>
        <a class="link-arrow" href="/making-of">All receipts <span class="link-arrow__arrow" aria-hidden="true">→</span></a>
      </div>
    </section>`,
  }
}
