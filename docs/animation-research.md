# Baked animation retargeting — research + prototype report

**Task:** task-8 — replace/augment the stiff procedural fighter animation with high-quality baked
animation clips retargeted onto the existing 7.3-head fighter rig.
**Verdict: MATERIALLY BETTER (with two fixable caveats).** Recommended for integration behind a flag.
**Status: INTEGRATED behind a flag** — baked clips load at startup from
`/assets/knight-anim.json`; `?anim=procedural` forces the old procedural path;
`window.__game.setAnimationMode('baked'|'procedural')` hot-swaps live rigs for A/B QA.

- Lab: `http://127.0.0.1:5273/animation-lab.html` (served by the normal Vite dev server)
- Main screenshot: `shots/anim-lab.png` (all 4 fighters running from the baked animator)
- Side-by-side proof (baked left, procedural right): `shots/anim-c3-run.png`,
  `shots/anim-c3-atk.png`, `shots/anim-c3-ovh.png`, `shots/anim-c3-death.png`
- Death / gait / attack stills: `shots/anim-c3-death.png`, `shots/anim-lab-gait.png`,
  `shots/anim-lab-attack.png`, `shots/anim-lab-death.png`
- Code: `animation-lab.html`, `src/dev/animation-lab.ts`, `src/dev/bake-knight-anim.mjs`,
  `src/characters/bakedAnimator.ts`, data `public/assets/knight-anim.json`
- Asset: offline `assets-src/Knight.glb` (not shipped; CC0 KayKit Adventurers Knight, 76 clips)

---

## 1. What was built

1. **Offline retarget bake** (`src/dev/bake-knight-anim.mjs`, Node, no deps): parses the GLB
   directly (nodes + animation accessors), retargets 31 clips onto our skeleton, writes
   `public/assets/knight-anim.json` (514 KB, 30 fps, per-bone local quaternions + hip translation).
   Runs in ~0.12 s.
2. **Lab** (`animation-lab.html` + `src/dev/animation-lab.ts`): 4 fighters, clip dropdown + buttons,
   freeze-at-phase for deterministic stills, clip-time/fps HUD, retarget profile sliders, camera
   presets, and a fair **side-by-side mode** (identical loadouts, baked left / procedural right; the
   procedural row is deterministically replayed to the same phase for screenshots).
3. **Production module** (`src/characters/bakedAnimator.ts`): `BakedCharacterAnimator` implements the
   exact `CharacterAnimator` surface (`pose`, `update`, `setMotion`, `setGuard`, `playAttack`,
   `playAction`, `setLookTarget`, `setDead`, `isDead`, `trailActive`, `attacking`) so it is a
   drop-in swap inside `rig.ts`; library loader/parser + retarget profile + debug helpers.
4. **This document**: mapping, maths, risks, integration steps, and what still needs tuning.

The lab now runs the *production* animator for live playback (state machine), and the same class's
`debugFreezeClip()` for screenshots — so what the Lead sees is the integration candidate, not a
throwaway lab player.

---

## 2. Retarget maths

Our rig is a rigid-part `SkinnedMesh` whose bones all have **identity rest rotations** (geometry is
authored in bone-local space; see `PartCollector.buildSkinned`). That makes the retarget unusually
simple and robust: we only need each source bone's **world orientation** per frame, then convert a
world-space motion delta into our local quaternion chain. No T-pose, bind-matrix or root-scale
surgery is required, and no source meshes are used.

For source bone `b` at time `t`:

```
W_b(t)  = world orientation from the source's own rest hierarchy, root node ignored
W_b(ref)= world orientation in the neutral reference pose (source Idle, t = 0)
D_b(t)  = W_b(t) * W_b(ref)^-1                 world-space delta from neutral
target world(b) = D_b(t)                        (our bind stance is the base, so no extra offset)
target local(b) = D_parent(t)^-1 * D_b(t)       our hierarchy is identity-rest
```

Why the reference is `Idle` and not the source T-pose: our authored bind pose is already a standing
combat stance. Referencing Idle means "source Idle == our bind pose", so all clips are applied as a
motion delta on top of our silhouette. The source's arms are down at idle and ours are authored down
at the sides, so run/attack deltas land naturally. Using the T-pose as reference would over-rotate
the arms by ~90°.

Other extraction rules:

| Source | Handling |
|---|---|
| `root` node translation + rotation | **ignored** (locomotion/steering; game moves the root). This also removes turn-in-place from strafing clips and the 180° flip in `2H_Melee_Attack_Spin`. |
| `hips` translation | kept as a raw delta from the reference pose. Runtime scales: `hipY` (vertical bob/crouch, default 1.3×), `hipXZ` (weight shift/lunge, 0.6×), `deathHipY` (2.8×). |
| `toes.*` | ignored (no toe bone; foot inherits). |
| `wrist.*` | folded into the hand world orientation (`lowerarm → wrist → hand` chain), so the baked hand delta includes wrist motion. |
| no `neck` in source | chest→head rotation split with `neck = slerp(identity, headLocal, 0.3)`, `head = neck^-1 · headLocal`, so the head doesn't hinge at the collar. Our `neck` bone is otherwise procedural-free. |
| no cape bone in source | cape stays procedural (speed + sine secondary motion in the animator). |
| shields | shield transform reuses `rig.ts`'s existing "shield face aligned to torso, riding the left forearm" formula from the baked arm pose. No extra retarget work. |

Pelvis rotation: `RigPose` has no hips rotation channel (rig.ts applies `pose.bodyRot` to the `body`
joint and `pose.hipsOffset` to the pelvis). The baked pelvis quaternion is written to `bodyRot`, then
the hips local offset is solved so the pelvis *world* position is exact:

```
hipsWorld  = SKELETON.hips + hipTranslationDelta
hipsLocal  = inverse(hipsQ) * hipsWorld      // because body is rotated by hipsQ
hipsOffset = hipsLocal - SKELETON.hips
```

Runtime sampling: clips are baked at 30 fps; playback linearly interpolates frames and **slerps**
local quaternions (sign-continuity enforced at bake), then converts to Euler XYZ per bone — matching
exactly what `rig.ts::applyPose` consumes. No per-frame allocation in the animator (preallocated
quaternion/vector scratch).

---

## 3. Clip mapping (31 baked clips)

| Game need | Baked clip(s) | Loop | Notes |
|---|---|---|---|
| idle | `Idle` (1H), `Idle2H` | yes | `2H_Melee_Idle` reads as a two-handed combat idle. |
| walk | `Walk` (Walking_A), `WalkB` | yes | gait phase shared with run so crossfades line up. |
| run | `Run` (Running_A), `RunB` | yes | source run is a shield-forward combat run — reads great on our rig. |
| strafe | `StrafeL`/`StrafeR` (Running_Strafe_*) | yes | source root rotation ignored → torso faces forward, legs step sideways. |
| backpedal | `Back` (Walking_Backwards) | yes | |
| guard | `Guard` (Blocking), `Guard2H` (Block) | yes | shield raised / two-handed block stance. |
| block hit | `GuardHit` (Block_Hit) | no | mapped to the `bash` action. |
| attack right | `AttackR` (1H Slice_Diagonal), `AttackR2H` (2H Slice) | no | |
| attack left | `AttackL` (1H Slice_Horizontal), `AttackL2H` (2H Chop) | no | |
| attack overhead | `AttackO` (1H Chop), `AttackO2H` (2H Chop) | no | |
| attack thrust | `AttackT` (1H Stab), `AttackT2H` (2H Stab) | no | |
| hit / stagger | `Hit` (Hit_A), `Stagger` (Hit_B) | no | |
| kick | `Kick` (Unarmed_Melee_Attack_Kick) | no | |
| dodge L/R/B/F | `DodgeL/R/B/F` | no | chosen from the world-space dodge direction rotated into root space. |
| death | `DeathA` (fall back), `DeathB` | no | clamped on the final lying pose; `deathHipY` profile controls collapse height. |
| victory/taunt | `Cheer` | no | |
| unarmed idle | `UnarmedIdle` | yes | available for future unarmed/NPC variants. |

Attack timing: the game owns `attackTiming(weapon, speedMul)` (windup → active → recover, ~0.66 s
total). Baked attack clips are 0.83–1.67 s long, so playback is **time-warped**: clip phase =
`attackElapsed / timing.total`, i.e. the whole authored swing is compressed into the authoritative
window and the impact proportion is preserved. `trailActive` is derived from the same timing window,
so weapon trails keep working.

Performance: clip data is 514 KB JSON (loaded once, shared by all fighters); per-fighter update is
~16 slerps + 16 Euler conversions with zero allocation. Draw calls are unchanged (same skinned
meshes); source meshes/skeleton are **not** loaded at runtime (bake is offline), so no GLB fetch,
no GLTFLoader, no extra textures.

---

## 4. Lab + reproducibility

```
npm run dev                                   # http://127.0.0.1:5273
node src/dev/bake-knight-anim.mjs             # regenerate public/assets/knight-anim.json
node tools/shot.mjs --url http://127.0.0.1:5273/animation-lab.html \
  --out shots/anim-lab.png --wait 6000
```

Lab API (`window.__lab`) for deterministic captures:
`setClip(name)`, `setPhase(0..1)`, `setFreeze(bool)`, `setSide(bool)`, `setProfile({hipY, hipXZ, deathHipY, speed})`,
`view(name)`, `compare()` (side-by-side, same loadout, both replayed to the same phase), `focus(slot)`,
`setCamera(px,py,pz,tx,ty,tz)`, `showAll()`, `info()`.

URL params: `?clip=Run&phase=0.3&freeze=1&side=0&view=compare&hipY=1.3&hipXZ=0.6&deathY=2.8`.

Camera presets: `wide`, `front`, `side`, `close`, `hero`, `compare`, `game` (over-the-shoulder at
~3.5 m, to sanity-check game-camera framing).

---

## 5. Evidence / assessment

**Materially better: locomotion, attacks, death.**
Side-by-side at the same phase (`shots/anim-c3-run.png`, `anim-c3-atk.png`, `anim-c3-ovh.png`):

- **Run** — baked fighter leans into a committed lunge with shield raised, sword arm driving, one
  knee up mid-stride. Procedural fighter stands nearly upright with the sword held horizontally and
  almost no hip/shoulder counter-rotation. This is the clearest step-change.
- **Overhead attack** — baked windup coils the torso and raises the blade vertically overhead (great
  telegraph readability); procedural is a shallower diagonal raise.
- **Diagonal slash follow-through** — baked sweeps across the body with shoulder/torso rotation;
  procedural returns to a symmetrical stance.
- **Death** — baked collapses onto the back into a settled corpse pose; procedural splays limbs with
  the weapon still pointing up. Baked is clearly more believable.
- **Guard** — baked Blocking pose is a proper shield-forward brace; procedural is an approximation.

**Caveats (honest):**

1. **Weapon grip** — the rig's `weapon` joint rotation was authored for the procedural ready pose.
   With baked hand orientations, blades/hafts pointed oddly (e.g. sword horizontal across the belly
   at idle). Fixed by a per-weapon-kind hand-local correction (`WEAPON_GRIP_X` in
   `bakedAnimator.ts`; applied to `pose.rot.handR`, so `rig.ts` needs no change). Sword/saber/
   greatsword/axe/mace values were eyeballed at idle/run/overhead and look natural; they still want
   one pass of per-weapon tuning in-game (`axe`/`mace`/`spear` least verified).
2. **Rigid-segment seams at extreme angles** — at the deepest run knee/ankle angles the boot can read
   slightly detached from the shin (rigid skinning, one joint per part). Visible in
   `shots/anim-rs-l.png` / `anim-rs-r.png` at 4 m, much less at gameplay distance. Mitigations:
   the model already has joint-fill spheres; options are (a) increase ankle/knee fill overlap in
   `model.ts`, (b) clamp extreme foot rotation, (c) accept at 3.2–3.8 m camera. This is a
   *model/rig* issue, not a retarget issue.
3. **Foot contact / sliding** — the rig's existing sole-pin (adjust `pose.hipsOffset.y` until the
   lowest sole is on the sand) is reused verbatim, so feet stay on the ground for every non-death
   clip. Sliding is handled by the `strideWalk/strideRun/strideStrafe/strideBack` profile knobs
   (gait phase advance = speed / stride); these defaults are estimates from our leg length and must
   be tuned in-game against the actual movement speeds.
4. **Hip translation scaling** — vertical bob 1.3×, horizontal 0.6× (lunge/weight shift), death 2.8×.
   Tuned by eye at the lab; death collapse in particular may want its own value per clip family if
   corpse height bothers QA.
5. **Not yet tested in the actual game** (behind a flag) — the lab reproduces the rig's pose
   application, foot pin and shield transform, but not the game's hit-stop, camera, root movement,
   opacity/corpse fade, or audio timing.

---

## 6. Integration plan (drop-in behind a flag)

`rig.ts` currently does:

```ts
const animator = new CharacterAnimator({ loadout, seed });
...
animator.update(step, root.rotation.y, TMP_V1);
applyPose();
```

Proposed minimal change (character-artist / Lead):

1. Load the library once in the game bootstrap (`loadBakedAnimatorLibrary('/assets/knight-anim.json')`,
   or `parseBakedLibrary(await (await fetch(...)).json())`) and pass it into
   `createCharacterRig({ ..., animator?: BakedClipLibrary })` via a game flag
   (`?bakedanim=1` / Settings toggle) so the procedural path remains the fallback.
2. In `createCharacterRig`, pick the animator:
   ```ts
   const animator = bakedLib
     ? new BakedCharacterAnimator(bakedLib, { loadout, seed: appearance.seed + 0x9e37 })
     : new CharacterAnimator({ loadout, seed: appearance.seed + 0x9e37 });
   ```
   `BakedCharacterAnimator` exposes the same members used by `rig.ts`: `pose`, `update(dt, yaw, pos)`,
   `setMotion`, `setGuard`, `playAttack(dir, speedMul)`, `playAction(action, opts, yaw)`,
   `setLookTarget`, `setDead`, `isDead`, `trailActive`. `rig.ts`'s `applyPose`, shield transform,
   foot pin, trail sampling and opacity code are untouched — verified by construction in the lab,
   which re-implements them against the same `RigPose`.
3. The game already passes `speedMul` from `ATTACK_TIMING`; the baked animator time-warps clips into
   that window, and emits `trailActive` in the same place the procedural one does, so hit-stop and
   weapon trails line up without combat changes.
4. Tune `DEFAULT_RETARGET_PROFILE` (hip Y/XZ, death Y, stride lengths) and `WEAPON_GRIP_X` against
   live gameplay. Expose them on `window.__game.debug` if useful.
5. QA focus: attack impact alignment, dodge distance (root motion intentionally dropped — the game's
   dash still needs to match the visual lean), foot sliding while sprinting-strafing, corpse height
   on slopes/ground (arena is flat), and whether the seams in caveat 2 bother at the 3.2–3.8 m
   camera.
6. If rolled back: delete the animator choice + library load; the procedural path is unchanged.

**Deletion/complexity budget:** one new file (`src/characters/bakedAnimator.ts`, ~700 lines incl.
docs), one data asset (514 KB), one dev bake script, one lab page + lab script. No new npm deps.

---

## 6b. In-game integration verified (real game, game camera)

Implemented exactly as planned:

- `src/main.ts`: loads `/assets/knight-anim.json` once before `Game` construction
  (`Promise.race` against a 4 s timeout). On timeout/error it logs one warning and falls back to
  procedural; `?anim=procedural` forces procedural. The loaded library is registered via
  `setBakedAnimationLibrary()` / `setAnimationMode()` and never blocks the game on failure.
- `src/characters/rig.ts`: `createCharacterRig()` picks `BakedCharacterAnimator` when the library is
  available and the mode allows it, else `CharacterAnimator` (union-typed `animator`). `applyPose`,
  shield transform, sole pinning and weapon-trail sampling are untouched. `setLiveAnimationMode()`
  hot-swaps the animator on every live rig (used by the debug API). Baked `playAttack` accepts and
  ignores the weapon argument so `rig.ts` calls both animators uniformly.
- `window.__game.animationMode()` / `window.__game.setAnimationMode('baked'|'procedural')` added to the
  existing debug API (no game-file changes).

In-game captures (melee autostart + bot, seed 123, game camera, 1280×720):

| shot | mode | observed |
|---|---|---|
| `shots/game-baked-A.png` | baked | mid-fight: wide planted sword swing, corpse lying flat on the sand, fps 60, 203 draw calls, 280 k tris, no console errors |
| `shots/game-procedural-A.png` | procedural | same seed/time; fighters read more upright/symmetrical, no corpse in frame |
| `shots/game-baked-melee.png` | baked | 35-opponent melee; fighters engaged; 60 fps, 191 draw calls |
| `shots/game-death.png` | baked | after `__game.killEnemies()`: `{mode:'baked', fighters:6, alive:1, fps:60, drawCalls:191, triangles:271277}`, no console errors — death collapse/grounding confirmed in-game |
| `shots/game-baked-B.png`, `shots/game-procedural-B.png` | baked/proc | late-fight A/B (`wait 20s`): 233 draw calls baked, 60 fps |

No console errors in any baked run. Death now clearly collapses onto the sand (see corpse in
`game-baked-A.png`); feet stay planted through the game camera; weapon/shield silhouettes read
normally at 3.2–3.8 m. Remaining known issue is the rigid ankle/knee seam at extreme run angles
(see caveat 2) and per-weapon grip tuning for axe/mace/spear.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Rigid seams at extreme knee/ankle bends | Medium (up close) | joint-fill overlap in `model.ts`, clamp foot/limb rotation, or accept at gameplay distance |
| Weapon grip per-weapon correctness | Medium (reads wrong in game) | tune `WEAPON_GRIP_X` per weapon in gameplay; source clips are sword-and-shield only, axe/mace/spear are approximations |
| Foot sliding from stride tuning | Medium | `stride*` knobs; optionally scale gait by actual velocity vector |
| Baked locomotion lacks root motion | Low (intended) | game moves root; dodges lean without translating |
| Death pose not ground-clamped | Low–Medium | `deathHipY` profile; optional ground-clamp step after `setDead` |
| Asset/data drift | Low | regenerate with `node src/dev/bake-knight-anim.mjs`; JSON is deterministic |
| Crowd visual sameness | Low | `seed` phase offset available; can add per-fighter clip offset later |

---

## 7b. Credits / licence

The animation clips come from **KayKit Adventurers — Knight by Kay Lousberg (KayKit)**, released
under **CC0 1.0 Universal (public domain)**: https://kaylousberg.itch.io/kaykit-adventurers .
Only animation data was used (no meshes/textures/skeleton shipped); see
`public/assets/Knight-LICENSE.txt` for the full attribution/provenance note.

> Suggested README line: *Animation clips based on KayKit Adventurers by Kay Lousberg (CC0 1.0).*

## 8. Follow-ups (not done, recommended next)

1. Rig `model.ts`: enlarge knee/ankle joint-fill spheres (or add elastic weight blend) to remove the
   rigid seam at deep bends.
2. Per-weapon grip calibration session in the game camera with the 8 weapons.
3. Tune stride lengths against real movement speed; add a `setMotion` velocity-aware gait scale.
4. Optional: ground-clamp the death clip (sample corpse bounding box / lowest sole) and add a
   settle bounce.
5. Optional: use `2H_Melee_Attack_Spin` for a special spin attack (currently baked but unused).
6. Decide idle flavour: `Idle` (arms relaxed, shield low) vs `Blocking` (shield raised) per weapon
   set — currently `Idle` / `Idle2H`.
