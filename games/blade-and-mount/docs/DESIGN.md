# BLADE & MOUNT — Tournament of the Realm

A browser-based 3D melee game inspired by **Mount & Blade: Warband** arena / tournament mode.
Renderer: Three.js + Vite + TypeScript. Everything is procedurally generated (no external art assets).

This is the single source of truth for the team. Read it fully before touching code.

---

## 1. Product vision

The player enters a medieval tournament: first a chaotic 4-team grand melee in a stone arena,
then knockout rounds, then a final duel for the championship. There is also a standalone
**Arena Melee** survival mode that mirrors the reference screenshot (free-for-all, 35 opponents,
"Opponents Beaten / Remaining" HUD, bottom-left damage log, rewards table).

The bar is "this looks and feels like a real game, not a demo":

- Third-person over-the-shoulder combat camera (pointer lock), Mount & Blade style.
- Directional melee: 4 attack directions (left / right / overhead / thrust), directional blocks,
  stamina, kicks, dodges, shield blocks, headshots, speed bonus, hit-stop, camera shake.
- Readable, reactive AI: recruits hesitate, veterans feint and punish, champions parry and dodge.
- A hand-crafted arena that echoes the reference: stone curtain wall, wooden stands full of
  animated spectators, waving banners and pennants, central gatehouse, sand floor, big rock,
  trees, dust, warm late-afternoon light.
- Production-quality presentation: post-processing (bloom, SMAA, color grade, vignette, grain),
  animated crowd, cloth banners, dust motes, blood/spark FX, weapon trails, procedural audio
  (swings, clangs, crowd, horn, music), and a Mount & Blade-flavoured UI (bronze/parchment, Cinzel).
- Full game loop: profile persistence (denars, XP, level, renown, wins), tournament bracket,
  betting, equipment awards per round, victory/defeat screens, pause, settings, controls.

**Title:** BLADE & MOUNT. **Subtitle:** TOURNAMENT OF THE REALM.

---

## 2. Tech + commands

- `npm run dev` → http://127.0.0.1:5273 (Vite).
- `npm run build` → typecheck + production build (`dist/`).
- `npm test` → vitest logic tests.
- `npm run shot -- --url "http://127.0.0.1:5273/?autostart=1" --out shots/game.png --wait 8000`
  → headless Chrome screenshot (uses system Chrome via puppeteer-core).
- Typecheck frequently: `npx tsc --noEmit`.
- Node 26, npm cache is local (`.npm-cache`) — do not install globally.
- Do not start servers on ports other than your assigned one (Lead tells you); use
  `--port 5273` for the main server. Teammates: reuse the already running dev server, or ask Lead.

**Quality presets:** `low | medium | high` in `Settings`. Default `high`.

---

## 3. Coordinate system + scale

- Y up, meters. Characters ~1.75–1.85 m.
- Characters are modelled facing local **+Z**. World forward for yaw = `(sin(yaw), 0, cos(yaw))`.
  Set `root.rotation.y = yaw`.
- Arena playable floor is y=0. Play bounds: x ∈ [-24, 24], z ∈ [-20, 20] (approx, see Arena).
- North wall / gatehouse at z ≈ -20 (facing +Z into arena). Player spawn near (0, 12) facing yaw π
  (toward the gate / -Z).
- Team spawn groups at the four corners.
- Camera: over-the-right-shoulder, distance ~3.2 m, height ~1.62 m, look at ~1.45 m.

---

## 4. Directory ownership (write scopes)

| Owner | Files |
|---|---|
| **Lead** | `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json`, `src/main.ts`, `src/style.css`, `src/core/**`, `src/game/game.ts`, `src/game/fighter.ts`, `src/game/player.ts`, `src/game/camera.ts`, `src/game/profile.ts`, `src/combat/**`, `tests/game*.test.ts`, `tools/**`, `docs/**`, `README.md` |
| **arena-artist** | `src/world/**`, `arena-lab.html`, `src/dev/arena-lab.ts`, `tests/arena.test.ts` |
| **character-artist** | `src/characters/**`, `character-lab.html`, `src/dev/character-lab.ts`, `tests/characters.test.ts` |
| **combat-ai** | `src/game/ai.ts`, `src/game/ai/**`, `tests/ai.test.ts` |
| **ui-audio** | `src/ui/**`, `src/audio/**`, `ui-lab.html`, `src/dev/ui-lab.ts` |
| **QA** | `tests/qa/**` only (plus read anything) |

Never edit a file outside your scope. If an interface in `src/core/types.ts` is wrong, message
the Lead; the Lead owns that file. Keep the game compiling at all times.

---

## 5. Frozen interfaces (src/core/types.ts)

The authoritative definitions live in `src/core/types.ts`. Summary:

### Arena (owned by arena-artist)
```ts
createArena(scene, renderer, quality): Arena
Arena {
  root: THREE.Group
  bounds: { minX, maxX, minZ, maxZ }
  obstacles: { x, z, r }[]            // circular blockers for movement + camera
  spawns: THREE.Vector3[]             // generic melee spawn points near gates
  teamSpawns: { position: THREE.Vector3, yaw: number }[][]  // 4 groups of 4
  playerSpawn: { position: THREE.Vector3, yaw: number }
  update(dt, time): void
  setExcitement(level01): void        // crowd animation intensity
  cheer(strength01?): void            // one-shot crowd wave
  clampPosition(pos, radius): void    // keep inside bounds (walls)
  dispose(): void
}
```
Arena owns sky, lighting, fog, crowd, banners, props. It must add its own root to the scene.
No external assets; canvas-generated textures only. Deterministic (seeded RNG).

### Character rig (owned by character-artist)
```ts
createCharacterRig({ loadout, appearance, quality }): CharacterRig
CharacterRig {
  root: THREE.Group                  // add to scene; faces local +Z
  height: number
  update(dt): void                   // internal animation/state machine
  setMotion(speed, strafe, forward): void  // m/s + local velocity for locomotion blend
  setGuard(dir: GuardDir | null): void     // weapon/shield guard pose
  playAttack(dir: AttackDir, speedMul: number): void
  playAction(action: 'stagger'|'hit'|'die'|'victory'|'dodge'|'kick'|'taunt'|'spawn'|'bash', opts?): void
  setLookTarget(v: THREE.Vector3 | null): void
  getWeaponTip(out): THREE.Vector3
  getWeaponBase(out): THREE.Vector3
  getAnchor('head'|'chest'|'root', out): THREE.Vector3
  setOpacity(v): void                // corpse fade
  setDead(dead: boolean): void
  dispose(): void
}
createAppearance(seed, loadout, teamColor, teamColor2): Appearance
```
Rig animation timing MUST match `ATTACK_TIMING` / `attackTiming(weapon)` in `core/config.ts`
(windup → active → recover). The rig is rigid-part animated (no external skeletal assets),
styled as a believable low-poly medieval fighter with layered armour, shield, weapon, tabard.
Quality bar: silhouettes, proportions, cloth/armor layering, helmet variety, readable poses.

### AI (owned by combat-ai)
```ts
createAIController(profile: AIProfile, seed: number): AIController
AIController.update(ctx: AIContext): Intent   // called every frame
AIController.notifyDamaged?(attackerId, dir): void
```
AI only returns intents (movement world-space, attack direction, guard direction, dodge, kick,
target id). It never moves rigs directly. It receives full `FighterInfo[]` snapshots.
Personality archetypes + difficulty presets live in `core/config.ts`; AI may add its own tuning.

### UI + audio (owned by ui-audio)
```ts
new GameUI(handlers: UIHandlers)
ui.showMainMenu(profile); ui.hideMainMenu()
ui.showHUD(mode); ui.hideHUD(); ui.updateHud(hud)
ui.pushLog(entry); ui.toast(text, kind?)
ui.showBracket(view); ui.hideBracket()
ui.showRoundIntro(view); ui.hideRoundIntro()
ui.showRoundResult(view); ui.showTournamentEnd(view); ui.showMeleeResult(view)
ui.showPause(); ui.hidePause(); ui.showSettings(); ui.showControls()
ui.setDamagePulse(amount01); ui.setTargetOverlay(target|null)
ui.fadeToBlack(ms?)/fadeFromBlack(ms?)  // for scene transitions
ui.setLoading(progress|null)
audio.unlock(); audio.play(name, {pos,volume,rate}); audio.update(camera, dt)
audio.setVolumes(...); audio.startMusic(kind); audio.stopMusic(fade)
audio.setCrowd(level); audio.cheer(strength); audio.gong()
```
UI is pure DOM/CSS appended into `#ui-root`; it owns `src/ui/ui.css`. It never imports game state.
M&B aesthetic: dark smoked leather panels, bronze edges, Cinzel titles, EB Garamond body,
Barlow Condensed numerals. All text content English by default, with a VI language toggle
(best-effort; menu + HUD labels). Fonts from `@fontsource/*` packages.

---

## 6. Gameplay specification

### 6.1 Controls
| Input | Action |
|---|---|
| WASD | Move (camera-relative) |
| Mouse | Look (pointer lock); camera spring follow |
| LMB hold + mouse gesture (or A/D/W/S while held) | Choose attack direction; release to strike |
| RMB hold + mouse gesture | Choose block direction; hold to guard |
| Shift | Sprint (stamina drain) |
| Space | Dodge (i-frames, stamina) |
| F | Kick (stagger + guard break, cooldown) |
| Q / MMB | Lock target |
| Wheel | Camera distance |
| Esc | Pause |
| H | Toggle controls hint |
| Tab | Hold: tournament board / scoreboard |

Attack direction selection: while LMB is held, a 4-way indicator appears at the crosshair.
Mouse delta (or A/D/W/S) selects `left/right/overhead/thrust`; default `right`.
Release LMB to swing. This is the Warband "hold & drag" feel, with keyboard fallback.

### 6.2 Combat numbers (core/config.ts — balance centrally)
- HP 120 (player scales +2/level, capped at +30 → 150). Stamina 100, regen 16/s.
- Weapon damage 20–42, speed multiplier 0.72–1.15, reach 2.2–3.3 m, armor penetration 0.1–0.45.
- Attack timing: windup = 0.26/speed, active = 0.10, recover = 0.30/speed (+/- small weapon factor).
- Zone multiplier: head 1.7, torso 1.0, legs 0.75. Overhead tends to hit head, thrust torso.
- Armour: damage × (1 − armor*0.009) (armor 0–85), min 2.
- Speed bonus: up to +35% from approach + weapon swing momentum. Log shows `Speed bonus: +14%`.
- Block: correct direction + facing attacker. Shield absorbs 100% for stamina = damage*0.55;
  weapon block absorbs 80% for stamina = damage*0.9. Guard break at 0 stamina → 0.9 s stagger.
- Friendly fire ON in tournament, with log warnings.
- Hit-stop 60 ms on clean hits, 90 ms on blocks, 120 ms on kills; camera shake scaled to damage.
- Head clean hit on unarmoured target may one-shot (by design).
- Kick: 2.6 m, 50° cone, 0.7 s stagger, 18 stamina, 4 s cooldown.
- Dodge: 2.4 m dash over 0.25 s, i-frames 0.3 s, 20 stamina, 1 s cooldown.
- Melee mode: out-of-combat (8 s no damage dealt/taken) regen 4 HP/s, capped.

### 6.3 Tournament structure
16 contestants, 4 rounds, teams redrawn each round (player always included):
1. **Grand Melee** — 4 teams × 4; top 2 teams advance (8 survivors).
2. **The Knights' Pass** — 2 teams × 4; winning team advances (4).
3. **The Duellists' Round** — survivors redrawn into 2 teams × 2; winning team (2) advances.
4. **The Championship** — final duel, 1v1.
- If the player is knocked out but their team still advances, the player continues (Warband-like).
  If the player's team loses, tournament ends (consolation + rewards).
- Knocked-out player spectates the rest of the round via a slow orbit camera.
- Each round: before entering, the player picks one of four curated loadouts (sword & kite, war axe,
  spear, greatsword) with armour tier rising by round; intro banner with team roster, betting
  0/25/50/100/150 on yourself (a win returns 2× the stake). Final purse + rewards + renown on victory.
- Round win: denars = `ROUND_PURSE[round]` (60/120/200/500) + kill rewards; XP per kill 8/12/18/30;
  winning the championship adds +6 renown (rounds award 1/2/3/6). Betting returns 2× the stake on a round win.
- 6-round? No — 4 rounds, keep it tight and polished.

### 6.4 Arena Melee mode
- 35 opponents total, 4–8 active at once, spawning at the gates in waves.
- Free-for-all, no teams. HUD counters exactly like the reference:
  `Opponents Beaten: N` / `Opponents Remaining: M`.
- Rewards (denars / XP) by beaten count:
  0–2: 0/0, 3–5: 5/5, 6–9: 10/10, 10–19: 25/10, 20+: 60/10.
  Clearing all 35: +250 denars / +200 XP / +2 renown.
- Player death ends the run; result screen with rewards, best score in profile.
- Opponents get harder as waves progress (recruit → fighter → veteran → champion).
- Damage log in the reference's exact flavour:
  `Speed bonus: +14%`, `Delivered 27 damage`, `Regular Fighter knocked unconscious`,
  `You got 8 experience`.

### 6.5 Profile / progression (localStorage key `blade-and-mount.profile.v1`)
```ts
{ denars, xp, level, renown, tournamentsWon, tournamentsPlayed, bestMelee, totalKills, name }
```
Level: thresholds `110 * level^1.35`; +2 max HP/level (cap +30, from 120 base). Rank names by level for UI.
Settings stored separately (`blade-and-mount.settings.v1`).

---

## 7. Visual art direction

**Mood:** bright overcast-to-golden tournament afternoon, dusty sand, warm limestone, dark oak,
faded heraldic cloth. Reference: Warband arena scene (stone wall + wooden stands + gatehouse + crowd).
Aim painterly-realistic low-poly, not flat-shaded toy: layered materials, subtle roughness variation,
ambient occlusion via vertex-color darkening and contact blob shadows, atmospheric fog, long shadows.

**Palette:**
- sand `#c9b388` / `#a8916b` shadowed
- limestone `#9a937f` warm grey
- oak `#5b4632`, dark timber `#3a2c20`
- cloth red `#8e2f2b`, cream `#d9c9a3`, royal blue `#2c4a7a`, green `#3f6b3a`, gold `#c9a24a`
- sky horizon `#e8e3d3`, zenith `#a8bcc6`, sun warm `#fff0d8`
- keep saturation restrained; UI bronze `#b08d57`.

**Arena content checklist (arena-artist):**
- Stone curtain walls (individual stone blocks or texture), ~4 m high, with crenellations.
- Wooden spectator stands along the west + north walls (roof, posts, railings, benches) with
  ~150–220 instanced low-poly spectators that idle-sway and cheer.
- Central gatehouse at north with arched gate, wooden upper floor, gabled shingle roof, banners.
- Waving heraldic banners + slim pennant poles with triangular flags (vertex-shader or CPU cloth).
- Sand floor with trampled paths, scattered pebbles, hay, dark blood-stain decals (optional),
  fence sections, barrels, crates, weapon rack, hay bales.
- Big weathered rock right of centre (reference), trees outside walls, distant hills.
- Sky dome + soft cloud layer, sun, god-ray-ish glow, fog, dust motes in air.
- Lighting: key directional sun with shadows, warm hemisphere fill, contact shadows under props.
- Crowd excitement API drives a visible reaction (bounce + arms + roar) on kills/round end.
- Performance: instancing for crowd/props where possible; ≤ 120 draw calls for the environment.

**Character content checklist (character-artist):**
- Proportions ~7.3 heads; hands/feet sized; layered torso (tunic + cuirass + belt + baldric),
  pauldrons, arm guards, skirt/tassets, boots; 5 helmet types; shields with heraldic canvas art;
  8 weapons (sword, falchion, axe, mace, greatsword, spear, boar spear, staff).
- Face: simple but expressive low-poly head, hair, optional beard; eyes as dark planes.
- Weapon trail (ribbon) during strikes, shield on left forearm, weapon in right hand.
- Animation: idle breathing + sway, walk/run cycles with arm swing, strafe lean, 4 distinct
  attacks (left/right diagonal slashes, overhead chop, thrust), block poses per direction,
  hit reactions, stagger, kick, dodge roll, death (fall + settle), victory raise-arms.
- Smooth crossfades, springy joints, foot planting; never T-pose.
- Performance: shared geometry/materials across characters; ≤ 35 draw calls per fighter.

**UI content checklist (ui-audio):**
- Main menu over live arena backdrop: title, Tournament, Arena Melee, Controls, Settings, Credits;
  profile strip (level/rank, denars, renown, wins).
- Tournament board: round, team rosters with names/kills, survivors, purse, bet selector,
  Enter the Lists button; bracket progression.
- HUD: top-left counters (mode-specific), top-centre round/objective, bottom-left combat log
  (fading, colour-coded, M&B phrasing), bottom-right health/stamina bar with portrait medallion,
  weapon/shield badges, target nameplate + health bar, lock-on reticle, hint prompts.
- Round intro overlay, round result, tournament champion/defeat, melee result, pause, settings,
  controls, loading, transitions, damage vignette pulse.
- Responsive at 1280×720 and 1920×1080; no scrollbars; pointer-events only where needed.
- Procedural audio: swing whoosh, flesh/armour impact, shield clang, weapon parry, footsteps,
  dodge cloth, kick thud, death, gong, war horn, crowd ambience + cheers, UI clicks, victory/defeat
  stings, low-key percussion/tension music loops. Positional-ish panning/attenuation from camera.

---

## 8. Engineering conventions

- TypeScript strict. No `any` unless unavoidable. No network at runtime; the only shipped asset is
  the retargeted CC0 animation clip data (`public/assets/knight-anim.json`).
- Use seeded RNG (`mulberry32` from `core/utils.ts`) for reproducibility; no `Math.random()` in
  world/character generation (gameplay crits may use seeded game RNG).
- Dispose geometries/materials/textures on teardown.
- Reuse geometries/materials; avoid per-frame allocations in update loops (use temp vectors).
- Everything must run at ≥ 50 fps on an M1 Pro at 1280×720 with 16 fighters + crowd + post FX.
- Runtime ships one small local animation data file (`public/assets/knight-anim.json`, retargeted
  CC0 KayKit clips). Everything else is generated at runtime; no network calls.
- Dev-only debug: `window.__game` exposes `{ game, ui, debug }`. URL params:
  `?autostart=tournament|melee`, `?skipmenu=1`, `?bot=1` (AI controls player), `?quality=low`,
  `?seed=123`, `?time=...`. Keep these working; QA uses them.
- Any visual module can be previewed via its lab HTML (Vite dev server):
  `/arena-lab.html`, `/character-lab.html`, `/ui-lab.html`.
- Commit-ready at all times; do not leave debugging console spam.

---

## 9. Definition of done

- Menu → tournament → 4 rounds → champion/defeat → profile persists; melee mode end-to-end.
- Combat feels responsive: attacks land where they look, blocks work, stamina matters, AI duels
  are readable, no stuck fighters, no one walks through walls.
- 60 fps-ish; no console errors; no obvious seams/T-poses/pop.
- Audio reacts to everything; crowd swells on kills and victory.
- Visuals: screenshots at 1280×720 look like a shipped medieval arena game.
- `npm run build` passes; tests pass; README documents controls + how to run.
