# Round 2 — player-reported issues: root causes & fixes

Three player-facing problems were reported after the first delivery: severe frame
hitching ("feels like 1 FPS"), a flood of decision modals, and no onboarding.
Each was reproduced and measured in a real browser (headless Chrome via
puppeteer-core, DPR1 and DPR2/Retina simulacrum) before changing code.

## 1. Lag / hitching — measured root causes

| Cause | Evidence | Fix |
|---|---|---|
| Fog-of-war rebuilt a blurred 758k-pixel canvas on **every explored-tile change** | `tools/profile-render.mjs`: `bakeFog` avg **392 ms**, max 418 ms, 8 calls / 7 s → browser long tasks ~410 ms recurring (≈1 FPS feel) | Replaced per-tile path + two canvas blurs with a **soft vellum wash + incremental hole-punching** (destination-out radial brush) only for newly revealed tiles. No full-map path, no filters. |
| Palette invalidated **all baked terrain chunks** on any 3 °C / rain / storm change (weather changes every day) | `terrain.clear()` + `fog = null` on every palette change; bakes spiked daily | Palette now returns "changed" only for **season, snow band or freezing-line** changes; rain/storm/small temperature still update atmosphere but never wipe terrain. Fog is independent of weather. |
| Autosave serialised **1.5 MB JSON synchronously inside the tick** every 30 days | `tools/profile-autosave.mjs`: serialize **27.7 ms**, save total 28.3 ms; tick max 36 ms; long tasks 50–80 ms | Autosave deferred to `requestIdleCallback` (timeout fallback), interval 30→45 days. Measured: **0 long tasks, tick max 3.5 ms**. |
| DPR2/Retina terrain chunk cache thrashed (fixed 74 MB budget vs 4× chunk memory) | `profile-render 2`: 2 498 evictions / 2 520 bakes per ~8 s, draw avg 9.14 ms | Chunk bake resolution capped at 1.55× on high DPR + **DPR-aware memory budget** (200 MB at DPR≥1.5). Measured: **0 evictions, 64 chunks, draw avg 0.43 ms, 60 fps**. |

Result (1600×900, DPR2, 160+ population, speed 4, panels open): **60 fps**,
render p95 6.5–13.3 ms, ≤1 long task per 10 s (warm-up). Initial measured
freeze pattern (410 ms every ~0.8 s) is gone.

## 2. Decisions — measured root causes

| Cause | Evidence | Fix |
|---|---|---|
| Decisions could arrive every **10 game days** = ~6 real seconds at normal speed | `DECISION_MIN_GAP = 10` in `events.ts`; playtest saw 3 modals inside the first minute | Era-scaled gap **60/50/42/34/28/24/20 days**; gentle opening: no decision before day 10, no serious event before day 30. |
| Up to **3 decisions could queue**; resolving one opened the next immediately | `LIMITS.maxPendingDecisions = 3`, decision rolling ignored pending | **max 1 pending**; new decision-bearing events never start while one is open. |
| Chained/scheduled events bypassed the pacing gate | `fireEvent(..., telegraphed=true)` skipped the too-soon check; QA test caught a 5-day decision gap | Telegraphed/chained decision events now defer to the **council auto-resolution** when too soon. |
| A decision whose choices all cost resources you lacked **could not be resolved** ("Missing: Meat" forever) | `applyDecisionChoice` returned failure and left pending; UI had no escape when choices existed | Every modal now has an always-enabled **"Let it pass"** ('__none') escape that removes the pending decision, records history and applies a small morale/stability cost; all-unaffordable events are auto-resolved by the council instead of opening a modal. |

Verified: `tests/decisions.test.ts` 6/6 (≤1 pending, gaps ≥20 days over 300 days,
`__none` clears pending/history, all-unaffordable never soft-locks). Live browser
at speed 2: first decision day 12, second day 61 — **2 decisions in 70 s** of real
play (previously 3+ in the first minute and modals every few seconds).

## 3. Onboarding — delivered

- **8-step spotlight Game Tour** (`src/ui/tour.ts`): welcome → what the game is →
  settlement/map → HUD survival clocks → build menu (opens Gathering) → speed →
  Codex (opens it) → First Steps/decisions. Pauses the world, keyboard + Esc/Skip,
  persists `fh-tour-v1`, replayable from Help (?) and Objectives, and now also
  auto-starts for players **loading an existing save** who never saw it.
- **First Steps checklist** (`src/ui/first-steps.ts`): 7 live steps (camp, shelter,
  well, discovery, farm with Cultivation hint, 5 souls, granary), progress meter,
  clickable steps that open the correct UI, collapse/dismiss persisted, auto
  collapses to "First steps complete".
- Welcome overlay now previews the tour; decision modal header says "The world
  waits for your word"; speed control shows PAUSED / 1×–4× clearly.

Verified in browser with cleared storage: welcome → Begin → tour appears paused at
1/8 → all 8 steps → "Begin your watch" persists and resumes; Help replay works;
First Steps updates after building; Let-it-pass resolves; 0 console errors;
1600×900 and 1280×800 no overflow.

## How to see the changes

1. Hard-refresh the game page (Ctrl/Cmd+Shift+R) at `http://127.0.0.1:5280`.
2. The tour starts automatically (once). If you missed/closed it, use the **?**
   Help button → "Replay the tour".
3. Existing saves are compatible: decision pacing, Let-it-pass and performance
   fixes apply immediately on load; the tour appears once because your profile
   has not completed it yet.
