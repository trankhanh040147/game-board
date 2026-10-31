# Blade & Mount — Independent Release QA Report

**Product:** BLADE & MOUNT — Tournament of the Realm (Three.js + TypeScript + Vite)
**Role:** independent adversarial QA (qa-tester). No game source was modified.
**Build tested:** production preview `http://127.0.0.1:5274/`, `dist/assets/index-C17NLdz6.js`
(md5 `90f9c8f223557e427053e97e22ec5159`), `dist/index.html` md5 `f4b6e07a01c7eff4910877c839e6f0b5`, built 2026‑10‑31 19:12 (+07:00).
**Browser:** headless Google Chrome via `puppeteer-core` (ANGLE/Metal, 1280×720 and 1920×1080, `--autoplay-policy=no-user-gesture-required`).
**Date:** 2026‑10‑31, ~18:27–19:35 (+07:00).

> **Post-QA note (2026-10-31 19:40):** the Lead accepted this report and fixed the three P2s
> (DESIGN.md reconciled to actual balance, wager copy reworded to “returns twice your stake”, real
> `public/favicon.ico` added), plus added assists tracking and moved melee initial spawns. A newer
> build (`dist/assets/index-Bo_5T0uq.js`, 19:38) exists but was **not** re-verified here, per the
> QA handoff instruction to stop testing. Everything below describes the tested build
> `index-C17NLdz6.js` (19:12); P2-1/P2-2/P2-3 are reported as-is and were subsequently fixed.

**Verdict: RELEASE-READY for the flows in scope — 0 P0, 0 P1 found on the tested build.**
All primary game loops complete, combat/control mechanics verified mechanically, profile/settings
persistence verified across reloads, zero viewport overflow at both resolutions, zero console
errors (apart from a benign favicon 404) and zero NaN/stuck fighters across ~4 minutes of
bot-driven play. Findings are polish/spec-drift items (P2) listed below.

---

## 1. Pass/fail checklist

Legend: **PASS** = verified on the final build; **PASS\*** = verified, with a headless-only
caveat; **WARN** = behaviour differs from DESIGN.md (see P2-1); **N/A** = cannot be verified
headlessly (listed under coverage gaps).

| # | Area | Check | Result | Evidence |
|---|---|---|---|---|
| 1 | Load | Cold load reaches main menu, no fatal WebGL screen | PASS | `shots/qa/v1280x720-01-menu.png`, `v1920x1080-01-menu.png` |
| 2 | Menu | Title/subtitle, 5 entries, profile strip (level/rank/denars/renown/wins) | PASS | menu screenshots above |
| 3 | Menu | No scrollbars/overflow at 1280×720 and 1920×1080 | PASS | `visuals-1280x720.json`, `visuals-1920x1080.json` (18 screens each, 0 overflow) |
| 4 | Tournament | Bracket opens with 4 houses × 4, 16/16 standing, purse, arms granted | PASS | `02-bracket-1280x720.png`, `v1920x1080-05-bracket.png` |
| 5 | Tournament | Bet chips 0/25/50/100/150; 150 disabled when purse < 150 | PASS | flow log: chips `[{0,25,50,100 enabled},{150 disabled}]`, `maxBet=120` |
| 6 | Tournament | Wager deducted at round start, pays 2× stake on advance | PASS | denars 120→20 at entry; round-1 result `betWon=200`, reward 260 |
| 7 | Tournament | Round 1 → 2 → 3 → 4 roster shapes: 4×4 → 2×4 → 2×2 → 2×1 | PASS | roster integrity assertions, logs; `10-bracket-round{2,3,4}-1280x720.png` |
| 8 | Tournament | Survivor counts 16 → 8 → 4 → 2, bet resets each round | PASS | flow log (survivors 16/8/4/2, bet reset 0) |
| 9 | Tournament | Round intro overlay, Enter/Space skip, "FIGHT" cue | PASS | `04-round-intro-1280x720.png`, `v1920x1080-07-round-intro.png` |
| 10 | Tournament | Round result screen with deeds/rewards/standings/progress | PASS | `09-round1-result-1280x720.png`, `v1920x1080-13-round-result-win.png` |
| 11 | Tournament | Champion path: 4 wins → "CHAMPION OF THE REALM", +500 purse, +65 XP, +6 renown, tourneysWon=1 | PASS | `11-tournament-champion-1280x720.png`; profile 1100 denars / 170 XP / level 2 / 12 renown / 1 win |
| 12 | Tournament | Defeat path: house wiped → DEFEAT round result → "The Lists Are Closed" end screen, tournamentsPlayed+1, no renown | PASS | `20-defeat-round-result-1280x720.png`, `21-tournament-end-defeat-1280x720.png` |
| 13 | Tournament | Losing wager is forfeited (no payout, stake gone) | PASS | defeat log: 120 → 70 denars, `betWon=0` |
| 14 | Tournament | Knocked-out player spectates; if house still advances, player re-enters next round alive | PASS | `22-spectating-1280x720.png`, `23-advanced-while-dead-1280x720.png`, `25-round2-respawn-1280x720.png` |
| 15 | Tournament | Escape from bracket returns to menu; Withdraw returns to menu; new tournament startable | PASS | flow log (no dead-end state) |
| 16 | Melee | Starts, HUD exactly `Opponents Beaten: 0` / `Opponents Remaining: 35` | PASS | `30-melee-fight-1280x720.png`, `v1920x1080-17-melee-hud.png` |
| 17 | Melee | Kill wiring: beaten +1, remaining −1, M&B log lines (`knocked unconscious`, `You got 8 experience`, `Speed bonus: +N%`) | PASS | `31-melee-kill-1280x720.png`, melee log |
| 18 | Melee | Waves keep spawning; opponents get harder by progress | PASS | spawned 3→6+, `m1280-low.json` samples |
| 19 | Melee | Player death → melee result (defeat), rewards by beaten count, bestMelee/meleeRuns persisted | PASS | `32-melee-defeat-1280x720.png` |
| 20 | Melee | 35/35 clear → victory result, +250/+200 clear bonus, +2 renown, best updated | PASS | `33-melee-clear-1280x720.png` (310 denars, 2 renown) |
| 21 | Profile | Denars/XP/level/renown/wins persist across full page reload; mid-tournament reload safely returns to menu | PASS | `40-menu-after-reload-1280x720.png`, persistence JSON |
| 22 | Profile | Corrupted `localStorage` JSON + invalid quality/language values fall back safely (no crash) | PASS | `43-menu-corrupt-storage-1280x720.png` |
| 23 | Settings | Quality low/medium/high live switch; persists; draw calls 59/74/77 (menu) | PASS | persistence JSON, `41-settings-menu-1280x720.png` |
| 24 | Settings | Audio sliders, FOV, shake, hints toggle, invert-Y, sensitivity all apply + save as you go | PASS | persistence JSON; settings screenshot |
| 25 | Settings/i18n | VI toggle renders Vietnamese copy, survives reload, switches back to EN | PASS\* | `44-menu-vi-1280x720.png`; back-switch verified via probe (`lang: en`) |
| 26 | Pause | Esc pauses, pause panel (Resume/Controls/Settings/Abandon), resume returns to play | PASS\* | `06-pause-1280x720.png`, `v1920x1080-10-pause.png`; see headless caveat §5 |
| 27 | Pause | Losing pointer lock auto-pauses; Esc resumes | PASS | combat log (`losing pointer lock auto-pauses`, `Esc resumes`) |
| 28 | Controls | WASD movement, camera-relative; sprint 5.9 m/s (walk 3.9) with stamina drain | PASS | combat JSON: travelled 6.6 m/1.2 s, speed 5.91, stamina 100→91.6 |
| 29 | Controls | LMB hold + gesture/keys selects all 4 attack directions and swings them | PASS | combat JSON: left/right/overhead/thrust all `state=attack`, dir match, stamina 100→84 |
| 30 | Controls | RMB hold guards chosen direction (default overhead), direction changes with A/D/W/S | PASS | combat JSON: guard `overhead`→`left` |
| 31 | Combat | Correct-direction shield block: 0 HP loss, stamina cost, `Blocked N damage with your shield` | PASS | combat JSON (`blocks=1`, hp 120/120, stamina 92.8) |
| 32 | Combat | Wrong-direction block: hit lands, `Took N damage`, no block log | PASS | combat JSON (120 → 96 HP) |
| 33 | Combat | Guard break when stamina cannot pay a block: `Your guard was broken!`, stagger | PASS | combat JSON (`state=stagger`, log line) |
| 34 | Combat | Kick: 2.7 m cone stagger, log, 4 s cooldown enforced | PASS | combat JSON (target `stagger`, `You kicked X off balance`, cooldown 3.67→3.40) |
| 35 | Combat | Dodge: Space → 2.5 m burst with i-frames; attack during i-frames deals no damage | PASS | combat JSON (moved ~3.1 m incl. drift, hp unchanged) |
| 36 | Combat | Lock-on: Q locks nearest enemy in cone, target ring appears, Q again releases | PASS | `53-lockon-1280x720.png`; ring opacity 0.53 |
| 37 | Combat | Tab scoreboard shows/hides while held | PASS | combat JSON (rows rendered, hidden on release) |
| 38 | Combat | Mouse wheel changes camera distance | PASS | combat JSON (3.8 → 3.35 → 3.8) |
| 39 | Combat | H toggles hints (persists to settings) | PASS | combat JSON (`showHints` toggled + stored) |
| 40 | Combat | Friendly fire ON with warning log; no kill-reward lines for own-team kill (fixed during QA) | PASS | `54-friendly-fire-1280x720.png`; log now `You struck down X — one of your own!` only |
| 41 | Combat | Strikes do not reach beyond weapon reach (5.5 m target untouched) | PASS | combat JSON |
| 42 | Combat | Corpses inert (dead fighters never attack; dead state stable 1.2 s next to player) | PASS | combat JSON |
| 43 | Combat | Arena clamping keeps fighters inside walls (bounds ±23.8/±22.8, radius 0.42) | PASS | combat JSON |
| 44 | Stability | No NaN/Inf positions, HP, stamina, yaw, camera across 4 long bot runs | PASS | `perf-*.json` (`nan=0`) |
| 45 | Stability | No stuck fighters (idle/attack/block within 5 m of an enemy and <0.12 m/s for >5 s) | PASS | `perf-*.json` (`stuck=0` over ~4 min total) |
| 46 | Stability | No console errors / pageerrors / failed requests during play | PASS | all run logs (`consoleErrors=0`, `failedRequests=0`; only favicon 404 noise) |
| 47 | Perf | 60 fps vsync stable; uncapped throughput 370 fps @1280/high, 204 fps @1920/high | PASS | §4 perf table |
| 48 | Perf | Draw calls: environment ~77 (budget ≤120), ~15–16 per fighter (budget ≤35) | PASS | menu 77 calls; 16-fighter fight max 329 |
| 49 | Audio | AudioContext unlocks on first click; all 23 SFX + 3 music beds + crowd/gong play without throwing | PASS | audio log 10/10 |
| 50 | Audio | Volume/mute changes safe; no audio-related console errors; no asset/network fetches (fully procedural) | PASS | audio JSON (`failedRequests=[]` except favicon) |
| 51 | Visual | No overflow/clipping on 18 screens × 2 resolutions; no camera-in-geometry in inspected frames | PASS | `visuals-*.json`, screenshots |
| 52 | Visual | HUD reference details: `Opponents Beaten/Remaining`, damage-log phrasing, rewards table, target plate, lock reticle | PASS | `17-melee-hud`, `08-fight-hud`, `zoom-01-log.png` |

---

## 2. Bugs

### P0 — blockers
None found on the final build.

### P1 — major
None found on the final build.

### P2 — polish / spec drift

**P2-1 — DESIGN.md numbers and round names no longer match the implementation (balance/doc drift). — FIXED by Lead after report; not re-verified.**
- Repro: compare `docs/DESIGN.md` §6.2–6.3 with `src/core/config.ts`.
- Expected (DESIGN): base HP 100 (+2/level, cap 130); purses 40/80/140/250; betting 0/25/50/100;
  round 2 called “The Squires' Pass”; champion reward +250 denars / +200 XP / +5 renown.
- Actual (code): `COMBAT.baseHp = 120` (config.ts:130 → player starts 120 HP); purses
  `60/120/200/500` (config.ts:372–387); `TOURNAMENT.maxBet = 150` and bet chips include 150
  (config.ts:365, `src/ui/screens/board.ts` `BET_STEPS`); round 2 is “The Knights' Pass”
  (config.ts:377); champion renown 6 (config.ts:367) and round-4 purse 500.
- Evidence: `shots/qa/v1280x720-05-bracket.png` (“PURSE 60”), flow log
  `betChips [0,25,50,100,150]`, `maxBet=120`, champion result 500/65/6.
- Impact: docs/QA expectations mislead; no functional defect. Either DESIGN.md or config should be
  reconciled before release.

**P2-2 — Wager copy is ambiguous/misleading. — FIXED by Lead after report; not re-verified.**
- Repro: bracket → wager row reads “A winning wager pays 2 to 1”; bet 100 on round 1 and win.
- Expected per UI copy: profit of 2× the stake on a win (a “2 to 1” wager normally returns 2× profit).
- Actual: stake is taken up front (120 → 20 denars) and the payout adds `bet × 2` (200) to the
  reward. Net profit is **+1× stake** (1:1), not 2:1. `betPayout = 2` in `src/core/config.ts:366`
  returns the stake plus one stake of winnings.
- Evidence: flow log `bet=100 → denars 20 → round result rewardDenars=260 (purse 60 + betWon 200)`;
  `shots/qa/03-bet-1280x720.png` (copy), `v1920x1080-06-bracket-bet.png`.
- Suggested fix: either change copy to “returns 2× your stake” or pay `bet × 3` total.

**P2-3 — Benign `favicon.ico` 404 logged on every load. — FIXED by Lead after report (real favicon added); not re-verified.**
- Repro: open `http://127.0.0.1:5274/`, watch the console/network.
- Expected: no failed requests; `index.html` links `./favicon.svg` (present, HTTP 200).
- Actual: Chrome additionally probes `/favicon.ico` → HTTP 404, producing one console error per
  load (`Failed to load resource: the server responded with a status of 404`).
- Evidence: every `shots/qa/logs/*.log`, `shots/qa/*.json` `failedRequests` entries.
- Impact: noise only; would hide real console errors in CI. Fix: add a `favicon.ico` (or a
  `<link rel="icon" href="data:,">`), or ignore in CI.

### Fixed during QA (retested green on the final build)
- Friendly-fire kill used to print kill-reward lines (`You earned 4 denars`, `You got 8 experience`)
  while awarding no kill; now logs only `You struck down X — one of your own!` (combat suite PASS).
- Pause overlay stayed visually present after Resume; now `.bm-overlay-slot` goes
  `visibility:hidden` + opacity 0 (assertion passes).
- Overlay exclusivity (round result vs bracket vs melee result) — re-walked, screens are exclusive.
- Tab scoreboard — now renders rows and hides on release (verified directly).
- Camera rock occlusion and blood-decal density — re-inspected in final screenshots; no
  camera-inside-geometry frames; decals present without over-cluttering.

### Open risk (observed once, not reproducible)
- On an intermediate build (before the 19:12 rebuild) one 1280×720 session spawned **two player
  fighters and a duplicated house id** in tournament round 1 (16 fighters but 4 members of one house
  repeated, player present twice), which made the player instantly adjacent to enemies. After the
  rebuild this does not reproduce: 8+ tournament starts, and the new roster-integrity assertions
  (exactly 1 player fighter, unique team ids, correct members-per-team) pass for rounds 1–4.
  Recommendation: keep the roster assertion in CI in case it returns.

---

## 3. Screenshot evidence index

All under `shots/qa/` (1280×720 and 1920×1080 variants unless noted).

| Screen / state | Files |
|---|---|
| Main menu | `v1280x720-01-menu.png`, `v1920x1080-01-menu.png`, `01-menu-1280x720.png` |
| Controls | `v1280x720-02-controls.png`, `v1920x1080-02-controls.png` |
| Settings (menu + pause, low quality) | `v1280x720-03-settings.png`, `07-settings-1280x720.png`, `08-settings-low-1280x720.png`, `v1920x1080-11-pause-settings.png` |
| Credits | `v1280x720-04-credits.png`, `v1920x1080-04-credits.png` |
| Tournament board (+wager) | `v1280x720-05-bracket.png`, `v1280x720-06-bracket-bet.png`, `02-bracket-1280x720.png`, `03-bet-1280x720.png` |
| Round intro | `v1280x720-07-round-intro.png`, `04-round-intro-1280x720.png` |
| In-fight HUD / action | `v1280x720-08-fight-hud.png`, `09-fight-action.png`, `05-fight-1280x720.png` |
| Pause / pause-menu | `v1280x720-10-pause.png`, `06-pause-1280x720.png` |
| Round result win / champion round | `v1280x720-13-round-result-win.png`, `09-round1-result-1280x720.png`, `09-round4-result-1280x720.png` |
| Bracket rounds 2–4 | `v1280x720-14-bracket-round2.png`, `10-bracket-round{2,3,4}-1280x720.png` |
| Tournament champion | `11-tournament-champion-1280x720.png` |
| Round result defeat / tournament end defeat | `v1280x720-15-round-result-defeat.png`, `v1280x720-16-tournament-end-defeat.png`, `20-defeat-round-result-1280x720.png`, `21-tournament-end-defeat-1280x720.png` |
| Spectating after death / dead-but-advance / respawn | `22-spectating-1280x720.png`, `23-advanced-while-dead-1280x720.png`, `24-round2-after-dead-advance-1280x720.png`, `25-round2-respawn-1280x720.png` |
| Arena melee HUD / kill / defeat / clear | `v1280x720-17-melee-hud.png`, `30-melee-fight-1280x720.png`, `31-melee-kill-1280x720.png`, `32-melee-defeat-1280x720.png`, `33-melee-clear-1280x720.png` |
| Persistence / settings / VI | `40-menu-after-reload-1280x720.png`, `41-settings-menu-1280x720.png`, `42-menu-after-settings-reload-1280x720.png`, `43-menu-corrupt-storage-1280x720.png`, `44-menu-vi-1280x720.png` |
| Combat mechanics moments | `50-fight-block-1280x720.png`, `51-kick-1280x720.png`, `52-dodge-1280x720.png`, `53-lockon-1280x720.png`, `54-friendly-fire-1280x720.png`, `55-zoom-1280x720.png` |
| HUD detail crops | `zoom-01-log.png`, `zoom-02-hud-topleft.png`, `zoom-03-hud-vitals.png`, `zoom-04-crosshair.png` |
| Perf runs | `perf-t1280-high-30s/-60s/-end.png`, `perf-t1920-high-*.png`, `perf-m1280-low-*.png`, `perf-m1920-high-*.png` |

Raw data: `shots/qa/*.json` (flow-tournament, flow-defeat, flow-melee, persistence, combat, audio,
visuals, perf) and `shots/qa/logs/*.log`, `shots/qa/logs/dist-hash.txt`.

---

## 4. Performance / stability

Measured headless with `--disable-frame-rate-limit --disable-gpu-vsync` (uncapped rAF; real displays
are vsync-capped at 60, which stayed rock-solid when capped). Bot-driven (`?bot=1&autostart=...`),
sampled every 2 s.

| Run | Resolution | Quality | Duration | FPS avg / min / p10 | Max draw calls | Max tris | Stuck | NaN | Console errors |
|---|---|---|---|---|---|---|---|---|---|
| Bot tournament (reached end screen, lost R2) | 1280×720 | high | 75 s | 370 / 268 / 274 | 329 | 385 k | 0 | 0 | 0 |
| Bot tournament (reached R3) | 1920×1080 | high | 92 s | 204 / 156 / 159 | 382 | 417 k | 0 | 0 | 0 |
| Bot melee (died after ~31 s) | 1280×720 | low | 31 s | 371 / 230 / 287 | 245 | 271 k | 0 | 0 | 0 |
| Bot melee (died after ~51 s) | 1920×1080 | high | 51 s | 184 / 140 / 162 | 372 | 415 k | 0 | 0 | 0 |

Environment-only draw calls: **77** (main menu, no fighters) vs DESIGN budget ≤120; 16-fighter
tournament peak 329 → **~15–16 draw calls/fighter**, vs budget ≤35. Live quality switch (menu)
changed draw calls 59 (low) / 74 (medium) / 77 (high) with no errors.

No page errors, no failed requests beyond favicon, no NaN/Inf and no stuck fighter in any run.
Gameplay outcome of the bot runs also validated the loop end-to-end: tournament round
advance → bracket → next round, and melee death → result screen.

---

## 5. Coverage gaps / limitations

- **Audio quality** cannot be judged by ear in headless Chrome; verified graph state, all SFX/music
  calls, volume/mute behaviour, and that audio is fully procedural (no asset fetches).
- **Pointer-lock/Escape race (headless-only):** via CDP, `Escape` sometimes exits pointer lock
  (`pointerlockchange` → pause) *and* delivers a `keydown` that immediately resumes, so the pause
  panel can be skipped in headless runs. The product has a correct pointer-loss auto-pause
  (verified deterministically), and desktop Chrome does not forward the Esc keydown used to release
  pointer lock to the page, so this is treated as a harness artefact — worth one manual check in a
  real browser.
- Camera rock occlusion was inspected visually in final screenshots, not fuzz-tested around every
  obstacle.
- 60 fps was validated as a vsync-locked figure; uncapped numbers are throughput, not a guarantee
  for every GPU. No mobile/tablet/touch or Safari/Firefox pass was performed.

---

## 6. What's genuinely good

- **Presentation is shipped-game quality.** The bronze/parchment UI, Cinzel headings, bracket board,
  result panels and round intro all read coherently; 18 screens at both resolutions had **zero**
  overflow or clipped text. Screens are exclusive and readable at 720p and 1080p.
- **The full Mount & Blade loop actually closes:** 4-round bracket with team redraws, survivor
  counts, wagers, purses, champion and defeat screens, plus Warband-style “you fell but your house
  advances — you fight again next round”. Melee mode mirrors the reference with
  `Opponents Beaten / Opponents Remaining`, M&B-flavoured log lines, and rewards table.
- **Combat mechanics are real, not decorative.** All four attack directions resolve through the
  hold-drag + keyboard fallback path; directional shield blocks absorb fully with stamina cost;
  wrong-direction blocks take damage; guard break, kick stagger/cooldown, dodge i-frames, lock-on
  ring, sprint speed and weapon reach all match their config and were verified mechanically.
- **AI is stable and readable.** In ~4 minutes of bot play across 16/8/4/2-fighter rounds and melee
  waves: no stuck fighters, no NaN, no corpse attacks, no wall violations, no console noise.
- **Persistence and robustness.** Profile (denars/XP/level/renown/tournaments/best melee) survives
  reloads, mid-tournament reload cleanly returns to the menu, corrupted localStorage falls back to
  defaults, settings (quality/volume/language) persist, and the VI localisation really renders and
  survives reload.
- **Perf headroom and hygiene.** Environment 77 draw calls, ~15–16 per fighter, hundreds of fps of
  headroom at 720p and >150 fps at 1080p uncapped; no leaked asset requests; procedural audio
  unlocks on first click.
- **QA-friendliness.** `?seed`, `?bot=1`, `?autostart=tournament|melee`, `?quality=` and the
  `window.__game` debug surface (getState/startTournament/startMelee/enterRound/continueResult/
  killEnemies/pause/resume) made deterministic end-to-end testing possible — this is rare and
  valuable; keep it working.

---

## 7. How this was verified (reproducible)

```bash
# 1. Build + serve the current source (stable preview on 5274)
npx vite build
# preview server already running: http://127.0.0.1:5274/

# 2. Run the suites (each writes JSON + screenshots under shots/qa/)
node tools/qa/flow-tournament.mjs            # menu → bet → 4 rounds → champion → menu, 1280×720
node tools/qa/flow-tournament.mjs --width 1920 --height 1080
node tools/qa/flow-defeat.mjs                # defeat, lost wager, spectate, dead-but-advance, respawn
node tools/qa/flow-melee.mjs                 # melee HUD, kill wiring, death result, 35/35 clear
node tools/qa/persistence.mjs                # profile/settings/VI persistence + corrupted storage
node tools/qa/combat.mjs                     # controls, blocks, guard break, kick, dodge, lock-on, reach, bounds
node tools/qa/audio.mjs                      # unlock + every SFX/music call + volume
node tools/qa/visuals.mjs --width 1280 --height 720
node tools/qa/visuals.mjs --width 1920 --height 1080
node tools/qa/perf.mjs --width 1280 --height 720  --quality high --mode tournament --duration 90000
node tools/qa/perf.mjs --width 1920 --height 1080 --quality high --mode tournament --duration 90000
node tools/qa/perf.mjs --width 1280 --height 720  --quality low  --mode melee      --duration 60000
node tools/qa/perf.mjs --width 1920 --height 1080 --quality high --mode melee      --duration 60000
```

All scripts use system Chrome via `puppeteer-core`; screenshots go to `shots/qa/`, raw results to
`shots/qa/*.json` and `shots/qa/logs/`. Final-build suite summary (latest runs):

- flow-tournament 1280×720: **65/65** (includes roster-integrity checks for rounds 1–4)
- flow-defeat 1280×720: **22/22** (spectator banner `YOU HAVE FALLEN` read from `.bm-spectate`)
- flow-melee 1280×720: **24/24** (real kill wiring, death result, 35/35 clear)
- persistence: **20/20** (profile, settings, quality, VI round-trip, corrupt-storage fallback)
- combat: 38/38 (includes fixed friendly-fire + Tab scoreboard)
- audio: 10/10
- visuals 1280×720: 19/19, visuals 1920×1080: 19/19
- perf/stability: 4 runs, 0 stuck, 0 NaN, 0 console errors, 0 failed requests
