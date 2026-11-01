# QA NOTES — tools & how to verify First Hearth

Quick reference for anyone running QA on First Hearth. Full results: `docs/QA-REPORT.md`.

## Commands

```bash
npx tsc --noEmit                  # typecheck (expect 0)
npm test                          # vitest suite (expect 84/84, ~7s; includes decisions + onboarding regressions)
npm run sim -- --seed demo --days 400 --autoplay --verbose   # one headless run
npx vite-node tools/simrun.ts -- --seeds demo,stone,river,harth,longrun-seed --days 400 --autoplay
npx vite-node tools/simrun.ts -- --seed demo --days 60 --autoplay \
  --assert-no-nan --assert-no-negative-stock --assert-starting-stock --csv /tmp/run.csv
node tools/balance.mjs --days 400 --seeds demo,alpha,beta,gamma,delta --difficulties balanced,gentle,harsh
node tools/browser-qa.mjs --url http://127.0.0.1:5280      # browser matrix (needs running app)
npm run build && npx vite preview --port 5299              # stable build for browser QA

# Performance probes (against the dev server, window.__game instrumentation)
node tools/profile-fps.mjs 1 4 10000            # DPR1, speed 4, 10s (~160 pop)
node tools/profile-fps.mjs 2 4 10000 market     # DPR2 + panel open (codex|market|society)
node tools/profile-render.mjs 1                 # render phases (terrain bake/fog/deco) DPR1
node tools/profile-render.mjs 2                 # DPR2/Retina — watch evictions/bakes
node tools/profile-autosave.mjs 1 4 4000        # autosave hitch (serialize + setItem + long tasks)
```

## Files

| Path | Purpose |
|---|---|
| `tools/simrun.ts` | Primary headless simulation runner: deterministic ticks, autoplay, assertions, CSV/JSON output, multi-seed matrix |
| `tools/autoplay.ts` | Deterministic "competent player" driver used by simrun and tests (both must stay in sync) |
| `tools/balance.mjs` | Seeds × difficulties balance matrix → JSON + table |
| `tools/browser-qa.mjs` | Full browser matrix: boot, welcome, 8-step tour (pause, skip/finish persistence, Help replay), First Steps checklist, panels (keyboard + `[data-rail]`), overlays, minimap, decision modal + "Let it pass", save/load/import/export, 1600×900 & 1280×800 layout, 4× FPS with 100+ pop, heap growth, hero shot. Emits `knownIssues` for non-blocking visual defects. |
| `tools/profile-fps.mjs` | FPS/render/tick profiling at a given DPR + speed + duration, optional open panels; asserts fps ≥50, render p95 <25 ms, ≤2 long tasks >50 ms |
| `tools/profile-render.mjs` | Render-phase breakdown (terrain bake/chunk/fog/deco/actors) with eviction/bake counters |
| `tools/profile-autosave.mjs` | Measures `serializeState` vs `save()` sync cost, localStorage write time, tick spikes and long tasks at the 30-day autosave boundary |
| `tools/shot.mjs` | Original single-screenshot smoke tool |
| `shots/` | Screenshots + `qa-browser-report.json` (machine-readable browser results) |

## Conventions

- QA never edits `src/**`. Bugs are reported to the Lead with file/line + proposed fix; tests pin regressions.
- Tests use `tests/helpers.ts`: cached content, `newGame`, `runAutoplay`, `runIdle`, `canonical/hashState`, `nanPaths`, `stateDiff` (cache-stripped, key-sorted comparison), spill-safe assertions.
- `canonical()` strips the transient cache and sorts JSON keys: JSON key order is not meaningful, data is.
- Save/load equivalence: derived settlement counters (`storageUsed`, `foodDays`, `waterDays`, `housingDays`, `roadAccess`) are recomputed by `rebuildCache`; tolerance for those paths only in the "load point" test, exact equality everywhere else (and exact equality after continuing to tick).
- Autoplay must remain deterministic: no `Math.random`, no real time. Regressions are measured against the same script.
- Browser runs should be done against a production build (`dist/`) while teammates are editing, otherwise HMR navigations invalidate a run. Matrix scripts pass `--url`.
- Keep `npm test` under ~90 s; current runtime ~7 s.
- Onboarding/tour checks need a **fresh localStorage** (browser-qa clears it and reloads on a dedicated page): welcome → `[data-act=begin]` → tour auto-starts and pauses. Tour keys: `fh-tour-v1` = `done`; First Steps pref key `fh-firststeps-v1`. Help → "Replay the tour" (`[data-act="replay-tour"]`) is covered.
- Decision pacing regressions live in `tests/decisions.test.ts`: ≤1 pending, ≥20-day player-facing gaps over 300 d (chained/scheduled events must defer to the council), `__none` escape must remove pending + add history and never throw.
- Profiling on the live dev server while `src/ui` is being edited can log transient HMR `PAGEERROR`s; treat only stable-production-build errors as real. Use `tools/browser-qa.mjs --url <preview>` for the authoritative console-error count.
- Autosave is now deferred (`requestIdleCallback`, 45-day interval): `profile-autosave` should report **0 long tasks / 0 >30 ms** and tick max ~4–5 ms. Serialise still happens (~30 ms) but in idle, not in a frame.
- Terrain at DPR≥1.5 is capped at 1.55× bake resolution with a scaled chunk budget: `profile-render 2` should report **0 evictions**, ~56 bakes/chunks and `terrain.draw` ≲1 ms. Any evictions >0 at DPR2 is a regression.
- Tour hides `.fh-firststeps` via `body.fh-tour-open`; the browser matrix asserts computed-style visibility (not just rects) when checking overlap, and checks that a returning player (existing save, no `fh-tour-v1`) still gets the tour.
