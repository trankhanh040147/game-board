import { attr, esc } from '../lib/dom'
import {
  compact,
  count,
  date,
  dateTime,
  duration,
  hours,
  readablePrompt,
  firstSentences,
  passedCount,
  shortHash,
} from '../lib/format'
import { gameBySlug, site } from '../data/registry'
import { aggregate, buildBySlug, MODEL_LABEL, promptEn, summary } from '../data/telemetry'
import { deployUrl } from '../data/deploy'
import {
  frame,
  cabinet,
  ledger,
  milestoneGroups,
  playButton,
  promptBlock,
  quoteBlock,
  rosterHead,
  rosterRow,
  sectionHead,
  shareBar,
  type Slide,
} from '../components/ui'
import type { PageView } from './home'

function accentStyle(slug: string): string {
  const game = gameBySlug(slug)
  if (!game) return ''
  const accentInk = slug === 'blade-and-mount' ? '#efe9df' : '#0b0b0c'
  return ` style="--accent:${attr(game.accent)};--accent-ink:${accentInk};--accent-deep:${attr(game.accent2)}"`
}

function playHref(slug: string): string {
  return deployUrl(slug) ?? gameBySlug(slug)?.playUrl ?? ''
}

function slidesFor(slug: string): Slide[] {
  const game = gameBySlug(slug)
  if (!game) return []
  return [
    { src: game.media.hero, alt: game.media.heroAlt, title: game.title, caption: game.genre, meta: 'in game' },
    ...game.media.gallery.map((image, index) => ({
      src: image.src,
      alt: image.alt,
      title: `${game.title}`,
      caption: image.alt,
      meta: `evidence ${index + 1}`,
    })),
  ]
}

function exhibitHead(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  const game = gameBySlug(build.slug)
  return `<section class="wrap exhibit-head"${accentStyle(build.slug)} aria-labelledby="exhibit-title">
    <div class="exhibit-head__top">
      <a class="exhibit-head__back" href="/making-of">← All receipts</a>
      <span class="meta">${esc(build.repoPath)}</span>
    </div>
    <h1 class="exhibit-head__title" id="exhibit-title">${esc(build.title)}</h1>
    <p class="exhibit-head__sub">${esc(game?.subtitle ?? '')} — ${esc(game?.genre ?? '')}</p>
    <dl class="exhibit-head__meta">
      <div class="meta-cell">
        <dt>built</dt>
        <dd>${esc(date(build.raw.startedAt))} → ${esc(date(build.raw.endedAt))}</dd>
      </div>
      <div class="meta-cell">
        <dt>wall clock</dt>
        <dd>${esc(duration(build.wallMs))}</dd>
      </div>
      <div class="meta-cell">
        <dt>agent work</dt>
        <dd>${esc(hours(build.activeMs))} h</dd>
      </div>
      <div class="meta-cell">
        <dt>model</dt>
        <dd>${esc(build.models[0] ?? MODEL_LABEL)}</dd>
      </div>
      <div class="meta-cell">
        <dt>team</dt>
        <dd>${count(build.teamSize)} specialist${build.teamSize === 1 ? '' : 's'}</dd>
      </div>
      <div class="meta-cell">
        <dt>prompts</dt>
        <dd>${count(build.prompts.length)}</dd>
      </div>
    </dl>
  </section>`
}

function promptsSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  return `<section class="story-section" data-shot="0" aria-labelledby="prompts-title">
    ${sectionHead('The prompts', `${count(build.prompts.length)} human ${build.prompts.length === 1 ? 'message' : 'messages'}, verbatim`)}
    <p class="story-section__intro">
      ${
        build.prompts.length === 1
          ? 'One message. Everything the game became — the waves, the bosses, the upgrades, the README — descends from this paragraph and whatever the agent decided it implied.'
          : `The whole human contribution to this build, in order. ${build.prompts.some((prompt) => prompt.translated) ? 'Vietnamese originals translated into English by the extraction script; the wording is untouched.' : 'Typed in English.'}`
      }
    </p>
    ${build.prompts
      .map((prompt, index) =>
        promptBlock({
          index,
          at: prompt.at,
          text: readablePrompt(promptEn(prompt)),
          chars: prompt.chars ?? promptEn(prompt).length,
          translated: Boolean(prompt.translated),
          lang: prompt.lang ?? 'en',
        }),
      )
      .join('')}
  </section>`
}

function thinkingSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  const excerpts = build.thinking.slice(0, 6)
  return `<section class="story-section" data-shot="1" aria-labelledby="thinking-title">
    ${sectionHead('How the agents thought', `${compact(build.thinkingChars)} characters of reasoning, unedited`)}
    <p class="story-section__intro">
      These are the agent's own working notes — not a summary written afterwards. Six moments from the
      transcript: the plan, the bug it could not see, the screenshot it read, the thing it decided was
      good enough.
    </p>
    ${excerpts
      .map((excerpt, index) =>
        quoteBlock({
          at: excerpt.at,
          text: excerpt.text ?? '',
          label: index === 0 ? 'the first read of the brief' : 'reasoning excerpt',
        }),
      )
      .join('')}
  </section>`
}

function teamSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  if (!build.subagents.length) {
    return `<section class="story-section" data-shot="2" aria-labelledby="team-title">
      ${sectionHead('The team', 'one agent, no specialists')}
      <div class="empty-state">
        <h3 class="empty-state__title">No team. Just one agent and a single turn.</h3>
        <p>
          Alien Shooter was built without spawning anyone: ${count(build.leadSteps)} steps in one session,
          ${esc(duration(build.activeMs))} of agent work, ${count(build.filesCreated)} files. The whole game — five
          enemy types, sixteen upgrades, a four-attack boss — came out of one context window with no
          delegation and no hand-off. That is why its numbers look so different from the other two.
        </p>
      </div>
    </section>`
  }
  const totalTokens = build.subagents.reduce((sum, subagent) => sum + (subagent.tokens ?? 0), 0)
  const mission = build.subagents[0]?.firstPromptEn ?? build.subagents[0]?.firstPrompt ?? ''
  return `<section class="story-section" data-shot="2" aria-labelledby="team-title">
    ${sectionHead('The team', `${count(build.subagents.length)} subagents, ${count(build.subagentSessions)} sessions`)}
    <p class="story-section__intro">
      A lead agent wrote the core and spawned specialists, each owning one directory and one job. The bar
      below is their share of ${esc(compact(totalTokens))} subagent tokens — the specialist who did the most
      reading is rarely the one who wrote the most.
    </p>
    <div class="roster reveal">
      ${rosterHead(true)}
      ${build.subagents.map((subagent) => rosterRow(subagent)).join('')}
    </div>
    <div class="reveal" style="margin-top:1.75rem">
      ${shareBar(build.subagents, gameBySlug(build.slug)?.accent ?? '#efe9df', gameBySlug(build.slug)?.accent2 ?? '#3a352d')}
    </div>
    ${
      mission
        ? `<div class="reveal" style="margin-top:clamp(2rem,3vw,3rem)">
      ${quoteBlock({ text: firstSentences(mission, 420), label: 'mission brief sent to the first specialist' })}
    </div>`
        : ''
    }
  </section>`
}

function buildSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  const commits = build.milestones.filter((milestone) => milestone.kind === 'commit')
  const fixes = commits
    .map((milestone) => milestone.label ?? '')
    .filter((label) => /fix|repair|correct|tune|regress/i.test(label))
    .slice(0, 4)
  return `<section class="story-section" data-shot="3" aria-labelledby="build-title">
    ${sectionHead('The build', `${count(build.milestones.length)} milestones, ${count(commits.length)} commits`)}
    <p class="story-section__intro">
      The transcript, grouped by what was happening. Every timestamp is when the event landed in the
      session log; commits carry the real short hash.
    </p>
    ${milestoneGroups(build.milestones)}
    ${
      fixes.length
        ? `<div class="fixes reveal">
      <h3 class="fixes__title">What broke and got fixed</h3>
      <ul class="fixes__list">
        ${fixes
          .map(
            (label) => `<li><span class="fixes__hash">${esc(shortHash(label) || '—')}</span><span>${esc(label.replace(/\s*\([0-9a-f]{7,40}\)\s*$/, ''))}</span></li>`,
          )
          .join('')}
      </ul>
    </div>`
        : ''
    }
  </section>`
}

function evidenceSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  const game = gameBySlug(build.slug)
  const tests = build.milestones
    .filter((milestone) => milestone.kind === 'test')
    .map((milestone) => ({ at: milestone.at, label: milestone.label ?? '', passed: passedCount(milestone.label ?? '') }))
    .filter((test) => test.passed != null)
  const bestTests = tests.reduce((best, test) => Math.max(best, test.passed ?? 0), 0)
  const qaCount = build.milestones.filter((milestone) => milestone.kind === 'qa').length
  const artifactCount = build.filesByExtension.reduce((sum, item) => sum + item.count, 0)
  const gallery = game?.media.gallery ?? []

  return `<section class="story-section" data-shot="1" aria-labelledby="evidence-title">
    ${sectionHead('Evidence', 'tests, screenshots, commits')}
    <p class="story-section__intro">
      ${esc(game?.description ?? build.raw.tagline ?? '')}
    </p>
    <div class="facts reveal">
      <div class="facts__item">
        <span class="facts__num">${bestTests ? count(bestTests) : '—'}</span>
        <span class="facts__cap">tests passing at the end (largest reported run)</span>
      </div>
      <div class="facts__item">
        <span class="facts__num">${count(qaCount)}</span>
        <span class="facts__cap">headless QA runs, screenshot-checked</span>
      </div>
      <div class="facts__item">
        <span class="facts__num">${count(build.filesCreated)}</span>
        <span class="facts__cap">files created — a floor, not a total</span>
      </div>
      <div class="facts__item">
        <span class="facts__num">${count(artifactCount)}</span>
        <span class="facts__cap">files by extension, counted from the log</span>
      </div>
    </div>
    <div class="gallery reveal">
      ${gallery
        .map((image, index) =>
          frame({
            src: image.src,
            alt: image.alt,
            title: game?.title ?? build.title,
            caption: image.alt,
            loading: 'lazy',
            aspect: index === 0 ? '16 / 9' : '16 / 10',
          }),
        )
        .join('')}
      ${
        game
          ? frame({
              src: game.media.hero,
              alt: game.media.heroAlt,
              title: game.title,
              caption: 'the build these screenshots came from',
              loading: 'lazy',
            })
          : ''
      }
    </div>
    <p class="prose" style="margin-top:1.75rem">
      The game lives in <a href="${attr(`${site.repoUrl}/tree/main/${build.repoPath}`)}" target="_blank" rel="noopener">${esc(build.repoPath)}</a>
      in the repository. ${build.tech.length ? `Stack: ${build.tech.map((tech) => esc(tech)).join(', ')}.` : ''}
      ${bestTests ? '' : 'No unit-test count was reported in this build\'s log; its QA runs were scripted browser checks.'}
    </p>
  </section>`
}

function provenanceSection(build: NonNullable<ReturnType<typeof buildBySlug>>): string {
  const items: Array<{ label: string; body: string }> = [
    {
      label: 'source',
      body: `DeepSeek Harness session logs (v4 JSONL, zstd) for ${count(build.sessionCount)} session${build.sessionCount === 1 ? '' : 's'} in this build family, including subagents.`,
    },
    {
      label: 'clocks',
      body: `Wall clock ${duration(build.wallMs)} is first prompt to last turn. Agent work ${hours(build.activeMs)} h sums parallel subagents, so it can exceed the window. The session-family span including the 1 Nov bookkeeping pass is ${duration(build.raw.spanMs ?? build.wallMs)}.`,
    },
    {
      label: 'tokens',
      body: `${count(build.totalTokens)} total (${count(build.outputTokens)} output, ${count(build.inputTokens)} input, ${count(build.cacheReadTokens)} cache read). Provider-reported floors; cache reads are re-used context, not fresh work.`,
    },
    {
      label: 'prompts',
      body: build.prompts.some((prompt) => prompt.translated)
        ? 'Human messages only. Vietnamese originals are kept in the data; the English shown here is a translation by scripts/extract-sessions.mjs, with pasted media URLs removed for readability.'
        : 'Human messages only, verbatim. Agent-to-agent traffic and harness plumbing are excluded.',
    },
    {
      label: 'screenshots',
      body: 'Captured by the agent during its own QA runs in a real browser, then cropped and compressed for this page. They are the game as it shipped, not marketing renders.',
    },
    {
      label: 'secrets',
      body: `${summary.redactions?.total ? `${count(summary.redactions.total)} strings were redacted from the extracted text.` : 'The extractor found no credentials or personal data in these transcripts, so nothing was redacted.'} Session ids are the only internal identifiers published.`,
    },
  ]
  return `<section class="story-section" aria-labelledby="provenance-title">
    ${sectionHead('Provenance', `extracted ${date(summary.generatedAt) || dateTime(summary.generatedAt)}`)}
    <p class="story-section__intro">
      How these numbers exist: a script walks the session family for this build, decompresses the logs,
      sums the token events per session, and extracts the human prompts, the reasoning excerpts and the
      tool calls. Nothing here is estimated by hand.
    </p>
    <div class="provenance">
      <div class="provenance__list">
        ${items.map((item) => `<div class="provenance__item"><b>${esc(item.label)}</b>${esc(item.body)}</div>`).join('')}
      </div>
      <p class="meta" style="margin-top:1.75rem">
        Cross-check: three builds, ${count(aggregate.prompts)} prompts, ${count(aggregate.agentTurns)} agent
        turns, ${esc(compact(aggregate.totalTokens))} tokens in total. Method and caveats on
        <a href="/about">the about page</a>.
      </p>
    </div>
  </section>`
}

export function view(params: Record<string, string>): PageView {
  const slug = params.slug ?? ''
  const build = buildBySlug(slug)
  if (!build) {
    return {
      title: 'No such exhibit — Game Board',
      description: 'That making-of page does not exist.',
      html: `<section class="wrap notfound">
        <h1 class="notfound__title">No such exhibit.</h1>
        <p class="notfound__body">The receipts for “${esc(slug)}” are not on this board. Three builds were made, all of them listed.</p>
        <div class="actions"><a class="btn" href="/making-of">All receipts</a><a class="link-arrow" href="/">The shelf</a></div>
      </section>`,
    }
  }

  const slides = slidesFor(slug)
  const game = gameBySlug(slug)
  const play = playHref(slug)
  const shotFor = (index: number): string => String(slides.length ? index % slides.length : 0)

  return {
    title: `${build.title} — how it was made · Game Board`,
    description: `The making of ${build.title}: ${count(build.prompts.length)} prompts, ${count(build.agentTurns)} agent turns, ${compact(build.totalTokens)} tokens, ${count(build.subagents.length)} specialist agents, and the screenshots that prove it.`,
    gameSlug: slug,
    html: `${exhibitHead(build)}
    <div class="wrap">
      <div class="section section--tight" style="padding-bottom:0">
        ${ledger([
          { to: build.prompts.length, format: 'int', caption: 'human prompts' },
          { to: build.leadSteps, format: 'int', caption: 'lead agent turns' },
          { to: build.subagentSteps, format: 'int', caption: 'subagent turns' },
          { to: build.totalTokens, format: 'compact', caption: 'tokens processed' },
          { to: build.activeMs, format: 'hours', caption: 'agent-hours of work' },
          { to: build.filesCreated, format: 'int', caption: 'files created' },
        ])}
      </div>
    </div>
    <div class="wrap exhibit-body">
      <aside class="exhibit-aside" aria-label="The specimen">
        <div class="exhibit-aside__inner" data-shot-cabinet>
          ${cabinet({ slides: slides, id: 'exhibit', cycleMs: 0, pager: false })}
          <div class="exhibit-aside__play">
            ${playButton(play, 'Play ' + build.title)}
            <span class="exhibit-aside__note">${esc(game?.genre ?? '')}<br />${esc(hours(build.activeMs))} h of agent work · ${count(build.filesCreated)} files</span>
          </div>
        </div>
      </aside>
      <div class="exhibit-story">
        ${promptsSection(build)}
        ${thinkingSection(build)}
        ${teamSection(build)}
        ${buildSection(build)}
        ${evidenceSection(build)}
        ${provenanceSection(build)}
      </div>
    </div>`,
    mount() {
      // Section-to-screenshot mapping is fixed by the order of the story.
      document.querySelectorAll<HTMLElement>('[data-shot]').forEach((section) => {
        const index = Number(section.dataset.shot ?? 0)
        section.dataset.shot = shotFor(index)
      })
    },
  }
}
