# FIRST HEARTH — QA REPORT

**Date:** 2026-10-31 → 2026-11-01 (Asia/Saigon)
**Environment:** macOS (arm64), Node v26.5.0, Vite 7.1, TypeScript 5.9, vitest 3.2.7, puppeteer-core 24.10 driving system Chrome (headless), deterministic simulation (`GameState.seed`), dev server `http://127.0.0.1:5280`, QA browser runs against a production build served at `http://127.0.0.1:5299` (isolated preview so in-flight HMR edits cannot invalidate a matrix run).
**Scope:** headless harness (`tools/simrun.ts`), test suite (`tests/**`), deterministic/soak runs, balance matrix, full browser/UI matrix, accessibility/UX notes.

---

## 1. Final verdict

**PASS for internal/demo ship.** The simulation is deterministic (same seed + same action script ⇒ identical state; save→load→continue is byte-identical), runs 400 days headless in ~0.7–1.0 s with zero errors and zero non-finite numbers, and the browser app boots, renders and remains console-error-free across 1600×900 and 1280×800. 78/78 automated tests pass and 43/43 browser checks pass with 0 console/page errors. There are **no P0/blocking bugs**. Balance targets are partially met: era-1 pacing is inside the 40–80-day target band on all 5 seeds, but population-10 arrives late (day 70–79 vs target 25–50), era-2 pacing is variable (day 115–370 vs target 150–250), and late-game food/water pressure produces starvation windows (no extinctions in the final matrix). Recommend shipping with follow-up balance tuning (see §6).

Commands run for this report:

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` | **0 errors** |
| 2 | `npm test` (`vitest run`) | **78/78 tests passed, 6/6 files**, 5.26 s (well under the 90 s budget) |
| 3 | `npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay` | 0 errors, 0 NaN, 400 days in ~0.9 s (2.2 ms/day) |
| 4 | `node tools/balance.mjs --days 400 --seeds demo,stone,river,harth,longrun-seed --difficulties balanced` | 5/5 seeds, **no extinction**, 1.65–2.41 ms/day (table §5) |
| 5 | `node tools/browser-qa.mjs --url http://127.0.0.1:5299` | **43/43 checks passed**, 0 console errors, 0 page errors, 21 screenshots |

---

## 2. Test matrix

### 2.1 Automated simulation tests (`npm test`)

| File | Tests | Focus | Result |
|---|---|---|---|
| `tests/content.test.ts` | 27 | `buildContent` + `validateContent` zero errors; content quotas (54 res / 93 bld / 85 recipes / 95 tech / 45 events / 18 policies / 13 doctrines / 20 milestones / 20 achievements / 6 megaprojects / 14 sites); cross-refs; no cycles; no duplicate ids; every era except the final offers doctrines; trade-free start buildable | PASS |
| `tests/determinism.test.ts` | 9 | identical seed+autoplay ⇒ identical 100-day state; idle determinism; seed/difficulty divergence; RNG tuple restored by save; save→load lossless; **load→continue 60+60 d equals continuous 120 d**; double save/load; save JSON has no cache | PASS |
| `tests/earlygame.test.ts` | 8 | scripted 120-day early game survives, population grows, actions take effect, food economy alive, no NaN, value ranges; idle 60 d; **zero-population** 40 d; tiny 48×48 world 60 d | PASS |
| `tests/longrun.test.ts` | 8 | 400-day autoplay under budget, no NaN, population sane, food economy not dead, no negative stock, metrics series recorded, structural invariants, snapshot canonicalises | PASS |
| `tests/economy.test.ts` | 7 | sawmill conversion consumes inputs→planks; gathering extracts from world; storage caps respected; prices in 0.2×–6× band; trade requires market and conserves stock/treasury; every era-0 building placeable; many-citizen cap/NaN | PASS |
| `tests/regression.test.ts` | 19 | starting stock preserved day 1; overflow is a slow bleed (≤15 %/day); no negative stock; research gated behind `flags.auto_research`; autoTrade does nothing without market; well adds water; growth/era budgets; **bootstrap ladder (woodcutter ≤ day 10–12, wood income ≤ day 15)**; no wood deadlock; **farm progression** (farm ≤ d60, pop>10 ≤ d80, era1 ≤ d100); no permanent resource stall over 200 d; storage invariants; settle-expedition → ready flags → second settlement | PASS |

Notable guarantees now pinned by tests: *no auto tech completions without the flag*, *no market trade without a market*, *starting resources survive day 1*, *storage overflow is a slow bleed*, *wood/food bootstrap cannot permanently deadlock*, *a settle party's ready flags can always found a second settlement*.

### 2.2 Headless harness (`tools/simrun.ts`)

Primary team verification tool. Usage:

```bash
npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay --verbose
npx vite-node tools/simrun.ts -- --seeds demo,stone,river,harth --days 400 --autoplay --csv /tmp/runs.csv
npx vite-node tools/simrun.ts -- --seed demo --days 60 --autoplay \
  --assert-no-nan --assert-no-negative-stock --assert-starting-stock
```

Features: `--seed/--seeds`, `--days`, `--autoplay`, `--difficulty`, `--until-pop`, `--report-every`, `--out <json>`, `--csv`, `--assert-no-nan`, `--assert-no-negative-stock`, `--assert-starting-stock`, `--hash`, `--verbose/--quiet`, `--max-errors`. Prints day/year/season/pop/foodDays/waterDays/morale/health/treasury/insight/era/techs/buildings/unemployment/homeless/pollution/biodiversity/births/deaths/events/ms-per-day plus a JSON summary (timeline + daily metrics series + milestones + autoplay stats/failure reasons). Exit code 0 = clean. Multi-seed mode prints a comparison table.

`tools/balance.mjs` wraps it into a seeds × difficulties matrix and `tools/browser-qa.mjs` performs the browser matrix below. Both are deterministic and re-runnable.

---

## 3. Browser / UI matrix

Command: `node tools/browser-qa.mjs --url http://127.0.0.1:5299` (production build, Chrome headless). **43/43 checks passed, 0 console errors, 0 page errors.**

| Check | Result |
|---|---|
| Boot `__FIRST_HEARTH__.ready`, `window.__game` exposed, canvas rendered, `contentErrors === 0` | PASS |
| Welcome overlay (`[data-act=begin]`) shows and dismisses | PASS |
| All 11 rail controls present (`[data-rail]`: build, codex, society, market, people, almanac, diplomacy, expeditions, wonders, objectives, notices) | PASS |
| 9 panels open via keyboard shortcuts (Discoveries / Society / Market / People / The Long Record / Diplomacy / Expeditions / Wonders / Objectives) | PASS |
| Rail-click navigation: `[data-rail=codex]`, `[data-rail=market]`, `[data-rail=almanac]` | PASS |
| Escape closes open panels (with any forced decision modal cleared first) | PASS |
| 8 map overlays render (fertility, forest, water, pollution, beauty, deposits, roads, population) | PASS |
| Minimap present and sized (296×252) | PASS |
| Decision modal opens with 2–3 real choices, costs, missing-cost hints, cause hints | PASS |
| Save → load restores exact tick; export → import JSON round-trip (~1.4 MB) | PASS |
| localStorage save key written | PASS |
| 1600×900: no horizontal overflow (scrollWidth 1600 = innerWidth) | PASS |
| 1280×800: no horizontal/vertical overflow (1280×800) | PASS |
| Console/page errors | **0** |

Screenshots (all in `shots/`): `qa-map-1600x900.png`, `qa-map-1280x800.png`, `qa-panel-<id>-1600x900.png` (9), `qa-panel-{almanac,market}-1280x800.png`, `qa-rail-{codex,market,almanac}-1600x900.png`, `qa-overlay-{fertility,deposits}-1600x900.png`, `qa-decision-modal-1600x900.png`, `qa-4x-100pop-1600x900.png`, `qa-minimap-1600x900.png`, **`final-hero.png`** (developed valley, 1600×900). Machine-readable report: `shots/qa-browser-report.json`.

---

## 4. Performance

| Measurement | Result |
|---|---|
| Headless tick throughput | **2.0–2.4 ms/day** (~420–580 days/s) at mid-game, 400-day run ≈ 0.7–1.0 s |
| Browser FPS at 4× speed, **140 population** (`window.__game`, cohorts injected + 60 headless ticks) | **60 fps** (rAF-capped), `msPerTick` **2.01 ms** |
| Browser heap growth over 2000 ticks | **+36–38 MB** (notifications capped at 180; no runaway) |
| Save size | ~1.40 MB JSON for a mid-game state; export/import round-trip exact |
| 1280×800 and 1600×900 layout | no overflow/clipping; decision modal centred and fully visible at both sizes |

---

## 5. Balance matrix (5 seeds × 400 days, autoplay = competent-player proxy, `balanced`)

| seed | era1 | era2 | pop10 | pop100 | pop200 | pop400 | final pop | peak | foodDays min | foodDays avg | waterDays avg | starving days | deaths | events | ms/day |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| demo | 76 | 135 | 76 | 22 | 28 | 41 | 41 | 41 | 0.0 | 7.7 | 3.0 | 93 | 0 | 25 | 2.10 |
| stone | 73 | 271 | 73 | 20 | 24 | 39 | 39 | 39 | 4.4 | 12.0 | 3.2 | 0 | 0 | 25 | 1.93 |
| river | 76 | 115 | 76 | 19 | 43 | 56 | 56 | 56 | 0.0 | 8.6 | 2.5 | 12 | 0 | 32 | 2.17 |
| harth | 79 | 124 | 79 | 18 | 35 | 65 | 65 | 65 | 0.0 | 8.5 | 2.7 | 15 | 0 | 27 | 2.41 |
| longrun-seed | 70 | 370 | 70 | 17 | 23 | 30 | 30 | 30 | 4.3 | 15.1 | 3.7 | 0 | 0 | 19 | 1.65 |

**Targets** (task spec): era1 ≈ day 40–80, era2 ≈ day 150–250, pop10 ≈ day 25–50, no starvation deaths, insight income >0/day by day 20.

**Findings:**
- **No extinction on any seed; 0 deaths in all five runs.** No NaN, no errors, no negative stock, no storage-cap violations.
- **Era 1: on target on all seeds (day 70–79).** Era 2: 115, 124, 135 (early vs the 150–250 band) but 271 and 370 (late) — high variance.
- **Pop-10 is consistently late (day 70–79 vs 25–50).** Growth is gated by spare beds + one worker per founder; the ladder now reaches lean-to→forager→woodcutter→well→stone→granary→farm, but the settlement takes ~10 weeks to double.
- **Food pressure:** `foodDays` averages 7.7–15.1 but dips to 0 on 3/5 seeds; starving-days 0–93. No deaths, but the food base is thin at 40–65 population (many huts vs 1 farm / several foragers). The autoplay now scales food buildings with population (1 food building per ~10 people) which removed a real extinction observed at day 386 on `longrun-seed` (pop 86 → 0 in one week with only 1 farm); post-fix that seed ends at pop 30, 0 deaths.
- **Water pressure:** `waterDays` avg 2.5–3.7 (min 0); cistern buffers cap well output (~9.5 water at pop 1); wells are the main service and pressure grows late-game. No thirst deaths observed, but there is no safety margin.
- **Insight/events:** first tech day 1 on every seed, 19–32 events per 400 days (~1 per 13–21 days), insight income sufficient for 36–49 techs by day 400. Event cadence is healthy and no repeated-event storms in the final runs.
- **Difficulties (earlier 15-run matrix):** gentle/harsh shift era timings (era1 67–94, era2 112–238) without extinctions; harsh shows higher starving-days (0–25) and lower peak population — consistent with the intended difficulty curve.

---

## 6. Bugs & issues

### Fixed during the QA cycle (verified by regression tests)

| Severity | Issue | Evidence → fix | Status |
|---|---|---|---|
| HIGH | Starting stock destroyed on day 1: 55 units > 40 storage cap lost ~15 units (wood 24→9.6) | `simrun` day-1 trace | FIXED — cap 60→**180**, overflow is now a **12 %-of-excess-per-day bleed** (`logistics.enforceStorageCap`); `regression: starting economy` passes |
| HIGH | `autoTrade` sold starting stone/wood before any market existed | day-1 system-delta trace | FIXED — `hasMarket()` guard in `economy.ts`; regression test passes |
| HIGH | Research auto-completed techs with no player action / no flag | `techs=6` at day 20 idle | FIXED — gated behind `flags.auto_research === 1`; regression test passes; autoplay sets the flag |
| MED | Well water service effectively worker-scaled / low buffer; water store stalled at ~2 days | `waterDays` stuck near 0 with a completed well | FIXED — service reworked (well now ~8/day, cistern buffer capped `max(40, pop*2+20)`); regression test asserts water added ≥ 60 % of service and `waterDays > 3` |
| MED | Save→load→continue diverged from a continuous run (RNG/world drift) because `rebuildCache` recomputed `settlement.storageUsed/foodDays/waterDays` at full precision while systems round them | `tests/determinism` divergence at char 60, RNG tuple mismatch | FIXED — determinism suite now proves **byte-identical 60+60 vs 120-day continuation** |
| MED | Fibre bootstrap deadlock: only early fibre source is switching a foragers' camp to `gather_fiber`; default recipe is berries, so huts/granaries/2nd forager could soft-lock a player | autoplay needed explicit recipe management to escape | MITIGATED in autoplay (recipe switching); **content UX still fragile** — recommend berries recipe yielding a little fibre or `hut` fibre cost 1 |

### Genuinely open issues

| Severity | Issue | Owner | Notes / repro |
|---|---|---|---|
| MED | **Population ramp too slow**: pop-10 day 70–79 vs target 25–50 on all seeds | Lead / population tuning | `node tools/balance.mjs --days 400 --seeds demo,stone,river,harth,longrun-seed`; growth gated by beds + 1-founder workforce |
| MED | **Late-game water pressure**: avg waterDays 2.5–3.7, min 0; no buffer against a dry spell | sim-industry / content | 400-day runs; consider larger cistern buffer or aqueduct priority from era 2 |
| LOW | **Era-2 pacing variance** (day 115–370 vs 150–250) | Lead / balance | same matrix; 2/5 seeds late |
| LOW | **Thin food base / starvation windows**: starving-days 0–93, foodDays hits 0 on 3/5 seeds though nobody died in the final matrix | balance / population | tracked by `longrun` + matrix; autoplay food-scaling added, sim-side review of consumption vs yields still worthwhile |
| LOW | `foodDays`/`waterDays` become absurd values (e.g. 10422) when population hits 0 (`foodDaysOf` divides by population) | Lead (`core.ts`) | cosmetic/metrics only; reproduced in an early extinction run |
| LOW | Rail labels truncated at 1600×900 (`EXPEDIT…`, `OBJECTI…`) | ui | `qa-map-1600x900.png`; cosmetic |
| INFO | Forced decision modals are not dismissible (no close) — by design; keyboard/panel interaction is blocked while one is open (automation must resolve it first) | ui design | `qa-decision-modal-1600x900.png`; not a bug, but worth a hint in help |

No exploits found: no negative stock, no over-cap stock, no free housing/upkeep loops, no infinite loops in 400-day runs, market trades conserve stock/treasury, all era-0 buildings are placeable on a fresh map, no dead mechanics observed in gathering/conversion recipes.

---

## 7. Accessibility & UX notes

- Welcome overlay uses `role="dialog" aria-modal="true"`; rail buttons expose `aria-label`, `aria-pressed`, tooltips and keyboard shortcuts (`T/S/M/P/C/D/E/W/O`, `B`, `Esc`, `?`); panels receive focus and Escape closes them; decision modal is keyboard-clickable and non-dismissible by design.
- Settings expose reduced-motion and colourblind options in `DEFAULT_SETTINGS`; effects/particles are render-only.
- Dark-on-dark contrast in dense tables (market rows, 1280×800) is acceptable but the lowest-contrast text is small; consider a contrast pass on `.fh-faint` in tables.
- Map is a diorama with fog: at dusk/atmosphere the map can read quite dark behind modals; panels are readable but the hero shot benefits from a paused/clear state.
- Rail label truncation (above) and missing visible focus rings on some custom buttons are the main polish items.

## 8. Known limitations of this QA pass

- Autoplay is a deterministic approximation of a competent player (opening ladder, food/housing scaling, recipe management, decisions/doctrines, roads); it is not a human, so absolute balance numbers are indicative, not exact.
- Browser checks ran against an isolated production preview (`dist/` on :5299) to avoid HMR races while teammates edited `src/**`; the live dev server on :5280 was smoke-tested separately (same app, 200 OK, zero console errors).
- Renderer visual quality (art polish, animation feel, fog/aesthetic) is only sanity-checked via screenshots, not judged by QA.
- The 15-run difficulty matrix was executed on an earlier autoplay revision; the authoritative final numbers are the 5-seed `balanced` table in §5.
