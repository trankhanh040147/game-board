# BLADE & MOUNT — Tournament of the Realm

A fully playable 3D medieval melee game in the browser, built as a loving homage to
**Mount & Blade: Warband**'s arena and tournament modes. Fighters, armour, the arena, crowd,
props, sound effects and music are generated at runtime. Locomotion, combat and death animation
clips are retargeted onto the game's fighter rig from the CC0 **KayKit Adventurers** pack.

![Main menu](shots/final-menu.png)
![The lists](shots/final-hud.png)

![Tournament board](shots/final-bracket.png)
![Choose your arms](shots/final-loadout.png)
![Arena Melee](shots/final-melee.png)
![Champion](shots/final-champion.png)

## Play

```bash
npm install
npm run dev        # http://127.0.0.1:5273
```

or build and preview a production bundle:

```bash
npm run build
npm run preview    # http://127.0.0.1:5274
```

Requires a WebGL2-capable browser (Chrome, Edge, Safari 16+, Firefox). Click the game to capture
the mouse. Press **Esc** for the pause menu.

## Modes

### Tournament of the Realm
Sixteen fighters, four rounds, teams redrawn each round, and the whole yard watching.

1. **The Grand Melee** — 4 houses × 4 fighters. Be one of the last two houses standing.
2. **The Knights' Pass** — two houses of four; only the winner advances.
3. **The Duellists' Round** — the four survivors are paired into two teams of two.
4. **The Championship** — the last two fighters face each other in a duel on the sand.

Knocked out early? If your house still wins, you live to fight the next round (as in Warband).
Bet 0–150 denars on yourself before each round at 2:1. Before every bout the armoury opens: choose one of four loadouts — sword & kite, war axe, spear or greatsword — with rising-quality armour each round. Rounds award a purse, kill money, XP and renown.

### Arena Melee
A free-for-all against 35 opponents in waves, faithful to the reference HUD:
**Opponents Beaten / Opponents Remaining**, damage log, speed bonuses, and the classic reward table.
Clear the yard for the champion's purse.

## Controls

| Input | Action |
|---|---|
| **WASD** | Move |
| **Mouse** | Look / camera |
| **Left mouse (hold + drag, release)** | Choose one of 4 strike directions and attack |
| **Right mouse (hold + drag)** | Guard — match the enemy's strike direction to block |
| **Shift** | Sprint (stamina) |
| **Space** | Dodge with brief invulnerability |
| **F** | Kick — staggers and breaks an opponent's guard |
| **Q / middle mouse** | Lock onto the enemy nearest the crosshair |
| **Mouse wheel** | Camera distance |
| **1–4 / click** | Choose your loadout in the pre-bout armoury |
| **Esc** | Pause |
| **Tab** | Hold for the scoreboard hint |

While an attack or guard is charged you can also tap **A / D / W / S** to pick left / right /
overhead / thrust. The chosen direction is shown around the crosshair. **Matching the direction
matters** — a shield blocks all damage in the right direction but eats stamina, and a broken guard
leaves you open.

## Combat depth

- Four directional attacks and guards, weapon-specific reach / speed / armour penetration.
- Head (×1.7), torso and leg hit zones; overhead strikes aim high, thrusts are armoured piercing.
- Speed bonus from moving into a strike and the weight of the weapon (shown in the log, e.g. `+14%`).
- Stamina governs attacks, dodge, kick, sprint and blocking; an empty guard breaks into a stagger.
- Shields absorb a blow at stamina cost; weapons parry with partial bleed-through.
- Kick to crack a turtling opponent, dodge to punish committed swings.
- Friendly fire is on in tournaments — mind your house.
- Hit-stop, camera shake, weapon trails, blood decals, sparks, crowd reactions and slow-motion
  on the final blow of a round.

## Progression

Denars, XP, level, renown, tournament victories and best melee score are stored in `localStorage`.
Levels raise your maximum health and damage slightly; rank titles range from Serf to Legend of the Sand.
Settings (quality, FOV, sensitivity, volumes, language, camera shake, hints) are also persisted.

## Tech

- **Three.js** rendering with ACES tone mapping, soft shadows, bloom, SMAA, custom colour grade,
  vignette, film grain and damage pulse.
- Procedural characters: layered armour, 6 helmet types, 8 weapons, heraldic shields and tabards,
  rigid-part skeletal rigs, weapon trails and baked/retargeted combat animation with crossfades.
- Procedural arena: stone lists, timber stands, animated instanced crowd, gatehouse, waving banners,
  props, dust, sky, distant hills and warm afternoon light.
- Tactical AI: target selection, team awareness, spacing, guard reading, dodges, kicks, feints,
  archetypes from hesitant recruits to champion duellists.
- Procedural WebAudio: designed impacts, swings, crowd ambience, score and adaptive music.
- TypeScript, Vite, Vitest. No network calls at runtime; the only shipped asset is the retargeted
  animation clip data (`public/assets/knight-anim.json`).

## Controls in the armoury

Before every bout (and before each Arena Melee run) the game opens a pre-bout **Choose Your Arms**
panel. Click a card or press **1–4**, then **Enter / Take the Field**. Your pick updates your fighter,
HUD badge and intro loadout.

## Credits

Animation clips based on **KayKit Adventurers** by Kay Lousberg (CC0 1.0), retargeted to this
game's skeleton. See [docs/animation-research.md](docs/animation-research.md) and
[public/assets/Knight-LICENSE.txt](public/assets/Knight-LICENSE.txt).

## Project layout

```
src/core      engine, input, types, config, utilities
src/world     procedural arena, crowd, banners, sky, textures
src/characters rigs, armour, weapons, animation, heraldry
src/combat    hit resolution, particles, blood decals
src/game      game loop, fighters, camera, player, AI, profile
src/ui        HUD, menus, tournament board, results, settings
src/audio     procedural sound design and music
tests         logic + AI tests
tools         headless screenshot / playtest helpers
tests/qa      independent release QA report + runnable suites
```

## Animation

Locomotion, guards, attacks, dodges and death are driven by baked clips retargeted from the CC0
KayKit Adventurers animation set onto the game's own skeleton, blended with procedural look-at,
cape, shield and foot-pinning. Add `?anim=procedural` to the URL to compare with the older
procedurally generated animation, or use `window.__game.setAnimationMode('baked'|'procedural')` live.

## Development

```bash
npm test                    # vitest logic/AI tests
npm run build               # typecheck + production build
npm run shot -- --url ...   # headless screenshot helper
node tools/playtest.mjs     # headless menu → bracket → fight → pause flow
node tools/qa/flow-tournament.mjs  # QA flow suite (see tests/qa/REPORT.md)
```

Independent release QA (0 P0, 0 P1) is documented in [tests/qa/REPORT.md](tests/qa/REPORT.md).

Debug hooks are exposed on `window.__game` (`getState`, `startTournament`, `startMelee`,
`enterRound`, `killEnemies`, `pause`, `resume`). URL parameters: `?autostart=tournament|melee`,
`?bot=1` (AI drives the player), `?seed=123`, `?quality=low|medium|high`.

---

## Tiếng Việt

**BLADE & MOUNT — Tournament of the Realm** là game đấu trường trung cổ 3D chạy trên trình duyệt,
lấy cảm hứng từ chế độ Tournament / Arena trong *Mount & Blade: Warband*. Toàn bộ mô hình, bầu trời,
đám đông, âm thanh và âm nhạc đều được sinh tự động, không dùng asset ngoài.

```bash
npm install
npm run dev     # mở http://127.0.0.1:5273
```

- **Tournament**: 16 đấu sĩ, 4 vòng, chia đội lại mỗi vòng, đặt cược, phần thưởng theo vòng, tiến trình nhân vật được lưu.
- **Arena Melee**: đấu tự do 35 đối thủ, HUD `Opponents Beaten / Remaining`, bảng thưởng giống bản gốc.
- Điều khiển: WASD di chuyển, giữ chuột trái + kéo để chọn 4 hướng chém rồi thả để đánh,
  giữ chuột phải + kéo để chọn hướng đỡ, Shift chạy, Space né, F đá, Q khóa mục tiêu, Esc tạm dừng.
- Chế độ chơi nhấn mạnh vào đỡ đòn đúng hướng, stamina, speed bonus, chí mạng vào đầu, phá guard và đánh đổi vị trí.

Chúc bạn chơi vui — và đừng quên: *a knight who forgets his shield is a knight who forgets his name.*
