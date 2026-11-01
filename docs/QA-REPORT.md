# QA report — Game Board and the three deployed games

**Verdict: SHIP** (see [Final verification](#final-verification) for the frozen-build
confirmation; two non-blocking P2/P3 items remain listed below as `open`.)

Independent verification performed by `qa` on 1 Nov 2026, Asia/Saigon (UTC+7).

| Artifact | URL / path |
| --- | --- |
| Game Board (production) | https://game-board-pi.vercel.app |
| First Hearth | https://first-hearth.vercel.app |
| Blade & Mount | https://blade-and-mount.vercel.app |
| Alien Shooter | https://alien-shooter-omega.vercel.app |
| Repository | https://github.com/trankhanh040147/game-board |
| Telemetry under test | `data/telemetry/games.json`, `data/telemetry/summary.json` |

## Verdict at a glance

The board is honest, relates to a real browser, and every published number I
spot-checked matches its source. I found no P0 remaining and no P1 remaining on
the frozen build. The pre-freeze defects (build blocker, SPA deep-link 404, mobile
390 px overflow, a privacy leak and three copy errors) are all verified fixed.
What remains is polish: a 0.11 CLS on four routes (font swap), missing meta
descriptions on two of the three deployed games, and two small SEO/copy nits.

## How this was verified

- Real Chrome **156.0.8078.74** driven by `puppeteer-core` **24.43.1** (reused from
  `games/first-hearth/node_modules`, no dependencies added to the repo), Node **v26.5.0**.
- Board: `npm run build` (Vite 7.3.7) + `npm run preview`, plus the deployed board.
  Viewports **1440×900** and **390×844** (DPR 2, mobile emulation), cold cache
  (fresh browser context + `Network.setCacheDisabled`) for weight/CLS/LCP numbers.
- Games: cold load, console + network audit, 1440 and 390 screenshots, explicit
  first interaction (First Hearth onboarding, Alien Shooter match start, Blade &
  Mount tournament flow), WebGL first frame measured with `requestAnimationFrame` +
  `gl.readPixels` (a plain `drawImage` readback returns blank for Blade & Mount
  because it runs with `preserveDrawingBuffer: false`).
- Content truth: an independent, from-scratch recomputation of token/step/prompt
  totals straight from the raw `session.v4.jsonl.zstd` logs (`shots/qa/recompute-telemetry.mjs`),
  and a rendered-number matcher that compares the board's DOM against
  `data/telemetry/games.json` (`shots/qa/check-numbers.mjs`).
- Harnesses are committed under `shots/qa/` (`check-games-cold.mjs`,
  `check-board.mjs`, `check-board-cold.mjs`, `check-numbers.mjs`,
  `recompute-telemetry.mjs`, `check-games-final.mjs`), so every claim here is rerunnable.

## Findings

Severity: **P0** blocks release, **P1** should block sharing publicly, **P2** worth
fixing, **P3** polish. Every item below was found and re-tested in a real browser.

| ID | Sev | Route | Finding (expected vs actual) | Evidence | Status | One-line fix |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | P0 | repo root | `npm run build` fails: `vite.config.ts` sets `cssMinify: 'lightningcss'` but the package is not installed. Expected: build passes. Actual: `Cannot find package 'lightningcss'`. | build log (this session); `vite.config.ts:10` | **fixed** — now `cssMinify: true`; build green (JS 192 KB / 57 KB gzip) | add the dep, or omit the option (site did the latter) |
| B-02 | P0 | any deep link | Board deployed with `cleanUrls: true` rewrote `/index.html` back to `/`, so `/making-of/*` and `/about` 404'd on hard load. Expected: every route 200. Actual: 404. | `vercel.json`; lead's verification log | **fixed** — `cleanUrls: false` + SPA rewrite; all 7 routes 200 | keep `cleanUrls` off for an SPA with a catch-all rewrite |
| B-03 | P1 | `/making-of/blade-and-mount` @390 | Layout viewport expanded to **436 px** (`innerWidth=436`, `scrollWidth=436`) because a reasoning excerpt contained an unbreakable 63-char `/Users/...` path inside `p.quote__text { white-space: pre-line }`. Expected: 390-wide layout; actual: whole page rendered zoomed-out. | `shots/qa/board-preview.json` → `routes[exhibit-blade-and-mount].mobile.info.overflow`; after fix `shots/qa/final/exhibit-blade-and-mount-390.png` | **fixed** — `overflow-wrap: anywhere` + `shortenPaths()`; innerWidth now 390 on all routes | keep `overflow-wrap` on quote/prompt prose |
| B-04 | P1 | `/making-of/blade-and-mount`, `/first-hearth`, `/alien-shooter` | Rendered `/Users/vulcanlabs/Documents/deepseek-harness/...` while the provenance note claimed "Session ids are the only internal identifiers published". Expected: no host paths in public copy. Actual: path printed twice on the Blade exhibit. | `shots/qa/board-live-pre.json` → `routes[exhibit-blade-and-mount].desktop.expandedText` | **fixed** — 0 `/Users/` occurrences across all routes | strip absolute paths at render (done) |
| B-05 | P1 | `/making-of` | Copy claimed "Blade & Mount is the biggest build by every measure". Its own **Files** measure ranks First Hearth first (136 vs 124) and subagent steps also favour First Hearth (1,184 vs 1,070). Expected: claim matches data. Actual: false, and contradicted by the page's own toggle. | `shots/qa/final/making-of-1440.png`; `numbers-final.json` | **fixed** — replaced with "no build leads everything … First Hearth wrote more files (136 vs 124) …" | state what each build leads on |
| B-06 | P1 | `/about` | Caveat said "The three windows total roughly 44 hours" while the same page's footer and the data print **37.5 h**. Expected: one number. Actual: 44 h vs 37.5 h on one page (44 h is not derivable from any field). | `shots/qa/board-live-pre.json` → about text; fixed in `board-prefinal.json` | **fixed** — "three windows total 37.5 hours, and because they overlapped, about 22.3 hours of calendar time passed" | report sum-of-windows and calendar span together |
| B-07 | P1 | exhibit meta tags | `<meta name="description">` for Alien Shooter read "**1 prompts**, 99 agent turns, **0 specialist agents**". Expected: grammatical and not advertising an empty team. Actual: "1 prompts", "0 specialist agents". | `shots/qa/board-live-pre.json` → `routes[exhibit-alien-shooter].desktop.info.metaDescription` | **fixed** — "1 prompt, 99 agent steps, 13.3M tokens, a single agent with no subagents" | pluralise and use the solo-build phrasing |
| B-08 | P1 | board-wide | 1,570 / 1,434 / 99 were labelled "agent turns" (and 500 "lead turns", 1,070 "subagent turns"). They are **agent steps** (assistant messages); 8 human turns produced 3,103 steps. Expected: precise term. Actual: "turns" inflates the mental model of a turn. | `shots/qa/board-live-pre.json`; fixed in `numbers-final.json` | **fixed** — "agent steps" everywhere; definition on `/about` ("A step is one assistant message — a tool call, a decision or a reply") | keep "turns" only for human turns |
| B-09 | P1 | `/about` | "Alien Shooter shipped with a Vietnamese interface, so its screenshots show Vietnamese labels." The deployed game is fully English, and its UI was localised after the original screenshots (`45f18e0 feat(alien-shooter): localize the UI to English`). Expected: accurate provenance. Actual: implied the shipped game is Vietnamese. | `games/alien-shooter/js/game.js`; live page text; `git log` | **fixed** — screenshots re-captured from the English build and caveat reworded | describe the *first build*, not the shipped build |
| B-10 | P2 | `/`, exhibits, `/about` | Cumulative Layout Shift **0.112** (was 0.209 on `/about` before the 44 h/text fixes), above the 0.1 "good" threshold, caused by font swap: the about lede reflows 177→141 px at ~70 ms and the footer jumps. Measured cold, production build. | `shots/qa/board-cold-prefinal.json` | **open** (non-blocking) | preload the above-the-fold Newsreader + IBM Plex Mono woff2, or add `size-adjust` fallback metrics |
| B-11 | P2 | `/making-of/first-hearth` gallery | Registry alt text for `almanac.webp` described "the year almanac summarising a season", but the image is the opening-moves checklist and a creed decision. Expected: alt describes the image. Actual: wrong description for screen readers. | `data/registry.json` (was); fixed in working tree | **fixed** — "The opening moves checklist and a creed decision over a young settlement" | keep alt text next to the crop |
| B-12 | P2 | `/making-of` | The `Agent steps` toggle has no inline definition; the definition only exists on `/about`. Expected: a reader knows what a step is where the label appears. Actual: works only if they visit `/about`. | `shots/qa/final/making-of-1440.png`; `numbers-final.json` → `makingOf.definitionPresent` | **open** (P3-level polish) | add one line under the toggle: "a step = one assistant message with its tool calls" |
| B-13 | P2 | games (separate projects) | `blade-and-mount` and `alien-shooter` have **no `<meta name="description">`**; `first-hearth` sets `user-scalable=no, maximum-scale=1`, `alien-shooter` sets `user-scalable=no` (WCAG 1.4.4 blocks pinch-zoom). | `shots/qa/games-coldload.json` → `meta` | **open** (games copied after screenshots) | add descriptions; drop `user-scalable=no` for the title/HUD screens |
| B-14 | P2 | `blade-and-mount` on phones | The game has no touch controls (0 touch/joystick nodes; keyboard + mouse only), yet the board's Play button is the same on mobile. Expected: a mobile visitor knows why nothing happens. Actual: menu renders, gameplay is unplayable. | `shots/qa/games-final.json` → `games[blade-and-mount].mobile`; `final/game-blade-and-mount-mobile.png` | **open** (product decision) | add "(keyboard + mouse)" beside Play, or a mobile notice |
| B-15 | P3 | `index.html` | `og:image` is relative (`/media/blade-and-mount/hero.webp`) and there is no `og:url`/`canonical`. Social crawlers need absolute URLs. | `shots/qa/final/home-1440.png`; page meta | **open** | absolute `og:image`, add `canonical` |
| B-16 | P3 | `/making-of` header | "37.5 h wall clock" aggregates three **overlapping** build windows; the calendar span is ~22.3 h. `/about` now explains the overlap, `/making-of` does not. | `shots/qa/final/making-of-1440.png` | **open** (low) | append "(three windows, overlapping)" or show 22.3 h |
| B-17 | P3 | repo | `shots/` had grown to 93 MB / 134 files of intermediate QA output; untracked and uncommit-ready. | `git status`; this report's evidence dir | **fixed** — curated to `shots/qa/final/` + JSON, < 20 MB | capture viewport screenshots only, curate per route |

Earlier board-page defects that were transient mid-build (lightningcss build break,
missing `almanac.webp`, blank lazy images) were re-tested after the final build; none
reproduce. The games' favicon 404s (Alien Shooter requesting `/favicon.ico`) were
also fixed and redeployed during QA and no longer appear at runtime.

## Content truth: every published number I checked matches its source

### Independent recomputation from raw session logs

I decompressed the session families listed in `summary.json` (`zstd -dc` on
`session.v4.jsonl.zstd`), walked the raw `assistant/message` usage events, and summed
them without importing `scripts/extract-sessions.mjs`. Result (`shots/qa/telemetry-recompute.json`):

| Game | input tokens | output tokens | cache-read | total tokens | matches JSON |
| --- | --- | --- | --- | --- | --- |
| First Hearth | 6,031,701 | 2,241,876 | 403,650,944 | 411,924,521 | **exact** |
| Blade & Mount | 7,493,845 | 2,205,926 | 487,968,128 | 497,667,899 | **exact** |
| Alien Shooter | 208,429 | 155,070 | 12,966,528 | 13,330,027 | **exact** |
| **All three** | 13,733,975 | 4,602,872 | 904,585,600 | 922,922,447 | **exact** |

Steps and prompts also match the raw logs: 99/500/250 root assistant messages, 1,070/1,184
subagent steps, and 1/4/3 human prompts. Raw `user/message` counts were 1/11/11 — the
extractor correctly excludes the 15 subagent briefs, so "8 human prompts" is real.

### No double counting, and cache reads are not presented as fresh work

- Subagent tokens are counted **once**. Per-game subagent token sums are 286.5 M of
  Blade & Mount's 497.7 M (57.6 %) and 325.0 M of First Hearth's 411.9 M (78.9 %) —
  subsets of the family totals, never added on top of them.
- The totals genuinely include cache reads (provider `totalTokens = input + cacheRead +
  output`), and the board says so where it matters: home ("Of those 922.9M tokens,
  904.6M are cache reads — context the model re-used rather than wrote. Fresh output is
  4.6M tokens"), `/making-of` ("Cache reads dominate every build … the number that means
  'the model wrote this' is the output figure"), `/about` ("Token totals … should be
  read as floors. Cache reads dominate them; they are context the model re-used, not
  text it produced. The honest 'written' figure is output tokens"). This is the
  strongest part of the site's honesty: the big number is labelled "tokens processed",
  not "tokens written".
- Three clocks are published rather than one (`spanMs`, `durationMs`, `activeMs`), the
  parallel-subagent inflation of agent-hours is stated, and the overlap of the windows
  is now stated too (B-06). Wall-clock per game is the build window (21 h 18 m for
  Blade & Mount — true), 23.6 agent-hours is summed turn time — also true.
- One label residual: `summary.json`'s `totals.spanMs` is actually the **sum of build
  windows** (135,015,489 ms = exactly Σ `durationMs`), not a span; `totals.durationMs`
  is the max window. The site happens to consume per-game fields and `aggregate.wallMs`
  (labelled "across three build windows"), so nothing misleading reaches the page —
  but the JSON key is a footgun for the next consumer.

### Rendered-number spot check (45/45 on the frozen build)

`node shots/qa/check-numbers.mjs final` compares the exhibit DOM against
`games.json` and accepts exact or compact renderings. Checks cover, per game: total
tokens, input, output, cache-read, prompts, lead steps, subagent steps, subagent
sessions, agent work time, wall clock, files created, milestones and reasoning
characters — plus the cross-game aggregate on `/making-of`, the English `textEn` of
all 8 prompts, and the Vietnamese-leak test. Result: **45 pass, 0 fail, 8/8 prompts
English, 0 Vietnamese leaks**. Full output: `shots/qa/numbers-final.json`.

Example (Blade & Mount) — rendered vs JSON:

| Field | Rendered | `games.json` |
| --- | --- | --- |
| total tokens | 497.7M (and 497,667,899) | 497,667,899 |
| input / output / cache | 7,493,845 / 2,205,926 / 487,968,128 | same |
| prompts | 4 | 4 |
| lead steps / subagent steps | 500 / 1,070 | 500 / 1,070 |
| agent work / wall clock | 14.0 h / 21 h 18 m | 50,245,755 ms / 76,702,025 ms |
| subagents / files | 7 / 124 | 7 / 124 |

## The three deployed games

Cold load (fresh context, cache disabled), real Chrome:

| Game | Status | TTFB | FCP | JS transfer | Total | Console errors | Failed/4xx | First frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| First Hearth | 200 | 171 ms | 1,208 ms | 267 KB | 416 KB | 0 | 0 | 833–1,017 ms |
| Blade & Mount | 200 | 260 ms | ~984 ms (mobile) | 286 KB | 450 KB / 608 KB mobile | 0 | 0 | **879 ms** (rAF + `readPixels`) |
| Alien Shooter | 200 | 98 ms | 1,008 ms | 32 KB | 38 KB | 0 | 0 | 252–303 ms |

First interaction, explicit (not just a synthetic click):

- **First Hearth** — "Light the hearth" → onboarding overlay closes, world clock advances
  (Spring 1 → Spring 2), HUD/panels render; `B` opens the build panel, `Space` pauses.
  0 errors. `shots/qa/first-hearth-interaction.json`, `final/game-first-hearth-after-interaction.png`.
- **Blade & Mount** — menu → *Tournament* → *Enter the Lists* → loadout → *TAKE THE FIELD*,
  landing in-bout with a live WebGL canvas. 0 errors. `shots/qa/games-final.json`,
  `final/game-blade-and-mount-after-interaction.png`.
- **Alien Shooter** — *START THE FIGHT* → HUD un-hides, wave 01 spawns ("WAVE 01 LEFT 8",
  score/level/health). 0 errors. `shots/qa/games-final.json`,
  `final/game-alien-shooter-after-interaction.png`.
- All three: no horizontal overflow at 390; titles correct; First Hearth mobile pans,
  Alien Shooter has 9 touch-control nodes, Blade & Mount has none (B-14).

## Board: routes, navigation, accessibility, weight

All seven routes on the frozen build: **status 200, exactly one `<h1>`, correct
per-route `<title>` and meta description, zero console errors, zero failed or 4xx
requests, no horizontal overflow at 390 px, 8/8 unique internal links resolve.**
Bogus path `/definitely-not-a-real-page-xyz` returns the in-app "Off the board." state
(HTTP 200 by design for an SPA).

| Check | Result |
| --- | --- |
| Console errors / pageerrors / 4xx | 0 / 0 / 0 on every route |
| Header + footer nav | all links present; header nav hidden at 390 behind a working menu |
| Mobile menu | `aria-expanded` flips true; all nav links visible after tap (`final/*-390-menu-open.png`) |
| Keyboard tab order | skip-link → header → content → footer; **focus-visible ring on every stop** (`outline: solid 2px rgb(239,233,223)`), `final/home-focus.png` |
| Landmarks / lang / headings | `lang="en"`, one `header/main/footer`, no heading-level skips, one `h1` |
| Images | every `<img>` has alt text, `loading="lazy"` below the fold, 0 broken (`naturalWidth>0`) |
| Reduced motion | `prefers-reduced-motion: reduce` → 0 animated elements, reveals visible (`final/home-reduced-motion.png`) |
| Favicon | `/favicon.svg` 200 |
| Third-party requests | none — fonts are self-hosted woff2, no CDN, no runtime deps |
| External Play links | exactly `first-hearth.vercel.app`, `blade-and-mount.vercel.app`, `alien-shooter-omega.vercel.app`, `target="_blank"`, `rel="noopener"` |
| Repo link | `github.com/trankhanh040147/game-board` → HTTP 200 |

Cold page weight and core metrics (production build, cache disabled, 1440×900):

| Route | Total transfer | Requests | CLS |
| --- | --- | --- | --- |
| `/` | 274 KB | 8 | 0.112 |
| `/making-of` | 274 KB | 8 | 0.002 |
| `/making-of/first-hearth` | 346 KB | 9 | 0.112 |
| `/making-of/blade-and-mount` | 348 KB | 10 | 0.112 |
| `/making-of/alien-shooter` | 206 KB | 9 | 0.112 |
| `/about` | 181 KB | 6 | 0.112 |
| 404 | 136 KB | 5 | 0.002 |

Bundle: **JS 192 KB / ~57 KB gzip**, **CSS ~44 KB / ~9 KB gzip** — well inside the
250 KB gzip JS budget. Images are webp, largest hero 128 KB. CLS is the one perf
regression (B-10, font swap); it is not blocking.

## Repo hygiene

- No secrets, tokens, private keys or personal email addresses in tracked files or in
  `data/`, `docs/` or `README.md` (regex scan for `ghp_`, `gho_`, `github_pat_`, `sk-`,
  `AKIA`, `xox[baprs]-`, private-key headers, emails). The extractor's own
  `--self-test` passes (all seeded secret shapes redacted), and `summary.json` reports
  `redactions.total = 0`.
- `node_modules/` and `dist/` are ignored everywhere (root + `games/*`); no build output
  is tracked. `git ls-files | grep -E '(node_modules|dist)/'` → empty. `.vercel/` is
  ignored; `.vercelignore` keeps the board's Vercel upload to board sources (`games/`,
  `shots/`, `docs/`, `scripts/` excluded from the board project only).
- `README.md` instructions were executed, not just read: `npm install`, `npm run build`
  (green), `npm run dev` on 5199, `npm run preview` on 5200, and
  `node scripts/extract-sessions.mjs --self-test` (pass). Game dev ports in the README
  (first-hearth 5280, blade-and-mount 5273) match each game's `package.json`.
- The only untracked directory during QA was `shots/` (QA evidence); it is now curated
  and deliberately part of the deliverable, not an accident. `data/deploy.json` carries
  all four production URLs.
- GitHub repo link is live (HTTP 200) and the README's making-of links point at the
  deployed board.

## What a stranger sees in 30 seconds

Load `/` at 1440×900: a near-black editorial page with a serif headline reading
**"Three games. No hands."**, one sentence — "A person typed 8 prompts. An AI agent
typed everything else: every system, every sprite, every line of CSS. Play the games,
then read the receipts." — two obvious actions, a cycling cabinet of real gameplay
screenshots, and immediately under it "deepseek-v4.1-flash · 15 specialist agents.
Every figure below is summed from session logs — not an estimate." The promise ("play
three real games, then inspect exactly what it cost") is legible without scrolling
further, and the receipts page delivers the comparison table, the three clocks and the
prompt archive. It reads like a museum label written by an engineer, not a landing
page: no purple gradients, no glass cards, no emoji soup, no vague superlatives left
(the one that existed is fixed). The honesty is the hook, and it survives scrutiny —
the site volunteers that most of its "tokens" are re-used context and that one game
took a single prompt. The main caveat for a stranger is editorial rather than
functional: "8 prompts" is dramatic precisely because one of them is a 20,246-character
spec (First Hearth) and one is a 38-character sentence (Alien Shooter); the exhibits
show both, but the hero does not hint at the spread. That is a fair trade for the
headline, not a defect.

## Evidence index

All paths relative to `shots/qa/`:

- `final/<route>-1440.png`, `final/<route>-390.png` — every route at both viewports
  (`home`, `making-of`, `exhibit-first-hearth`, `exhibit-blade-and-mount`,
  `exhibit-alien-shooter`, `about`, `notfound`).
- `final/home-focus.png` (keyboard focus ring), `final/home-reduced-motion.png`,
  `final/home-390-menu-open.png` (mobile menu open).
- `final/game-<slug>-desktop.png`, `final/game-<slug>-mobile.png`,
  `final/game-<slug>-after-interaction.png` — the three deployed games.
- `board-final.json` — full route matrix (titles, headings, links, images, overflow,
  menu, focus order, reduced motion, console/network).
- `board-cold-final.json` — cold per-route TTFB/FCP/LCP/CLS/weight.
- `numbers-final.json` — the 45 rendered-number checks and prompt/language checks.
- `telemetry-recompute.json` — independent raw-session recomputation.
- `games-coldload.json` — cold-load metrics for the three games.
- `games-final.json`, `first-hearth-interaction.json` — explicit game interactions.
- `check-*.mjs`, `recompute-telemetry.mjs` — the harnesses, rerunnable:
  `node shots/qa/check-board.mjs <url> <label>`, `node shots/qa/check-numbers.mjs <label>`,
  `node shots/qa/check-board-cold.mjs <url> <label>`, `node shots/qa/check-games-cold.mjs`.

## Limitations

- Headless Chrome only (no Safari/Firefox/WebKit run); no physical phone, but mobile is
  emulated at 390×844 with DPR 2 and touch enabled.
- CLS/LCP measured on a fast local connection as well as production; real-network CLS
  can be worse, never better, so treat 0.112 as a floor.
- No Lighthouse/axe dependency was added (repo dependency policy); a11y checks are the
  targeted set above (structure, focus, labels, alt text, motion, contrast by eye on
  the bone-on-#0b0b0c palette, which is far above 4.5:1).
- Copy judgments about tone ("is it interesting in 30 seconds") are editorial opinions,
  labelled as such; everything else is measured.
