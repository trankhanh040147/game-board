# QA report — Game Board and the three deployed games

**Verdict: SHIP.** No P0 or P1 issues remain on the frozen production build. Every
number I checked matches its source, every route renders in a real browser at both
viewports, and the copy's honesty claims hold up. What remains is one editorial
observation and the usual headless-testing limitations — nothing blocking.

Independent verification by `qa`, 1 Nov 2026, Asia/Saigon (UTC+7). This report was
written against the frozen deploy: board `2026-11-01T09:16:48Z` (16:16 +07,
`index-ClvpRzcV.js`), games redeployed `09:09–09:10Z`, Git HEAD `5dd92a0`
(`e1e9f9f` + deploy/ignore follow-up; content identical to what is deployed).

| Artifact | URL / path |
| --- | --- |
| Game Board (production) | https://game-board-pi.vercel.app |
| First Hearth | https://first-hearth.vercel.app |
| Blade & Mount | https://blade-and-mount.vercel.app |
| Alien Shooter | https://alien-shooter-omega.vercel.app |
| Repository | https://github.com/trankhanh040147/game-board |
| Telemetry under test | `data/telemetry/games.json`, `data/telemetry/summary.json` |

## Final production results (all re-run on the frozen build)

| Check | Result |
| --- | --- |
| Routes `/`, `/making-of`, `/making-of/{first-hearth,blade-and-mount,alien-shooter}`, `/about`, bogus path | 7/7 HTTP 200, correct per-route `<title>` + meta description, exactly one `<h1>` |
| Console errors / page errors / failed requests / 4xx | **0 / 0 / 0 / 0** on every route and every game |
| Content truth vs `games.json` | **45/45 checks pass** (see below) |
| Prompts shown in English, no Vietnamese in the UI | 8/8 English, **0 Vietnamese leaks** |
| Mobile 390 layout | no horizontal scroll anywhere; `innerWidth = 390` on every route (Blade exhibit used to be 436) |
| Internal links | 8/8 resolve to a rendered page; Play links point at the three production game URLs |
| Keyboard | skip-link first, visible ring on **every** tab stop, menu `aria-expanded` correct |
| Reduced motion | `prefers-reduced-motion: reduce` → **0 animated elements**, content visible |
| Images | every `<img>` has alt text, 0 broken, webp only |
| CLS (cold, cache disabled) | **0.000 on all seven routes** |
| Third-party requests | none; fonts self-hosted |
| Build | `npm run build` green: **JS 192 KB / 57 KB gzip**, CSS 45 KB / 9 KB gzip |

Cold-load, production, cache disabled (1440×900):

| Route | TTFB | FCP | LCP | Total transfer | Requests | CLS |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | 133 ms | 380 ms | 380 ms | 283 KB | 8 | 0.000 |
| `/making-of` | 109 ms | 276 ms | 424 ms | 283 KB | 8 | 0.000 |
| `/making-of/first-hearth` | 99 ms | 280 ms | 304 ms | 348 KB | 9 | 0.000 |
| `/making-of/blade-and-mount` | 105 ms | 264 ms | 296 ms | 350 KB | 10 | 0.000 |
| `/making-of/alien-shooter` | 104 ms | 284 ms | 316 ms | 228 KB | 9 | 0.000 |
| `/about` | 122 ms | 276 ms | 324 ms | 183 KB | 6 | 0.000 |
| 404 | 94 ms | 288 ms | 288 ms | 138 KB | 5 | 0.000 |

## Findings, and what happened to each

Severity: **P0** blocks release, **P1** blocks public sharing, **P2** worth fixing,
**P3** polish. "Fixed" means I re-tested it on the frozen production build, not that
someone told me it changed.

| ID | Sev | Area | Finding (expected vs actual) | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| B-01 | P0 | build | `cssMinify: 'lightningcss'` with the package not installed → `npm run build` died. Expected: green build. Actual: `Cannot find package 'lightningcss'`. | **fixed** | `npm run build` green; log in session |
| B-02 | P0 | routing | `cleanUrls: true` rewrote `/index.html` → `/`, so `/making-of/*` and `/about` 404'd on hard load. Expected: 200. Actual: 404. | **fixed** | live matrix, route screenshots above |
| B-03 | P1 | `/making-of/blade-and-mount` @390 | Layout viewport expanded to 436 px because a reasoning excerpt contained an unbreakable 63-char `/Users/...` path in `white-space: pre-line` text. Expected 390. Actual: page rendered zoomed out. | **fixed** | [final/exhibit-blade-and-mount-390.png](../shots/qa/final/exhibit-blade-and-mount-390.png), [board-final.json](../shots/qa/board-final.json) |
| B-04 | P1 | exhibits | Host paths `/Users/vulcanlabs/...` rendered publicly while the provenance note claimed only session ids are published. | **fixed** — 0 occurrences on all routes | [board-final.json](../shots/qa/board-final.json) |
| B-05 | P1 | `/making-of` | "Blade & Mount is the biggest build by every measure" was false against its own data (First Hearth leads on Files 136 vs 124 and on subagent steps 1,184 vs 1,070). | **fixed** — replaced with "no build leads everything …" | [final/making-of-1440.png](../shots/qa/final/making-of-1440.png) |
| B-06 | P1 | `/about` | "The three windows total roughly 44 hours" contradicted the same page's 37.5 h and the data. | **fixed** — "three windows total 37.5 hours … overlapped, about 22.3 hours of calendar time" | [final/about-1440.png](../shots/qa/final/about-1440.png) |
| B-07 | P1 | exhibit meta | Alien meta description read "1 prompts … 0 specialist agents". | **fixed** — "1 prompt, 99 agent steps, 13.3M tokens, a single agent with no subagents" | [board-final.json](../shots/qa/board-final.json) |
| B-08 | P1 | board-wide | 1,570/1,434/99 labelled "agent turns"; they are agent **steps** (assistant messages) — 8 human turns produced 3,103 steps. | **fixed** — "agent steps" everywhere | [numbers-final.json](../shots/qa/numbers-final.json) |
| B-09 | P1 | `/about` | "Alien Shooter shipped with a Vietnamese interface" implied the live game is Vietnamese; it was localised **after** the screenshots (`45f18e0`). | **fixed** — caveat reworded, English screenshots re-captured | [final/exhibit-alien-shooter-1440.png](../shots/qa/final/exhibit-alien-shooter-1440.png) |
| B-10 | P2 | all routes | CLS 0.112 (0.209 on `/about`) from font swap / footer reflow. | **fixed** — 0.000 on all routes (main reserves 100svh + font preload post-build step) | [board-cold-final.json](../shots/qa/board-cold-final.json) |
| B-11 | P2 | First Hearth gallery | `almanac.webp` alt text described a year almanac; the image is the opening-moves checklist. | **fixed** — registry alt corrected | `data/registry.json` |
| B-12 | P2 | `/making-of` | No definition of "agent steps" next to the ranking control. | **fixed** — "A step is one assistant message — a tool call, a decision or a reply, with its tool results…" under the control | [numbers-final.json](../shots/qa/numbers-final.json), [final/making-of-1440.png](../shots/qa/final/making-of-1440.png) |
| B-13 | P2 | games | Blade & Mount and Alien Shooter had no meta description; two games blocked pinch-zoom (`user-scalable=no`); First Hearth had two `<h1>`. | **fixed** — descriptions added, viewport cleaned, single h1 | [games-coldload.json](../shots/qa/games-coldload.json) |
| B-14 | P2 | shelf / mobile | Blade & Mount has no touch controls (keyboard + mouse only), so the generic Play button was misleading on phones. | **fixed as product copy** — shelf states input requirements per game, verified at 1440 and 390 | [final/home-390.png](../shots/qa/final/home-390.png), [board-final.json](../shots/qa/board-final.json) |
| B-15 | P3 | `index.html` | `og:image` was relative; no `og:url`/canonical. | **fixed** — absolute `og:image`, `og:url`, canonical | live `<head>`; [board-final.json](../shots/qa/board-final.json) |
| B-16 | P3 | `/making-of` | "37.5 h wall clock" summed three overlapping windows without saying so. | **fixed** — "37.5 h wall clock (three overlapping windows)" | [final/making-of-1440.png](../shots/qa/final/making-of-1440.png) |
| B-17 | P3 | repo | `shots/` was 93 MB / 134 files of intermediate QA output. | **fixed** — curated to **15 MB** (`final/` + JSON reports + rerunnable harnesses) | `shots/qa/` |

### One editorial note (not a defect)

"8 prompts" is a true and effective headline, but it hides the spread: one prompt is a
20,246-character specification (First Hearth), one is a 38-character sentence (Alien
Shooter). The exhibits show both, and the About page says a one-prompt build is not a
one-instruction build — so this is a framing trade-off I would keep, labelled here as a
taste opinion rather than a finding.

## Content truth: numbers, double counting, and cache reads

### Independent recomputation from the raw logs

I decompressed the session files listed in `summary.json` (`zstd -dc` on
`session.v4.jsonl.zstd`), walked the raw `assistant/message` usage events and summed
them from scratch — without importing `scripts/extract-sessions.mjs`
(`shots/qa/recompute-telemetry.mjs`):

| Game | input | output | cache-read | total | vs JSON |
| --- | --- | --- | --- | --- | --- |
| First Hearth | 6,031,701 | 2,241,876 | 403,650,944 | 411,924,521 | exact |
| Blade & Mount | 7,493,845 | 2,205,926 | 487,968,128 | 497,667,899 | exact |
| Alien Shooter | 208,429 | 155,070 | 12,966,528 | 13,330,027 | exact |
| **All three** | **13,733,975** | **4,602,872** | **904,585,600** | **922,922,447** | **exact** |

Steps and prompts also match: 99/500/250 lead steps, 1,070/1,184 subagent steps, and
1/4/3 human prompts. Raw `user/message` counts were 1/11/11 — the extractor correctly
excludes the 15 subagent briefs, so "8 human prompts" is real, not padded.

### Double counting and "cache reads as fresh work" — both clean

- **No double counting.** Subagent tokens are counted once: 286.5 M of Blade & Mount's
  497.7 M (57.6 %) and 325.0 M of First Hearth's 411.9 M (78.9 %) sit *inside* the
  family totals, never on top of them.
- **Cache reads are disclosed, not disguised.** The provider's `totalTokens` genuinely
  includes cache reads (`input + cacheRead + output`), and the board says so at every
  level: home ("Of those 922.9M tokens, 904.6M are cache reads — context the model
  re-used rather than wrote. Fresh output is 4.6M tokens"), `/making-of` ("cache reads
  dominate … the number that means 'the model wrote this' is the output figure"), and
  `/about` ("they are context the model re-used, not text it produced. The honest
  'written' figure is output tokens"). The headline metric is labelled **"tokens
  processed"**, not "tokens written" — this is the single best honesty decision on the
  site.
- **Time is not conflated.** Three clocks are published (`spanMs` family span,
  `durationMs` build window, `activeMs` summed model turn time), the parallel-subagent
  inflation of agent-hours is stated, and the overlap of the three windows is now stated
  too (B-16). Per-build wall clock (21 h 18 m for Blade & Mount) and 23.6 agent-hours are
  each true statements about different things.
- **One residual data-key footgun** (not visible to readers): `summary.json`'s
  `totals.spanMs` is actually Σ build windows (135,015,489 ms = exactly Σ `durationMs`),
  and `totals.durationMs` is the max window. The site consumes per-game fields and
  labels the aggregate "across three build windows", so nothing misleading is published —
  but renaming those two summary keys would prevent a future consumer from misreading them.

### Rendered-number spot check (production)

`shots/qa/check-numbers.mjs final` matches the live DOM against `games.json` (exact or
compact rendering accepted): total/input/output/cache-read tokens, prompts, lead steps,
subagent steps, subagent count, agent work time, wall clock, files, milestones and
reasoning characters — per game, plus the cross-game aggregate on `/making-of`, plus the
English `textEn` of all 8 prompts and a Vietnamese-leak test. **45 pass, 0 fail,
8/8 prompts English, 0 leaks.** Example (Blade & Mount):

| Field | Rendered | `games.json` |
| --- | --- | --- |
| total tokens | 497.7M / 497,667,899 | 497,667,899 |
| input / output / cache | 7,493,845 / 2,205,926 / 487,968,128 | same |
| prompts | 4 | 4 |
| lead / subagent steps | 500 / 1,070 | 500 / 1,070 |
| agent work / wall clock | 14.0 h / 21 h 18 m | 50,245,755 / 76,702,025 ms |
| subagents / files | 7 / 124 | 7 / 124 |

## The three deployed games (final sources, cold cache)

| Game | Status | TTFB | FCP | JS transfer | Total | Errors | 4xx | First frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| First Hearth | 200 | 112 ms | 212 ms | 267 KB | 416 KB | 0 | 0 | 833–1,017 ms |
| Blade & Mount | 200 | 99 ms | ~960–1,032 ms | 286 KB | 608 KB | 0 | 0 | **879 ms** (rAF + `readPixels`) |
| Alien Shooter | 200 | 94 ms | 216 ms | 32 KB | 38 KB | 0 | 0 | 252–303 ms |

Explicit first interaction (not a synthetic click), 0 console/network errors on all three:

- **First Hearth** — "Light the hearth" → onboarding closes, world clock advances
  (Spring 1 → 2), HUD/panels render; `B` opens the build panel, `Space` pauses.
  [final/game-first-hearth-after-interaction.png](../shots/qa/final/game-first-hearth-after-interaction.png), [first-hearth-interaction.json](../shots/qa/first-hearth-interaction.json).
- **Blade & Mount** — menu → *Tournament* → *Enter the Lists* → loadout → *TAKE THE
  FIELD* → in-bout with a live WebGL canvas.
  [final/game-blade-and-mount-after-interaction.png](../shots/qa/final/game-blade-and-mount-after-interaction.png), [games-final.json](../shots/qa/games-final.json).
- **Alien Shooter** — *START THE FIGHT* → HUD un-hides, "WAVE 01 LEFT 8", score/level/health.
  [final/game-alien-shooter-after-interaction.png](../shots/qa/final/game-alien-shooter-after-interaction.png), [games-final.json](../shots/qa/games-final.json).

Game-level a11y/SEO now: all three have `<meta name="description">`, `lang="en"`, one
`<h1>`, and clean viewports (no `user-scalable=no`). Alien Shooter is **English
end-to-end**: I scanned every deployed `.js`/`.css`/inline script and the HTML for
Vietnamese characters (0 hits) and confirmed the game-over labels render in English
(SCORE / BEST / WAVE / KILLS / LEVEL / TIME, SIGNAL LOST, PLAY AGAIN, BACK TO MENU); the
board gallery was re-captured from that build (`title`, `level up`, `game over` — no
Vietnamese labels). Blade & Mount still has no touch controls; the shelf now warns
"Keyboard and mouse required — no touch controls" (B-14), so that is a stated design
fact rather than a defect.

## Repo hygiene

- **No secrets or personal data**: regex scan for `ghp_`, `gho_`, `github_pat_`, `sk-`,
  `AKIA`, `xox[baprs]-`, private-key headers and email addresses across tracked files,
  `data/`, `docs/` and `README.md` → clean. `summary.json` reports `redactions.total = 0`
  and the extractor's `--self-test` passes (all seeded secret shapes are redacted).
- **No build output or deps tracked**: `node_modules/` and `dist/` are ignored at root and
  in each game; `git ls-files | grep -E '(node_modules|dist)/'` is empty. `.vercel/` is
  ignored; `.vercelignore` keeps the board upload to board sources (and, after the deploy
  fix, keeps `scripts/` so the font-preload post-step can run).
- **README instructions executed, not just read**: `npm install`, `npm run build` (green),
  `npm run dev` (5199), `npm run preview` (5200), `node scripts/extract-sessions.mjs
  --self-test` (pass). Documented game ports (5280 / 5273) match each game's
  `package.json`.
- **Links**: GitHub repo 200; Play hrefs exactly the three production URLs with
  `target="_blank" rel="noopener"`.
- **Evidence size**: `shots/qa/` is **15 MB / 43 files** — `final/` (26 screenshots), six
  JSON result files, and the rerunnable harnesses. No intermediate/pre-fix duplicates.

## What a stranger sees in 30 seconds

Load `/`: a near-black editorial page with the serif headline **"Three games. No hands."**,
one sentence — "A person typed 8 prompts. An AI agent typed everything else: every
system, every sprite, every line of CSS. Play the games, then read the receipts." — two
obvious actions, a cycling cabinet of real gameplay screenshots, and immediately below,
"deepseek-v4.1-flash · 15 specialist agents. Every figure below is summed from session
logs — not an estimate." The promise is legible without scrolling further; the receipts
page then delivers the comparison, the three clocks and the prompt archive, and each
exhibit opens with the verbatim (translated) prompts. It reads like a museum label
written by an engineer, not a landing page: no gradients, no glass cards, no emoji soup,
no unsourced superlatives left. The honesty is the draw and it survives scrutiny — the
site volunteers that most tokens are re-used context and that one game took a single
prompt. The one caveat is editorial, not functional: the 8-prompt headline smooths over a
20,246-character spec and a 38-character sentence; the exhibits show the spread.

## Evidence index (`shots/qa/`)

Every path links to the file in the repo (relative to this report in `docs/`).

- Route screenshots, desktop 1440×900:
  [home](../shots/qa/final/home-1440.png) ·
  [making-of](../shots/qa/final/making-of-1440.png) ·
  [First Hearth exhibit](../shots/qa/final/exhibit-first-hearth-1440.png) ·
  [Blade & Mount exhibit](../shots/qa/final/exhibit-blade-and-mount-1440.png) ·
  [Alien Shooter exhibit](../shots/qa/final/exhibit-alien-shooter-1440.png) ·
  [about](../shots/qa/final/about-1440.png) ·
  [404](../shots/qa/final/notfound-1440.png)
- Route screenshots, mobile 390×844:
  [home](../shots/qa/final/home-390.png) ·
  [making-of](../shots/qa/final/making-of-390.png) ·
  [First Hearth exhibit](../shots/qa/final/exhibit-first-hearth-390.png) ·
  [Blade & Mount exhibit](../shots/qa/final/exhibit-blade-and-mount-390.png) ·
  [Alien Shooter exhibit](../shots/qa/final/exhibit-alien-shooter-390.png) ·
  [about](../shots/qa/final/about-390.png) ·
  [404](../shots/qa/final/notfound-390.png)
- Accessibility evidence: [keyboard focus ring](../shots/qa/final/home-focus.png) ·
  [reduced motion](../shots/qa/final/home-reduced-motion.png) ·
  [about focus](../shots/qa/final/about-focus.png)
- Deployed games: [First Hearth desktop](../shots/qa/final/game-first-hearth-desktop.png) ·
  [First Hearth mobile](../shots/qa/final/game-first-hearth-mobile.png) ·
  [First Hearth after "Light the hearth"](../shots/qa/final/game-first-hearth-after-interaction.png) ·
  [Blade & Mount desktop](../shots/qa/final/game-blade-and-mount-desktop.png) ·
  [Blade & Mount mobile](../shots/qa/final/game-blade-and-mount-mobile.png) ·
  [Blade & Mount in-bout](../shots/qa/final/game-blade-and-mount-after-interaction.png) ·
  [Alien Shooter desktop](../shots/qa/final/game-alien-shooter-desktop.png) ·
  [Alien Shooter mobile](../shots/qa/final/game-alien-shooter-mobile.png) ·
  [Alien Shooter in-game](../shots/qa/final/game-alien-shooter-after-interaction.png)
- Machine-readable results: [board-final.json](../shots/qa/board-final.json) (route matrix) ·
  [board-cold-final.json](../shots/qa/board-cold-final.json) (TTFB/FCP/LCP/CLS/weight) ·
  [numbers-final.json](../shots/qa/numbers-final.json) (45 number checks) ·
  [telemetry-recompute.json](../shots/qa/telemetry-recompute.json) (raw-log recomputation) ·
  [games-coldload.json](../shots/qa/games-coldload.json) (game cold load + meta) ·
  [games-final.json](../shots/qa/games-final.json) and
  [first-hearth-interaction.json](../shots/qa/first-hearth-interaction.json) (game interactions)
- Rerunnable harnesses: [check-board.mjs](../shots/qa/check-board.mjs) (`<url> <label>`) ·
  [check-board-cold.mjs](../shots/qa/check-board-cold.mjs) ·
  [check-numbers.mjs](../shots/qa/check-numbers.mjs) (reads `board-<label>.json`) ·
  [check-games-cold.mjs](../shots/qa/check-games-cold.mjs) ·
  [check-games-final.mjs](../shots/qa/check-games-final.mjs) ·
  [recompute-telemetry.mjs](../shots/qa/recompute-telemetry.mjs) ·
  [check-games.mjs](../shots/qa/check-games.mjs) and
  [check-blade-followup.mjs](../shots/qa/check-blade-followup.mjs) (WebGL first-frame method).

## Limitations

- Headless Chrome only (156.0.8078.74); no Safari/WebKit or Firefox run, and no physical
  phone — mobile is emulated at 390×844, DPR 2, touch enabled.
- CLS/LCP were measured on a fast connection as well as production; slower connections
  can make CLS worse, never better, so 0.000 here is a floor for the tested scenarios.
- No Lighthouse/axe dependency was added (repo dependency policy); accessibility checks
  are the targeted set above (structure, focus, labels, alt text, motion, contrast by eye
  on the bone-on-#0b0b0c palette, which is far above 4.5:1).
- Tone judgments ("does a stranger get it in 30 seconds") are editorial opinions and are
  labelled as such; everything else is measured.
