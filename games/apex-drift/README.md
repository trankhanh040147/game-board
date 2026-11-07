# Apex Drift

A zero-dependency WebGL2 arcade street racer. Three cars, two night circuits, five rivals, three laps and no downloads — everything is generated in code.

## Run

Node.js 20 or newer is required for the local server; there is nothing to install.

```sh
node tools/serve.mjs
```

Then open <http://localhost:8080>. The server listens on port `8080`; set `PORT` to use another one:

```sh
PORT=3000 node tools/serve.mjs
```

`npm run serve` is a shortcut for the same command. The game itself is plain ES modules, so it also runs from any static file server that serves the repository root.

## Test

```sh
npm test
```

The suite uses Node's built-in test runner and covers the maths library, the mesh builder, the track spline and surface queries, tuning/config integrity, the fixed-step loop, persistence, input mappings, HUD/audio Node fallbacks, car physics, the race director, and the procedural car/world meshes. It needs no browser, no network and no dependencies, and runs in a few seconds.

## Controls

| Input | Action |
| --- | --- |
| `W` / `Up` | Throttle |
| `S` / `Down` | Brake, then reverse |
| `A` `D` / `Left` `Right` | Steer |
| `Space` | Handbrake (start or hold a drift) |
| `Shift` | Nitro |
| `C` | Cycle camera: chase, hood, wide |
| `P` / `Escape` | Pause or resume |
| `R` | Restart the current race |
| `Q` | Quit to the garage |
| `M` | Mute / unmute |
| `Enter` | Confirm, enter the garage, start the race |
| `F` | Toggle fullscreen |

In the garage, the arrow keys cycle circuits, `[` `]` (or `Q` `E`) cycle cars, and the cards are regular buttons, so clicking and keyboard focus both select. `Enter` starts the race.

## Gameplay

- **Race three laps against five rivals.** You start at the back of a six-car grid, the countdown runs on the HUD and the results screen lists every driver's best lap and total time.
- **Pick a machine with its own character.** `VANKO GT-R` is an all-wheel-drive grip car, `RHINO 440` is a heavy rear-drive muscle car with the highest top speed, and `KIRA S1` is a light rear-drive drift build with the fastest steering.
- **Two circuits with different scenery and elevation.** `NEON BAY` is a 1.75 km downtown loop of wide boulevards and glass towers; `SUNSET CANYON` is a 1.88 km ridge run with long climbs, blind crests and a hairpin.
- **Drift for nitro.** The handbrake cuts rear grip so the car rotates; the HUD's drift meter shows the slide, and drifting recharges the nitro tank faster than normal driving. Held nitro raises the top speed and adds thrust.
- **Surface matters.** Asphalt is full grip, kerbs less, grass much less, and the track's walls and barriers keep the field inside the circuit.
- **Records live in the browser.** Best lap and best total per circuit, plus races completed, wins, and your last car, circuit, quality and camera choices are saved in `localStorage` under `apex-drift.records`.
- **Camera and quality settings** are selectable in the garage and remembered between sessions.

## Tips

- Brake before the corner, not in it: the car is much happier slowing in a straight line and then rotating on the handbrake.
- Tap the handbrake to break traction, then catch the slide with opposite steering and throttle. Holding it too long just slows you down.
- Save nitro for corner exits and long straights; firing it while the car is already sliding mostly wastes the tank.
- Use the wide camera to place the car for a pass, then switch back to chase for the braking zone.
- On `SUNSET CANYON`, the crests hide the next corner — lift early on the climb and hug the inside of the hairpin.

## Features

- **WebGL2 only, zero dependencies.** No framework, no build step, no node modules. One `<script type="module">` entry point.
- **Procedural geometry, no textures or asset files.** Cars, road, kerbs, barriers, buildings, rocks, plants, lamps and the car meshes are all generated from code and drawn with vertex colours. Emissive vertex alpha makes windows, neon, headlights and taillights glow through fog.
- **Forward renderer with a single vertex format.** Positions, normals and RGBA colours in one interleaved-free layout; the static world is merged into a handful of large batches so the scene draws in tens of calls rather than thousands.
- **Deterministic fixed-step simulation.** Physics runs at 120 Hz with an accumulator and up to eight substeps per frame, clamped frame time and seeded `mulberry32` randomness in the AI. The same seed and inputs reproduce a race.
- **AI racing line.** Opponents use a pure-pursuit steering model against the spline, signed curvature for braking and an offset line through corners, with skill-based pace and mild rubber-banding.
- **Procedural WebAudio.** Engine, wind and tyre noise are synthesized from oscillators and filtered noise at runtime; no audio files, and everything degrades to silence when WebAudio is unavailable.
- **Graceful failure.** Losing WebGL2, `localStorage`, the HUD canvas or audio never breaks the game — the shell falls back to an in-memory store, a no-op HUD or an inert audio object.

## File layout

```text
.
├── index.html                 # Page shell: canvases, screens, controls
├── style.css                  # Page shell, menus, HUD effects, responsive rules
├── package.json               # Zero dependencies; test + serve scripts
├── README.md
├── src/
│   ├── app/
│   │   ├── audio.js           # Procedural WebAudio engine and SFX (lazy, no-op fallback)
│   │   ├── hud.js             # 2D canvas HUD: dial, nitro, drift, standings, minimap
│   │   ├── input.js           # Keyboard/gamepad mapping and discrete commands
│   │   ├── loop.js            # Fixed-step accumulator with injected rAF
│   │   ├── main.js            # Boot, state machine, scene assembly, integration
│   │   ├── storage.js         # Records and preferences, defensive persistence
│   │   └── ui.js              # Screens, garage cards, results table, toasts
│   ├── core/
│   │   ├── math.js            # scalar/vec3/mat4 helpers
│   │   ├── mesh.js            # Vertex builder, primitives, merging
│   │   └── rng.js             # Seeded mulberry32 PRNG
│   ├── render/
│   │   ├── camera.js          # Chase/hood/wide/orbit camera rigs
│   │   ├── carModel.js        # Procedural car body and wheel meshes
│   │   ├── gl.js              # WebGL2 context and buffer helpers
│   │   ├── props.js           # City and canyon scenery composition
│   │   ├── renderer.js        # Forward renderer: sky, fog, batches, glows, shadows
│   │   ├── shaders.js         # GLSL sources
│   │   └── worldMesh.js       # Track + scenery merged into draw batches
│   └── sim/
│       ├── ai.js              # Opponent drivers
│       ├── car.js             # Arcade vehicle dynamics
│       ├── collisions.js      # Wall/kerb and car-car response
│       ├── config.js          # All tuning: timing, car specs, tracks, palettes
│       ├── race.js            # Grid, countdown, laps, standings, results
│       ├── spline.js          # Closed Catmull-Rom sampling
│       └── track.js           # Track build and nearest-point surface query
├── tests/                     # node:test suites (math, mesh, track, config,
│                              # loop/storage/input, car + race, render meshes,
│                              # HUD/audio fallbacks)
└── tools/
    ├── inspect-track.mjs      # Track statistics and ASCII minimap
    ├── renderer-smoke.html    # Minimal renderer smoke page for debugging
    ├── screenshot.mjs         # Headless-Chrome CDP verification harness
    ├── serve.mjs              # Zero-dependency static server
    └── world-preview.html     # Static-world preview page for debugging
```

`tools/shots/` is gitignored: screenshots produced by the verification harness are evidence, not source.

## Performance and browser support

- Requires a browser with **WebGL2**: current Chrome, Edge, Firefox and Safari 15 or newer. Without it the title screen explains what is missing instead of failing silently.
- The renderer draws one batch per static mesh group plus one draw per car, wheel, glow and shadow blob. On a typical desktop GPU the whole scene is well under a few hundred draw calls and roughly 50–75k static triangles.
- Three quality tiers (`low`, `medium`, `high`) set draw distance (420 / 650 / 1000 m), pixel ratio caps (0.75 / 1.0 / 1.5), glow counts and shadow detail. Pixel ratio is also capped by the device, so Retina displays stay crisp without exploding the fill rate.
- The simulation is independent of frame rate; a slow frame is caught up in fixed substeps and a very long stall is clamped rather than fast-forwarded. The game pauses itself when the tab becomes hidden.
- It runs on software rendering (SwiftShader) too, which is useful for CI screenshots but far below real-time.

## Accessibility

- The complete flow — title, garage, race, pause, results — can be driven with the keyboard alone; no mouse or touch input is required.
- Menus and the garage are real buttons and selects with visible `:focus-visible` outlines, `aria-pressed` state on selected cards and labelled screens and live regions for the loading and toast messages.
- The 3D canvas carries an `aria-label`, the HUD canvas is `aria-hidden`, and the page has a `<noscript>` fallback.
- Respects `prefers-reduced-motion`: CSS effects such as speed lines and flashes are toned down, and the HUD keeps the same information.
- `M` mutes all audio, and the sound state is saved with the other preferences.

## Verification

Two tools check the build outside the test suite:

```sh
node tools/inspect-track.mjs
```

Prints length, sample spacing, elevation range, tightest corner radius, self-clearance and an ASCII minimap for both circuits; useful when editing control points, and it warns when two parts of a circuit come too close together.

```sh
node tools/screenshot.mjs
```

Launches an isolated headless Chrome with software WebGL2 over the Chrome DevTools Protocol and walks the real page: title, garage, countdown, race, both extra camera modes, pause/resume and a three-second full-throttle run that asserts the car actually moves. It collects console errors and uncaught exceptions, writes `01-title.png` through `08-driving.png` plus `run-summary.json` into `tools/shots/`, and exits non-zero on any failure. It starts `tools/serve.mjs` itself (on the default port, or a free one if that port is busy); pass `--url` and `--no-serve` to point it at a server you started yourself.

## How it works

A hand-authored loop of control points is turned into a closed Catmull-Rom spline, resampled to uniform arc length and decorated with tangents, right vectors and signed curvature. That sample chain is the single source of truth: the world mesh and minimap are built from it, the car queries it every physics step to find the nearest road point and surface, and the AI uses its curvature to plan braking and corner lines. The simulation is a deterministic 120 Hz fixed-step loop of pure functions — car dynamics, wall response, car-to-car contacts, then lap and standings bookkeeping — while rendering happens once per animation frame. Static geometry is merged into a few large vertex-colour batches, cars and wheels are instanced by reusing their meshes with per-frame model matrices, and everything else (sky, fog, glow billboards, contact shadows, HUD and synthesised audio) is presentation on top of the same simulation state.
