# FIRST HEARTH — Architecture & Studio Contracts

> Read `src/sim/types.ts` first. It is the single source of truth for state and content schemas.
> Every module must compile under `tsc --noEmit`. No `any` in persisted state.

## Project

A deterministic, data-driven, living-world civilization simulation. TypeScript + Vite.
Rendering: Canvas 2D isometric. UI: DOM/CSS overlay. Simulation: pure TS, headless.

Commands:
- `npm run dev` — dev server on http://127.0.0.1:5280
- `npm run typecheck` — tsc
- `npm test` — vitest
- `npm run shot -- --url http://127.0.0.1:5280 --out shots/x.png --wait 4000`
- `node tools/simrun.mjs --seed demo --days 500` — headless long-run harness (QA owns)

## Golden rules

1. **Determinism.** Simulation code must never call `Math.random()`, `Date.now()`, `performance.now()`,
   `setTimeout`, or read the DOM. Use `ctx.rng()` and tick counters only. Cosmetic render/UI code may use randomness freely.
2. **Persistence.** Only `GameState` fields are saved. Never mutate `state.cache` in a way that affects simulation
   without recomputing it on load (cache is rebuilt by `rebuildCache` in `state.ts`).
3. **Content is data.** Systems must not hard-code building/tech/event ids. All content lives in `src/sim/content/`.
4. **No cross-imports.** `sim/` never imports from `render/` or `ui/`. `render/` and `ui/` read simulation state but never mutate it except through `actions.ts`.
5. **Helpers before duplication.** Use `core.ts` helpers for stock, tiles, modifiers, techs, cost payment.
6. **Own your files.** Only edit files in your assigned scope. Need a change outside it? Message the Lead.
7. **Verify, don't assume.** Typecheck + tests before claiming done. The Lead runs visual verification.
8. **No placeholder content shipped.** Anything marked TODO in a deliverable must be reported.

## Tick pipeline (1 tick = 1 day)

`src/sim/tick.ts` runs, in order, the `SYSTEM_ORDER` array:

1. `beginTick` (state.ts helper) — advance tick, weather/season, aggregate modifiers, decay temp modifiers.
2. `world.weather` — seasons, temperature, rain, drought, storms, forecasts.
3. `world.ecology` — forest regrowth, soil fertility, wildlife, pollution dispersal, biodiversity, climate drift.
4. `world.disasters` — floods, blight, wildfire risks (warn before fire), earthquake.
5. `civ.buildings` — construction progress, condition/upkeep, passive effects, repair, demolition finish.
6. `civ.jobs` — assign citizens to job slots by priority & skill; unemployment; profession updates.
7. `civ.production` — recipes, extraction from tiles, services (water/health/education/culture), energy, pollution emission.
8. `civ.logistics` — storage caps, spoilage, road access, inter-settlement transfer, caravans.
9. `civ.population` — consumption, needs, health, morale, aging, education, births, deaths, migration, LOD folding.
10. `civ.society` — policies upkeep, classes, approval, stability, crime, culture, festivals.
11. `civ.research` — insight generation, era progression, doctrine offers, serendipity.
12. `civ.economy` — prices, neighbour trade, trade routes, offers.
13. `civ.events` — warnings, scheduled events, trigger roll, decision resolution, chains.
14. `civ.exploration` — expeditions, fog reveal, site visits, neighbour discovery.
15. `civ.neighbors` — neighbour simulation, diplomacy drift, raids.
16. `civ.objectives` — milestones, achievements, era conditions, megaprojects, tutorial progression.
17. `civ.metrics` — daily metrics sampling, chronicle upkeep, autosave flag.

Systems receive `SimContext` (see types). They must be robust when population is 0, no buildings, no content entries, etc.

## Helper API (core.ts)

```ts
tileIndex(w,x,y); tileAt(w,x,y); inBounds(w,x,y)
yearOf(tick); seasonOf(tick); dayOfSeason(tick); dateLabel(tick) // "Year 3 · Autumn · Day 9"
capitalOf(s); settlementById(s,id); livingCitizens(s); adultsOf(s); citizensOfSettlement(s,id)
hasTech(s, techId); techAvailable(s, c, techId); eraUnlocked(s, era)
buildingDef(c, b); buildingById(s,id); activeBuildingsOf(s, settlementId)
stockOf(settlement,res); stockTotal(settlement); storageSpace(settlement,c)
addStock(settlement,res,amount,max?) -> number actually added
removeStock(settlement,res,amount) -> number actually removed
canAfford(settlement,cost); payCost(settlement,cost); refundCost(settlement,cost)
modOf(ctx, settlementId, key): number   // global + settlement + policy + event modifiers, additive
modsFor(ctx, settlementId): ModifierDelta
neighbors4(w,idx); tilesInRadius(w, idx, r); forEachTileInRadius(w, idx, r, cb)
distance(w, x1,y1,x2,y2)
clamp, lerp, smoothstep, fmt (number formatting)
collectModifiers(ctx): ModifierDelta  // recompute global mods
settlementModifiers(ctx, st): ModifierDelta // from its buildings
```

`modOf` returns the **additive fraction**; multiply as `1 + modOf(...)`.

## Content authoring

See `docs/CONTENT-AUTHORING.md` for metric keys, effect semantics, balance targets and quotas.

## App / renderer / UI contracts

`src/app.ts` exports `GameApp`:

```ts
class GameApp {
  state: GameState; content: Content; view: ViewState;
  running: boolean; speed: number;
  init(): Promise<void>;                       // boots renderer+ui, loads save if available
  newGame(seed?: string, difficulty?): void;
  save(slot?: string): void; load(slot?: string): boolean; exportSave(): string; importSave(json): void;
  tickOnce(): void; advance(dtMs: number): void;  // fixed-timestep accumulator
  setSpeed(speed: number): void; togglePause(): void;
  selectTile(x,y): void; selectBuilding(id): void; selectCitizen(id): void;
  on(evt: 'tick'|'action'|'selection'|'decision'|'notification'|'newgame'|'loaded', cb): () => void;
  emit(...); toast(text, severity?, icon?): void;
  refreshUI(): void;
}
```

`src/render/renderer.ts` exports:

```ts
class WorldRenderer {
  constructor(app: GameApp, canvas: HTMLCanvasElement);
  render(timeMs: number): void;
  resize(): void;
  screenToTile(px: number, py: number): { x: number; y: number } | null;
  tileToScreen(x: number, y: number): { x: number; y: number };
  centerOnTile(x: number, y: number, zoom?: number): void;
  zoomAt(px: number, py: number, delta: number): void;
  pan(dx: number, dy: number): void;
  invalidateTerrain(tiles?: number[]): void;
  setOverlay(mode: OverlayMode): void;
  get camera(): { x: number; y: number; zoom: number };
  destroy(): void;
}
```

`src/ui/index.ts` exports `createUI(app: GameApp): UIController` with
`{ refresh(): void; destroy(): void; }`. UI may attach listeners to `app` events and read `app.state` directly.
UI must never import `render/` implementation; it may use `app.renderer` if the Lead exposes it.

## Save format

`save.ts` version 1. `serializeState` strips `cache`, converts `explored` Uint8Array to base64 string.
`deserializeState` rebuilds typed arrays and calls `rebuildCache`. Save migrations live in `save.ts`.

## File ownership (write scopes)

| Area | Owner |
|---|---|
| `src/sim/types.ts`, `rng.ts`, `core.ts`, `config.ts`, `tick.ts`, `state.ts`, `actions.ts`, `save.ts`, `metrics.ts`, `app.ts`, `main.ts`, `index.html`, base CSS | Lead |
| `src/sim/world/*`, `src/sim/systems/world/*` | world-sim |
| `src/sim/systems/civ/buildings.ts`, `production.ts`, `logistics.ts`, `economy.ts` | sim-industry |
| `src/sim/systems/civ/population.ts`, `jobs.ts`, `society.ts`, `research.ts`, `events.ts` | sim-society |
| `src/sim/content/*` | content-econ / content-lore |
| `src/render/*` | renderer |
| `src/ui/*`, `src/styles/*` (except `base.css` tokens owned by Lead) | ui |
| `tests/*`, `tools/*`, `docs/QA-*.md` | qa |

Communication: message the Lead with blockers or interface conflicts. Lead owns integration and final decisions.
