# FIRST HEARTH — Content Authoring Contract

The simulation is data-driven. You write TypeScript data arrays in `src/sim/content/` typed by
`src/sim/types.ts`. **Import types only** (`import type { ... } from '../types'`). Content files must
not import systems, renderer or UI.

## Files & exports (exact names matter)

| File | Owner | Exports |
|---|---|---|
| `resources.ts` | content-econ | `RESOURCES: ResourceDef[]` |
| `biomes.ts` | content-econ | `BIOMES: BiomeDef[]` |
| `buildings.ts` | content-econ | `BUILDINGS: BuildingDef[]`, `RECIPES: RecipeDef[]` |
| `sites.ts` | content-econ | `SITES: SiteDef[]` |
| `techs.ts` | content-lore | `BRANCHES: BranchDef[]`, `TECHS: TechDef[]` |
| `society.ts` | content-lore | `POLICIES: PolicyDef[]`, `DOCTRINES: DoctrineDef[]`, `ERAS: EraDef[]`, `MEGAPROJECTS: MegaprojectDef[]` |
| `events.ts` | content-lore | `EVENTS: EventDef[]` |
| `milestones.ts` | content-lore | `MILESTONES: MilestoneDef[]`, `ACHIEVEMENTS: AchievementDef[]` |
| `people.ts` | content-lore | `NAMES: NamePools`, `TRAITS: TraitDef[]`, `SKILLS`, `PROFESSIONS` |
| `tutorial.ts` | content-lore | `TUTORIAL: TutorialTipDef[]` |

`src/sim/content/index.ts` validates and merges all packs; a content-integrity test will fail on
unknown ids, duplicate ids, missing resources, unreachable techs, broken recipe references, etc.
Run `npm run typecheck` and `npm test` after your files land.

## Design targets

**Resources (~40).** Raw food (berries, grain, fish, meat), raw materials (wood, stone, clay, sand, fiber, hides, wool),
ores (copper_ore, iron_ore, coal, oil, gold_ore), refined (plank, brick, charcoal, coke, copper, iron, steel, glass, cloth, leather,
flour, bread, pottery), components (tools, furniture, paper, books, medicine, fuel, machinery, electronics, fertilizer, concrete,
clothes, jewelry, art, preserved_food, ale/wine), science (chemicals, glassware, instruments, computers), energy (`energy` as a tradable
abstract resource). Every resource needs `name, category, tier, color, icon, desc, basePrice`; food has `edible`.
Resources listed in the HUD as `core`: berries, grain, fish, meat, wood, plank, stone, brick, iron, steel, tools, energy, medicine, insight? (insight is a currency, not a resource).

**Buildings (~55).** Earliest era must be playable from one worker with NO techs:
Forager's Camp, Woodcutter's Camp, Stone Pit, Lean-to, Hut, Well, Granary, Fire Pit.
Then per era: agriculture (farm, orchard, pasture, fishery, hunting blind), food processing (mill, bakery, kitchen,
preserved food), industry (sawmill, brickworks, pottery kiln, charcoal kiln, tannery, weaver, smithy, foundry, glassworks,
coke oven, blast furnace, workshop, factory, refinery, power plant), logistics (road special, warehouse, market, trade post,
caravan post, rail depot, dock), society (school, library, clinic, hospital, temple, theatre, bathhouse, well/aqueduct/water tower),
science (workshop lab, university, observatory, computing lab), defence (palisade, watchtower, barracks, wall), beauty (garden, park,
monument, fountain), special/unique per doctrine, megaproject anchors.
Every building: `cost, upkeep, buildTicks, size, jobs, recipes, housing/storage/effects, pollution, beauty, waterUse, energyUse,
placement, requiresTech, visual`. Era 0 buildings must be buildable with starting resources and no techs.
`visual.icon` comes from the UI icon set (see `src/ui/icons.ts`, ui owns it — use names like `camp`, `axe`, `pick`, `hut`, `well`, `farm`, `mill`, `smith`, `tower`, `temple`, `lab`, `power`, `market`, `tree`, `stone`).
If the icon does not exist yet, pick a reasonable semantic name and tell the Lead.

**Recipes (~80).** Every processing building needs 1–3 recipes (allowing alternative strategies, e.g. charcoal kiln:
slow-clean vs fast-dirty). Gathering buildings use `gather` instead of/alongside inputs. Inputs/outputs are per full-crew day;
`workers` = full crew size; `skill` = governing skill (`farming`, `woodcraft`, `mining`, `building`, `crafting`,
`scholarship`, `medicine`, `trade`, `leadership`, `combat`, `artistry`, `husbandry`).
Include byproduct outputs and alternative recipes that trade efficiency vs pollution.

Balance anchors (per worker-day at 100%):
- foraged food ≈ 1.0–1.4; farm grain ≈ 3–4 (fertile soil) consuming water via building waterUse; fish ≈ 1.5–2.2;
  lumber ≈ 2.0–2.6 wood; stone ≈ 2.0; ore ≈ 1.5–2.0; plank ≈ 0.6 per wood-consumed recipe chain.
- A citizen eats 0.6 food/day. Early hut houses 3, costs 8 wood + 2 fiber. Well supplies 6 water/day. Granary stores 150.
- Building costs scale: era0 5–20 raw; era1 20–60; era2 60–200; era3+ 200–1000.
- Upkeep is small (0.1–2/day of a raw/money-equivalent) and taxes cover it.

**Biomes (~10).** river_valley, temperate_forest, grassland, wetland, hills, mountains, semi_arid, desert,
boreal, coast, ocean (water), volcanic_ash optional. Fields: elevationRange/tempRange/moistureRange, fertility,
forage, forest, wildlife, beauty, walkCost, deposits, rain, tempOffset, colors. Ocean must be `waterColor`-heavy,
unwalkable (`walkCost: 99`) and not settleable. Ensure biome selection bands are non-overlapping enough for worldgen;
world-sim owns the exact selector and will read these defs.

**Sites (~14).** Ancient Ruins, Forgotten Shrine, Ancient Grove, Hot Spring, Crystal Cave, Meteor Crater, Shipwreck,
Old Observatory, Petrified Forest, Sunken Library, Standing Stones, Dragon Bones, World Seed Vault (legendary).
Each has `effects` using the EventEffect union and 1–3 lines of evocative text. They must be *mechanically meaningful*
(insight, permanent modifiers, unique resources, morale, tech grants).

**Techs (~90).** Six branches: survival/knowledge (`craft`, `agriculture`, `industry`, `science`, `society`, `exploration` —
choose ids that read well). Eras 0–6. Era 0 techs cost 8–25 insight with no prereqs (Cultivation, Firekeeping, Cordage,
Knapping, Foraging Lore, Sheltercraft, Well Digging, Herbalism). Each tech: 1–3 effects, unlocks 1–3 buildings/recipes/policies.
Include alternate paths, synergies ("Irrigation" + "Masonry" enables Aqueduct via requires list), and ~6 mutually exclusive
thematic pairs (e.g. `sacred_groves` vs `clear_cutting`, `guilds` vs `state_workshops`). Do not make one obviously optimal line.
Tech costs: era0 8–25, era1 30–70, era2 80–160, era3 180–320, era4 350–600, era5 650–1000, era6 1100+.
`effects` use ModifierKey keys from types.ts.

**Policies (~16).** Era-gated, influence cost, class support, conflicts: e.g. Land Commons, Private Plots, Grain Tithe,
Open Borders, Guild Charter, Public Schooling, Sanitation Act, Forest Charter, Festival Tradition, Militia Service,
Trade Tariffs, Free Ports, Poor Relief, Craft Apprenticeships, Sacred Calendar, Work Quotas. Modifier effects meaningful
(±10–25%) with tradeoffs across classes.

**Doctrines (~13).** Chosen at era transitions (3 offered). Identities: Hearthkeepers (community/food), Stoneborn (industry),
Starwatchers (science), Rootbound (ecology), Tidecallers (trade), Iron Assembly (automation), Chroniclers (culture), etc.
Mechanically distinct, with unique building or unlock, and a motto. Era defs (`ERAS`, 7) gate doctrines and give requirements.

**Events (~45).** MUST use structured `Condition`/`EventEffect` only. Telegraph serious crises (`telegraphDays` > 0 +
`warningText`). Include chains (`chain`) and multi-choice decisions with real tradeoffs. Categories spread across nature,
economy, society, science, migration, conflict, discovery, omen, boom, crisis. Early-game events must fire in year 1–2
(wanderer arrives, first frost, wolf tracks, berry glut, traveling trader). Avoid unfair instant disasters; every crisis
has a visible cause. Effects reference real resource/building/tech ids.

**Milestones (~18) & Achievements (~20).** Onboarding objectives ("Raise a hut", "Feed 10 souls", "First harvest",
"Discover writing") plus era milestones, megaprojects, survival/ecology/automation achievements. Conditions reference metrics below.
**Megaprojects (~6).** Era 4–6, huge costs, permanent powerful effects: Great Library, Grand Aqueduct, World Seed Vault,
Sky Loom (orbital), Ocean Bloom (climate restoration), Thousand Hearths (federation).

**People data.** Name pools: 60 male, 60 female, 60 surnames, settlement affixes, 12 neighbour civ names.
~14 traits (Industrious, Curious, Frail, Charismatic, Stubborn, Dreamer, Stoic, Quick, Keen-eyed, Gentle, Ambitious, Loyal, Wanderer, Haunted).
Skills metadata (12) and professions metadata (~16) mapping to classes.

## Condition metric keys (implemented by `metrics.ts`)

`population`, `adults`, `children`, `elders`, `workforce`, `unemployed`, `homeless`, `housingCapacity`, `housingQuality`,
`food`, `foodDays`, `water`, `waterDays`, `morale`, `health`, `hunger`, `thirst`, `approval`, `stability`, `crime`,
`treasury`, `insight`, `culture`, `influence`, `era`, `techs`, `buildings`, `buildings.industrial`, `pollution`,
`biodiversity`, `forest`, `fertility`, `wildlife`, `beauty`, `drought`, `temperature`, `rain`, `tradeBalance`,
`neighborsMet`, `explored`, `sitesFound`, `settlements`, `taxRate`, `rations`, `workHours`, `policies`,
`births`, `deaths`, `immigrants`, `foodProduced`, `year`, `day`, `season` (0-3), `megaprojects`, `roads`.
Prefix with `capital.` for capital-settlement values (e.g. `capital.foodDays`). Use `flag` conditions for event state
(flags are numeric counters set by effects).

## EventEffect semantics

- `stock`: add (or multiply with `mode:'mul'`) resource in chosen settlement(s). Negative removes.
- `stockFraction`: remove a fraction of current stock.
- `kill`: fraction of population dies (cause string shown in chronicle).
- `migrate`: spawn citizens (positive) or remove (negative).
- `tempoModifier`: global modifier for N days. `settlementModifier`: same but capital-scoped.
- `tileDeposit`, `forest`, `fertility`, `pollution`: apply within `radius` of capital.
- `discoverSite`, `reveal`: exploration effects.
- `relation` (neighborId), `treasury`, `insight`, `culture`, `unlockBuilding`, `grantTech`, `unlockPolicy`.
- `chronicle`, `notification`, `scheduleEvent`, `flag`, `inspiration` (bonus insight with optional branch).
- `raid` (enemy strength), `spawnRefugees`, `destroyBuildings`, `inspiration`.

## Narrative voice

Warm, grounded, slightly literary; avoid generic fantasy and modern slang. Chronicle entries read like an
in-world history: "The year the river thinned, and we learned to dig." UI labels short and clear.
