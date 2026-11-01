# FIRST HEARTH — QA REPORT

**Date:** 2026-10-31 → 2026-11-01 (Asia/Saigon) · **Round 3 verification** (autosave, DPR2 terrain, onboarding-overlap fixes)
**Environment:** macOS (arm64), Node v26.5.0, Vite 7.1, TypeScript 5.9, vitest 3.2.7, puppeteer-core 24.10 driving system Chrome (headless; DPR1 and DPR2/Retina simulation), deterministic simulation (`GameState.seed`). Dev server `http://127.0.0.1:5280` (Lead-owned); QA browser matrices run against a production build served from `http://127.0.0.1:5299` (isolated preview so in-flight HMR edits cannot invalidate a run).
**Scope:** headless sim harness, deterministic/soak runs, economy/decision/onboarding regression tests, renderer & autosave performance profiling, full browser/UI matrix at 1600×900 and 1280×800, accessibility/UX notes.

---

## 1. Final verdict

**PASS for internal/demo ship — no P0/blocking bugs.** Round 3 re-verified the three player-facing fixes from round 2 plus the three follow-up fixes (autosave scheduling, DPR2 terrain thrash, onboarding visual overlap) on a stable production build:

- **Simulation:** deterministic (same seed + same script ⇒ identical state; save→load→continue byte-identical), 400 days headless in ~0.7–1.0 s, 0 errors/NaN, **5/5 seeds survive 400 days with 0 starvation days**.
- **Tests:** `npx tsc --noEmit` → 0 errors; `npm test` → **84/84 tests (7 files)** in 8.65 s (budget 90 s), including 6 decision-pacing/anti-deadlock tests.
- **Browser:** `browser-qa` → **62/62 checks, 0 console errors, 0 page errors** at 1600×900 and 1280×800 — full 8-step tour, skip/finish persistence, Help-replay, **tour now also auto-starts for returning players loading an existing save**, First Steps checklist updates, dock hidden during the tour (no card overlap), and "Let it pass" modal escape.
- **Performance:** 60 fps at 4× speed with 140–183 population; **autosave no longer blocks a frame** (0 long tasks, tick max 4.5–5 ms vs 36–37 ms / 50–80 ms long tasks before); **DPR2 terrain thrash gone** (0 evictions, `terrain.draw` 0.43 ms vs 9.14 ms); DPR2 render p95 **3.0 ms** (was 12.1 ms). Headless tick 0.9–2.5 ms.

**Remaining items are balance/polish only:** pop-10 day 70–79 vs target 25–50; era-2 pacing day 108–367 vs 150–250; `foodDays` display when pop=0; rail label truncation. No shipping blockers.

Commands run for this report:

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | **0 errors** |
| 2 | `npm test` (`vitest run`) | **84/84 tests passed, 7/7 files**, 8.65 s |
| 3 | `npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay` | 0 errors, 0 NaN, ≈0.9 s (2.2 ms/day) |
| 4 | `node tools/balance.mjs --days 400 --seeds demo,stone,river,harth,longrun-seed --difficulties balanced` | 5/5 seeds, **no extinction**, 0 starvation days, 1.78–2.21 ms/day (§5) |
| 5 | `node tools/browser-qa.mjs --url http://127.0.0.1:5299` | **62/62 checks passed**, 0 console errors, 0 page errors, 34 screenshots |
| 6 | `node tools/profile-fps.mjs 2 4 10000` | 59.9 fps, render p95 **3.0 ms**, ≤2 long tasks/10 s (§4) |
| 7 | `node tools/profile-render.mjs 1` / `2` | DPR1 unchanged; **DPR2 fixed: 0 evictions, draw 0.43 ms** (§4) |
| 8 | `node tools/profile-autosave.mjs 1 4 4000` and `2 4 4000` | **0 long tasks, 0 >30 ms tasks, tick max 4.5–5 ms**; serialise now runs in idle (§4) |
| 9 | `npx vitest run tests/decisions.test.ts` | 6/6 PASS (≤1 pending, gaps ≥20 d, 4 decisions/300 d, `__none` never soft-locks) |

---

## 2. Test matrix

### 2.1 Automated simulation tests (`npm test` — 84 tests, 7 files, 7.34 s)

| File | Tests | Focus | Result |
|---|---|---|---|
| `tests/content.test.ts` | 27 | `buildContent` + `validateContent` zero errors; quotas (54 res / 93 bld / 85 recipes / 95 tech / 45 events / 18 policies / 13 doctrines / 20 milestones / 20 achievements / 6 megaprojects / 14 sites); cross-refs; no cycles/dupes; every era except the final offers doctrines; tech-free start | PASS |
| `tests/determinism.test.ts` | 9 | identical seed+script ⇒ identical 100-day state; idle determinism; seed/difficulty divergence; RNG tuple restored; save→load lossless; **load→continue 60+60 d == continuous 120 d**; double save/load; save JSON has no cache | PASS |
| `tests/earlygame.test.ts` | 8 | 120-day scripted early game; population growth; actions take effect; food alive; no NaN; value ranges; idle 60 d; **zero-population** 40 d; tiny 48×48 world | PASS |
| `tests/longrun.test.ts` | 8 | 400-day autoplay under budget; no NaN; population sane; food economy alive; no negative stock; metrics recorded; structural invariants | PASS |
| `tests/economy.test.ts` | 7 | sawmill conversion consumes→produces; gathering extracts; storage caps; prices in 0.2×–6× band; market-gated trade conservation; every era-0 building placeable; many-citizen cap/NaN | PASS |
| `tests/regression.test.ts` | 19 | starting stock day 1; slow overflow bleed ≤15 %/day; no negative stock; research gated by `flags.auto_research`; autoTrade needs market; well adds water; growth/era budgets; bootstrap ladder (woodcutter ≤ d10–12, wood income ≤ d15); no wood deadlock; farm progression (farm ≤ d60, pop>10 ≤ d80, era1 ≤ d100); no permanent stall over 200 d; storage invariants; settle-expedition → ready flags → second settlement | PASS |
| `tests/decisions.test.ts` | 6 | **≤1 pending at all times**; **player-facing decision gaps ≥20 game days over 300 d** (chained/scheduled events defer to council); 4 decisions/300 d; all-unaffordable decision resolves via `__none`; `applyDecisionChoice('__none')` removes pending + history; unknown choice fails cleanly; resolving never throws | PASS |

Notable round-2 guarantees: chained/scheduled decisions can no longer slip past the era-based gap guard; no decision can ever soft-lock the game; "Let it pass" is always available and recorded in history.

### 2.2 Headless harness (`tools/simrun.ts`)

```bash
npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay --verbose
npx vite-node tools/simrun.ts -- --seeds demo,stone,river,harth --days 400 --autoplay --csv /tmp/runs.csv
npx vite-node tools/simrun.ts -- --seed demo --days 60 --autoplay \
  --assert-no-nan --assert-no-negative-stock --assert-starting-stock
```

Flags: `--seed/--seeds`, `--days`, `--autoplay`, `--difficulty`, `--until-pop`, `--report-every`, `--out <json>`, `--csv`, `--assert-no-nan`, `--assert-no-negative-stock`, `--assert-starting-stock`, `--hash`, `--verbose/--quiet`, `--max-errors`. Reports day/year/season/pop/foodDays/waterDays/morale/health/treasury/insight/era/techs/buildings/unemployment/homeless/pollution/biodiversity/births/deaths/events/ms-per-day plus a JSON summary (timeline, metrics series, milestones, autoplay stats/failure reasons). `tools/balance.mjs` runs the seeds × difficulties matrix; `tools/browser-qa.mjs` the browser matrix; `tools/profile-fps.mjs`, `tools/profile-render.mjs`, `tools/profile-autosave.mjs` the performance probes.

---

## 3. Browser / UI matrix

Command: `node tools/browser-qa.mjs --url http://127.0.0.1:5299` (production build, Chrome headless; fresh page reloads with clean `localStorage` for onboarding). **62/62 checks passed, 0 console errors, 0 page errors.**

| Check | Result |
|---|---|
| Boot `__FIRST_HEARTH__.ready`, `window.__game`, canvas, `contentErrors === 0` | PASS |
| Welcome overlay (`[data-act=begin]`) shows/dismisses; first-run tour auto-starts and is skippable for static checks | PASS |
| All 12 rail controls present (`[data-rail]`, incl. help/build/notices) | PASS |
| 9 panels open via keyboard shortcuts (Discoveries / Society / Market / People / The Long Record / Diplomacy / Expeditions / Wonders / Objectives) | PASS |
| Rail-click navigation (`[data-rail=codex|market|almanac]`) | PASS |
| Escape closes panels | PASS |
| 8 map overlays render (fertility, forest, water, pollution, beauty, deposits, roads, population) | PASS |
| Minimap present and sized (296×252) | PASS |
| Decision modal opens with real choices, costs, missing-cost hints, cause hints | PASS |
| Save → load restores exact tick; export → import JSON round-trip (~1.4 MB); localStorage key written | PASS |
| 1600×900: no overflow (scrollWidth 1600 = innerWidth); 1280×800: none horizontal/vertical | PASS |
| **Onboarding:** fresh storage → welcome → Begin → tour appears and **pauses** the world | PASS |
| **Onboarding:** 8 distinct steps, counters 1/8→8/8, final CTA "Begin your watch" | PASS |
| **Onboarding:** finishing persists (`fh-tour-v1=done`); no replay on reload; Skip persists | PASS |
| **Onboarding:** Help → "Replay the tour" re-opens the tour (paused) | PASS |
| **Onboarding:** First Steps checklist docked (7 steps) and updates on build (Gather food → done) | PASS |
| **Onboarding:** decision modal always offers "Let it pass"; clicking it resolves pending → 0 and records `__none` | PASS |
| **Onboarding (round 3):** First Steps dock is hidden while the tour is open — measured card/dock overlap = 0 (was 7 146 px²) | PASS |
| **Onboarding (round 3):** returning player with an existing save but no tour key still gets the tour (paused, step 1/8) | PASS |
| Onboarding at 1280×800: tour card fits and is visible | PASS |
| Console/page errors | **0** |

Screenshots (all in `shots/`): map 1600/1280, 9 panel shots + 1280 panel shots, rail shots, overlays, minimap, decision modal, 4×/100+ pop, **`final-hero.png`**, and onboarding: `qa-onboarding-welcome-1600x900.png`, `qa-tour-step1-1600x900.png`, `qa-tour-step4-build-1600x900.png`, `qa-tour-step6-codex-1600x900.png`, `qa-tour-step8-decisions-1600x900.png`, `qa-tour-replay-1600x900.png`, `qa-tour-1280x800.png`, `qa-first-steps-1600x900.png`, `qa-first-steps-updated-1600x900.png`, `qa-first-steps-1280x800.png`, `qa-decision-let-it-pass-1600x900.png`. Machine-readable: `shots/qa-browser-report.json` (includes `knownIssues`).

---

## 4. Performance

### 4.1 Frame rate — `profile-fps.mjs` (160–179 population, speed 4, 10 s window, dev server)

| Setting | FPS | render p95 | render max | long tasks >50 ms | tick avg/p95 |
|---|---|---|---|---|---|
| DPR1, no panels | **60** | 2.6 ms | 45.7 ms | 1 (initial/warmup) | 8.5 / 29 ms* |
| DPR1, Codex open | **59.7** | 1.8 ms | 49.5 ms | 1 | — |
| DPR2 (Retina sim), no panels — **round 3 re-run** | **59.9** | **3.0 ms** | 39.6 ms | 2 (warmup) | — |
| DPR2, Codex open | **59.8** | 6.5 ms | 43.0 ms | 1 | — |
| DPR2, Market open | **60** | 13.3 ms | 43.0 ms | 1 | — |
| DPR2, Society open | **60** | 12.0 ms | 42.7 ms | 1 | — |

\* first run's tick average includes the one-off setup tick; steady state ≈1.1–3.2 ms/tick. All runs pass the assertion set: fps ≥ 50, render p95 < 25 ms, ≤2 long tasks >50 ms. DPR2 panel rows are round-2 baselines; the DPR2 terrain fix (round 3) removes the thrash that dominated them, so those numbers are conservative.

### 4.2 Render phases — `profile-render.mjs`

| Metric | DPR1 (round-3 re-run) | DPR2 (round-3 re-run) |
|---|---|---|
| bakes / chunks / evictions (8 s) | 48 / 48 / **0** | 56 / 56 / **0** |
| `terrain.bake` avg (max) | 0.46 ms (1.3) | 0.47 ms (1.0) |
| `terrain.draw` avg (max) | **0.25 ms** (14.7) | **0.43 ms** (16.4) |
| bytes | 43.2 MB | 124.1 MB |
| FPS | 60 | 60 |

The fog/palette fix (round 2) is verified at DPR1, and the round-3 DPR2 fix is verified: bake resolution is capped at 1.55× for DPR ≥ 1.5 and the chunk memory budget scales at high DPR, so **evictions dropped from 2 498 to 0** and `terrain.draw` from **9.14 ms to 0.43 ms** (2 520 bakes → 56). DPR1 is unchanged (0.49 → 0.25 ms in this run's scenario) and both stay at 60 fps.

### 4.3 Autosave hitch — `profile-autosave.mjs` (pop 173, 25 buildings, speed 4, 4 s window)

| Metric | DPR1 (round-3 re-run) | DPR2 (round-3 re-run) |
|---|---|---|
| `serializeState` only (still exists, now in idle) | 37.2 ms (1.50 MB JSON) | 29.6 ms |
| `save()` at the moment of call | 33.3 ms | 29.2 ms |
| autosave localStorage `setItem` (idle) | 6.6 ms | 2.9 ms |
| tick max during window | **5.0 ms** (avg 2.5) | **4.5 ms** (avg 2.4) |
| long tasks in window | **0** | **0** |
| >30 ms tasks | **0** | **0** |

**FIXED and verified.** Autosave is now deferred to `requestIdleCallback` (4 s timeout fallback), runs off the animation frame, and the interval is 45 days. The ~30–37 ms serialisation still exists but completes in idle: **0 long tasks, 0 >30 ms tasks, tick max 4.5–5 ms** (previously 36.3–37.6 ms ticks with 50–80 ms long tasks). No action needed.

### 4.4 Browser matrix performance

| Measurement | Result |
|---|---|
| Headless tick throughput | 1.8–2.2 ms/day (~450–580 days/s); 400-day run ≈ 0.7–1.0 s |
| Browser FPS at 4× speed, 144 population | **60 fps**, `msPerTick` **0.94 ms** |
| Browser heap growth over 2000 ticks | **+5.3 MB** (round 3; notifications capped at 180, no runaway) |
| Save size | ~1.40 MB JSON; export/import round-trip exact |
| Layout | no overflow/clipping at 1600×900 or 1280×800; tour card, decision modal and panels fit at both sizes |

---

## 5. Balance matrix (5 seeds × 400 days, autoplay proxy, `balanced` — re-run after round-2 fixes)

| seed | era1 | era2 | pop10 | pop100 | pop200 | pop400 | final pop | peak | foodDays min | foodDays avg | waterDays avg | starving days | deaths | events | ms/day |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 73 | 152 | 73 | 19 | 26 | 76 | 76 | 76 | 4.1 | 10.6 | 3.4 | 0 | 0 | 13 | 2.14 |
| stone | 70 | 108 | 70 | 22 | 30 | 60 | 60 | 60 | 4.4 | 10.1 | 3.5 | 0 | 1 | 12 | 1.96 |
| river | 73 | 355 | 73 | 17 | 22 | 33 | 33 | 33 | 4.3 | 12.6 | 4.3 | 0 | 0 | 12 | 1.87 |
| harth | 79 | 367 | 79 | 17 | 19 | 33 | 33 | 33 | 3.0 | 16.3 | 4.5 | 0 | 0 | 17 | 1.78 |
| longrun-seed | 70 | 283 | 70 | 15 | 20 | 45 | 45 | 45 | 4.1 | 12.2 | 4.3 | 0 | 0 | 16 | 2.21 |

**Targets:** era1 ≈ day 40–80, era2 ≈ day 150–250, pop10 ≈ day 25–50, no starvation deaths, insight income >0/day by day 20.

**Findings (round 2):**
- **No extinction; 0 starvation days on all 5 seeds**; foodDays never hit 0 (min 3.0–4.4 vs 0.0 on 3/5 seeds before) and waterDays avg rose to 3.4–4.5 — the food/water pressure issues from round 1 are substantially improved.
- **Era 1 on target on all seeds (day 70–79).** Era 2: 108, 152, 283, 355, 367 — still high variance; 3/5 late. The round-2 decision-cadence change lowered event counts from 19–32 to **12–17 per 400 days**, which likely contributes to slower late-era progression (fewer decision bonuses). Balance note, not a regression in stability.
- **Pop-10 still late (day 70–79 vs 25–50)** — growth gated by beds + one worker per founder; unchanged by round-2 fixes.
- **Deaths 0/5 seeds** (stone: 1 death over 400 days), events 12–17, 1.8–2.2 ms/day.
- Difficulty/timer preamble unchanged: gentle/harsh shift era timings without extinctions.

---

## 6. Bugs & issues

### Fixed & verified in round 3 (follow-up fixes)

| Severity | Issue | Verification (re-run) |
|---|---|---|
| MED | **Autosave hitch**: serialisation (~23–28 ms, 1.4–1.5 MB) ran synchronously in the tick every 30 days → 30–37 ms tick and 50–80 ms long task | FIXED — autosave deferred to `requestIdleCallback` (4 s timeout fallback), off-frame, interval 45 days. `profile-autosave` DPR1/DPR2: **0 long tasks, 0 >30 ms tasks, tick max 4.5–5.0 ms**; serialise/write complete in idle (2.9–6.6 ms writes) |
| MED | **DPR2/Retina terrain chunk thrash**: 2 498 evictions / 2 520 bakes per ~8 s, 22 chunks cached, `terrain.draw` avg 9.14 ms (18× DPR1) | FIXED — bake resolution capped at 1.55× for DPR ≥ 1.5 and chunk budget scales at high DPR (200 MB class). `profile-render 2`: **evictions 0, bakes 56, chunks 56, bytes 124.1 MB, `terrain.draw` avg 0.43 ms**, 60 fps; DPR1 unchanged (0 evictions, 0.25 ms) |
| LOW | **Tour card overlapped the First Steps dock** (7 146 px² over 7 rows, text bleed at 1600×900, clipped at 1280×800) | FIXED — `.fh-firststeps` is hidden while `body.fh-tour-open`; browser matrix now measures computed-style dock visibility: **overlap = 0** (`shots/qa-tour-step1-1600x900.png`, `shots/qa-tour-1280x800.png`) |
| LOW | **Returning players could miss the tour**: auto-start only fired at `tick <= 1` | FIXED & verified — loading an existing save with no `fh-tour-v1` key auto-starts the tour (paused, step 1/8): `shots/qa-tour-returning-player-1600x900.png` |

### Fixed & verified in round 2 (Lead-reported root causes)

| Severity | Issue | Verification |
|---|---|---|
| HIGH | **Renderer lag / ~1 FPS**: fog-of-war rebuilt a ~758 k-px blurred canvas (~392 ms) on every explored-tile change; palette triggered a full terrain rebake on every 3 °C/weather change | `profile-render` DPR1: 0 evictions after warmup, `terrain.bake` avg 0.46 ms, `terrain.draw` avg 0.25 ms; `profile-fps`: 60 fps at 4× with 160+ pop, render p95 1.8–2.6 ms (DPR2 p95 now 3.0 ms after the round-3 chunk fix) |
| HIGH | **Decision overload/lock**: decisions every ~10 game days, up to 3 stacked modals, and all-choices-unaffordable decisions were unresolvable | Era-based gaps (45/38/32/28/24/22/20 d), max 1 pending, chained/scheduled deferral fixed after QA found a `!telegraphed` bypass, `__none` "Let it pass" on every modal. `tests/decisions.test.ts` 6/6; browser: 4 decisions/300 d, gaps ≥20, no soft-lock |
| MED | **No onboarding**: no guide or checklist for new players | 8-step spotlight tour (pauses world, skippable, persists, Help-replay) + First Steps checklist (7 steps, live completion). Browser onboarding suite 18/18 checks pass; screenshots captured at 1600×900 and 1280×800 |

### Fixed earlier in the QA cycle (still covered by regression tests)

| Severity | Issue | Status |
|---|---|---|
| HIGH | Starting stock destroyed on day 1 by storage overflow (55 > 40 cap) | FIXED — cap 180, overflow is a slow bleed (≤15 %/day) |
| HIGH | `autoTrade` sold starting stone/wood with no market built | FIXED — `hasMarket()` guard |
| HIGH | Research auto-completed techs without player action/flag | FIXED — gated behind `flags.auto_research === 1` |
| MED | Well water service effectively worker-scaled / no buffer | FIXED — ~8/day service with cistern buffer; regression test |
| MED | Save→load→continue diverged (derived settlement fields rounding) | FIXED — determinism suite proves byte-identical continuation |
| MED | Fibre bootstrap deadlock (only via forager recipe switch) | MITIGATED in autoplay; content UX still fragile (recommend berries recipe yields a little fibre) |

### Genuinely open (accepted balance/polish items)

| Severity | Issue | Owner | Repro / notes |
|---|---|---|---|
| LOW | **Population ramp too slow**: pop-10 day 70–79 vs target 25–50 | Lead / population tuning | `tools/balance.mjs`; growth gated by beds + 1-founder workforce |
| LOW | **Era-2 pacing variance**: day 108–367 vs target 150–250 (3/5 late); event count fell to 12–17/400 d after the decision-cadence fix | Lead / balance | same matrix |
| LOW | `foodDays` / `waterDays` show absurd values (e.g. 10 422) when population hits 0 (`foodDaysOf` divides by population) | Lead (`core.ts`) | cosmetic/metrics only |
| LOW | Rail labels truncated at 1600×900 (`EXPEDIT…`, `OBJECTI…`) | ui | `qa-map-1600x900.png`; cosmetic |
| INFO | Forced decision modals are not dismissible until answered or "Let it pass" (by design); automated UI must resolve them first | ui design | `qa-decision-modal-1600x900.png` |

No exploits found: no negative stock, no over-cap stock, no free housing/upkeep loops, no infinite loops in 400-day runs, market trades conserve stock/treasury, all era-0 buildings placeable on a fresh map, no dead mechanics in gathering/conversion recipes.

---

## 7. Accessibility & UX notes

- Welcome and tour use `role="dialog"`, `aria-modal="true"`, labelled cards; tour is fully keyboard-controllable (←/→ steps, Enter next, Esc skip, dots as `role="tab"` with labels), pauses the world, and persists across reloads; Help (?) and Objectives both offer "Replay the tour". The tour also auto-starts for returning players with an existing save who never took it.
- First Steps checklist is a labelled `aside` with `role="listitem"` rows, done/current/locked states, clickable steps and collapse/dismiss controls; it updates live from game state (verified by building a Forager's Camp in the browser) and is hidden (not merely covered) while the tour is open.
- Rail buttons expose `aria-label`, `aria-pressed`, tooltips and shortcuts (`T/S/M/P/C/D/E/W/O`, `B`, `Esc`, `?`); Escape closes panels. Reduced-motion and colourblind options exist in settings.
- Dark-on-dark contrast in dense tables (market rows, 1280×800) is acceptable but the lowest-contrast small text could get a contrast pass.
- Polish items: rail label truncation, some custom buttons lack a visible focus ring. (The tour-card/First Steps overlap found in round 2 is fixed in round 3.)

## 8. Known limitations of this QA pass

- Autoplay is a deterministic approximation of a competent player; absolute balance numbers are indicative, not exact. It resolves decisions via "Let it pass", so decision-driven bonuses are under-represented in balance runs.
- Browser/perf matrices were run against an isolated production build (`dist/` on :5299) to avoid HMR races. Profiling on the live dev server while `src/ui` was being edited produced transient `PAGEERROR` entries (HMR partial-module races); the stable-build matrix reports **0 console errors and 0 page errors**.
- DPR2 was simulated via Chrome `deviceScaleFactor`; real Retina GPU behaviour may differ slightly, though the CPU-side chunk-thrash finding is deterministic and DPR-driven.
- Renderer/UI aesthetics (art polish, animation feel, fog look) are only sanity-checked through screenshots, not judged by QA.
- The autosave probe isolates save cost with `decisionPause=false`; since the round-3 fix, autosave runs in `requestIdleCallback`, so the probe measures serialise cost and any residual long tasks rather than frame blocking (both now zero in the measured windows). Serialisation itself is still ~30–37 ms of main-thread work when the idle callback fires — invisible unless the idle budget is very small.
