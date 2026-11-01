# FIRST HEARTH — Game Design

> *One wanderer. An unnamed valley. A hearth. Everything else is history.*

**First Hearth** is a living-world civilization simulation about turning a single
person into a civilisation — and discovering what that civilisation costs the land
that feeds it. It is a builder, an economy, a survival story, a social simulation
and an ecology lesson at the same time.

---

## 1. Design pillars

1. **A world that remembers.** Every tile has elevation, climate, soil, water, forest,
   wildlife, pollution and beauty. What you take out, you eventually have to put back.
2. **People, not population counters.** Citizens have names, ages, families, skills,
   needs, moods and opinions. They can be bored, hungry, ambitious, devout, heartbroken.
3. **Chains, not chores.** Resources flow through deep production chains. The fun is
   in designing a system that runs itself — then watching it run.
4. **Discovery, not a tech ladder.** 95 discoveries, six branches, mutually exclusive
   paths, doctrine identities and serendipitous inventions. Two settlements should not
   end up the same.
5. **Consequences you can trace.** Crises emerge from state: drought → poor harvest →
   empty granary → migration → housing pressure → unrest. Warnings arrive before the
   disaster, and the reason is always visible.
6. **A readable simulation.** The UI explains itself with tooltips, graphs, ledgers and
   cause traces. Depth must never mean opacity.

---

## 2. The loop

**Early game (Era 0 — Hearth).** Gather berries, fell your first tree, raise a lean-to,
dig a well. Meet your first wanderer. Discover firekeeping, cordage, cultivation.
The pace is slow enough to feel every choice.

**Early-mid (Era 1 — Settlement).** Farms, huts, granaries, a market, a school. Your
first doctrine. Your first drought; your first hard winter; your first event chain.

**Mid game (Era 2 — Kingdom).** Roads, mills, brick, iron, libraries, temples, clinics,
trade with neighbouring civilisations, and expansion to a second settlement with its own
specialisation. Classes and politics start to matter. Ecology becomes a constraint.

**Late game (Era 3–4 — Industry).** Coal, steel, steam, railways, electricity, sanitation,
hospitals, universities, factories. Supply chains need power, labour and logistics. The
first time the sky darkens over your city.

**End game (Era 5–6 — Aether).** Computing, automation, orbital works. Megaprojects that
take generations: a Great Library, an Ocean Bloom, a World Seed Vault, a Thousand Hearths.
The final question is not how big your civilisation is, but what it chose to become.

Failure is soft and legible: people starve, migrate, riot, abandon a settlement; the game
ends only when the last hearth goes dark.

---

## 3. World simulation

- **Procedural generation:** domain-warped fBm elevation with ridged mountain belts and
  continental falloff; sea-level quantile; D8 flow-accumulation rivers carved into valleys,
  inland basins becoming lakes; latitude/elevation temperature; moisture with rain shadow
  and prevailing winds; biome classification into 10+ biomes with distinct palettes,
  resources and constraints; surface and underground deposits; 12 discoverable sites;
  named regions.
- **Weather & seasons:** 16-day seasons, temperature curves, rain and storms, drought
  accumulation and recovery, snow, forecasts. Weather pushes yields, fires and floods.
- **Ecology:** forests regrow and are felled; soil fertility depletes with repeated cropping
  and recovers under fallow/forest; forage and wildlife replenish but can be hunted out;
  pollution spreads from industry and decays with distance/water; biodiversity and climate
  drift (deforestation → warming) respond to cumulative player impact.
- **Disasters:** wildfire, flood, blight, locusts, earthquake, epidemic — telegraphed, caused,
  and mitigable by planning (firebreaks, irrigation, sanitation, disasterResist modifiers).
- **Fog of war & expeditions:** explore the map with scouts and surveyors; discover ruins,
  shrines, groves, springs, craters and legendary places with permanent consequences.
- **Neighbours:** 3–5 AI civilisations with archetypes, attitudes, trade offers, demands,
  alliances and rare telegraphed raids. Diplomacy is a tool, not a minigame.

---

## 4. Economy & production

54 resources across food, raw, refined, component, science, energy and luxury tiers.
~80 recipes with byproducts and alternatives. Extraction is environmental: a lumber camp
depletes forest, a farm depletes fertility, a mine depletes a deposit, a fishery needs water.

Production buildings have inputs, outputs, workforce, condition, water/energy needs and
pollution. Settlement stockpiles are capacity-limited by granaries and warehouses;
perishables spoil. Roads grant access and cut hauling losses; caravans move goods between
settlements; markets float prices with supply/demand; trade routes and tariffs connect you
to neighbours. The governor (automation settings) can auto-fill jobs, repair, reserve food
and buy/sell critical goods — unlockable, configurable, never mandatory.

---

## 5. People

Every citizen has a name, surname, sex, age, health, morale, hunger, thirst, eight needs,
twelve skills, traits, education, profession, income, home, workplace, family ties and
private thoughts. They eat and drink daily, need shelter and warmth, learn at school, marry,
have children, age, fall ill, migrate and die. Housing quality, food variety, amenities,
pollution, crime, approval and seasonal festivals shape their morale.

Beyond a detail cap, additional population is simulated in aggregated cohorts (accurate
consumption, labour and needs) while notable citizens remain fully detailed. This lets the
same game run at 30 or 3000 people.

---

## 6. Research & identity

**Insight** is produced by scholars, education, culture and wonder. It buys discoveries from
a six-branch web (Hearthcraft, Agriculture, Industry, Science, Society, Exploration) across
seven eras. Discoveries do more than unlock buildings: they change how existing systems work
(irrigation transforms farms; computing transforms logistics; ecology science changes how
pollution and biodiversity respond).

**Doctrines** are civilisation-defining creeds chosen at era thresholds from three offered
paths — Hearthkeepers, Stoneborn, Starwatchers, Rootbound, Tidecallers, Iron Assembly,
Chroniclers and more. Each grants a permanent identity, unique building or bonus, and shapes
approval by class. **Policies** (16) give fine-grained control with class tradeoffs,
conflicts and upkeep.

Three pillars of society are always visible: approval, stability and crime. Tax rate, work
hours and rations are levers with direct consequences.

---

## 7. Events as emergent storytelling

The director reads the actual state of the world every day: food days, water, housing,
unemployment, pollution, drought, epidemic risk, neighbour threat. It produces **warnings**
with causes and lead time, triggers severity-appropriate events, schedules chains, and
presents **decisions** that pause the world and demand a real tradeoff.

Every crisis is fair: it is telegraphed, it has a traceable cause, and it has at least one
meaningful response. Historic moments are written into a **Chronicle** in literary voice,
so each playthrough leaves a history you can read back.

---

## 8. Visual & UI direction

An isometric 2.5D world painted in warm earth tones: charcoal night, parchment daylight,
brass UI, ember accents. Terrain is baked in chunks with elevation shading, seasonal palette
shifts, animated water, layered procedural forests, day/night tint and weather. Buildings are
procedurally drawn from content-defined silhouettes (roofs, walls, chimneys, flags, glows),
with scaffolding while under construction and ruin states when neglected. Citizens, caravans,
wildlife and expeditions animate across the map.

The interface is a calm dark-parchment cockpit: top HUD of vital signs; a build library; a
context inspector; an icon rail for Codex, Society, Market, People, Almanac, Diplomacy,
Expeditions, Wonders and Objectives; rich tooltips; canvas graphs; a minimap; event modals
with causes and choices. Everything is keyboard-accessible and legible at 1280×800.

---

## 9. Technical architecture

- **TypeScript, Vite, Canvas 2D + DOM UI.** No game engine dependency; the simulation is a
  pure, headless, deterministic module.
- **Fixed daily ticks**; seeded sfc32 PRNG in persisted state; no `Math.random`, no wall clock
  in simulation code. Same seed + same actions ⇒ identical state.
- **Strict layering:** `sim/` (pure) ← `app.ts` (clock, actions, save) ← `render/` + `ui/`.
  Content is data (`src/sim/content/`), validated at boot and in tests.
- **Save/load** as versioned JSON with typed-array encoding and cache rebuilding.
- **Performance:** baked terrain chunks, culling, sprite caches, incremental ecology updates,
  aggregated population, cached road networks, capped particles.
- **Tested:** Vitest suites for content integrity, determinism, save/load equivalence, early
  game, 400-day long runs, economy invariants, NaN scans; Puppeteer screenshot verification
  for the real browser build.

---

## 10. Inspiration & what makes it different

The genre lineage is clear — *Banished*, *RimWorld*, *Dwarf Fortress*, *Crusader Kings*,
*Anno*, *Civilization*. First Hearth's own bet is that **a civilisation sim should be a
systems ecology**: the same numbers that make your city prosperous are the numbers that
hollow out your forests, and the people who suffer are named. Depth comes from interconnection
— between land, labour, economy, knowledge, politics and belief — not from feature count.
