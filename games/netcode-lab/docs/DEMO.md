# Demo script

Presenter script for Netcode Lab. One section per preset from HANDOFF B.6. Each section names the idea, what to
click and what to point at (the B.6 "Observe" column, which is also the acceptance criterion). A section changes
from "not built yet" only when the preset works in the running game.

## Setup

The server listens on two ports (defaults from `cmd/server/main.go` flags and the Makefile):

| Port | Flag | Serves |
|---|---|---|
| 8080 (TCP) | `-http` | Plain HTTP: page + WebSocket (`/ws`). WebSocket-fallback mode. |
| 8443 (TCP + UDP) | `-https` | HTTPS page + WebTransport (`/wt`) on the same port number. Self-signed ECDSA cert minted at start. |

1. On the host, from games/netcode-lab: `make client` once on a fresh clone, then `make run` (builds WASM, server and client, then runs
   `bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443`).
2. Admin token for the Lab panel: set `NETLAB_ADMIN_TOKEN`, or copy the generated `adminToken` from the server log.
3. LAN players open `https://<host-ip>:8443` and accept one certificate warning. The start card then shows
   "✓ Game server connected over WebTransport" (seen 2026-11-23 @ e10d4de on https://127.0.0.1:8443, headless Chrome 156).
4. If that fails, players open `http://<host-ip>:8080`. The start card shows "connected over WebSocket" and the banner
   shows "WebSocket fallback — page is plain HTTP, not a secure context; game packets go over TCP." (seen 2026-11-23 @ e10d4de
   on http://172.16.3.48:8080). Note: `http://127.0.0.1:8080` is a secure context, so on the host itself that URL
   uses WebTransport. Add `?transport=ws` to force WebSocket.
   Not verified: a second machine on the LAN, and the certificate warning click in a headed browser.
   Full host checklist: [PLAYTEST.md](PLAYTEST.md).
5. Allow TCP 8080 and TCP + UDP 8443 through the host firewall.

## How to read "Observed"

Every observed number carries its source:

- **[screen]** scribe saw it on a page in Chromium (text copied from the page).
- **[page data]** read by scribe's browser script from the page's own session (shot events, server `stats`, session counters); not drawn on screen.
- **[bot]** measured by a bot or CLI tool (`bin/bot`, `bin/duelbot`, `bin/beaconbot`), not in a browser.
- **[smoke]** from the client smoke test (`client/smoke/smoke.mjs`).
- **[research R6, headed browser]** measured by member research, not by scribe.

## Presenter control page

Opening the Lab on the play page leaves play (pointer lock drops). Drive the Lab from a **second page** instead:
open `https://<host-ip>:8443/?admin=<token>` in another browser window or on another device, press F1 there, and
click presets. Every client receives the change; the play page keeps playing.

## Core netcode (A.4–A.10)

Walk 2026-11-23 @ `078053b`: headless Chrome for Testing 156, three separate browsers (player, target, control page with `?admin=`), 2 walker bots, server `bin/server -http 127.0.0.1:18502 -https 127.0.0.1:18545` (PID recorded, alive for the whole walk), default conditioner. Values below are copied from the player page unless noted.

### P01 — Vocabulary

Status: verified 2026-11-23 @ 078053b

- **Idea:** Vocabulary. See [CONCEPTS.md](CONCEPTS.md#a1).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P01** → F1. The play page stays in play. Read the net graph (top left).
- **What to point at (B.6):** All four values visible and correct.
- **Observed:**
  - [screen] Banner: "P01 Vocabulary — Clients send what the player did (inputs); the server decides what happened (positions, hits, deaths). Read A.1 →"
  - [screen] Net graph: RTT 46 ms "measured, incl. simulated 40 ms", server tick "8305 @ 64 Hz", snapshots "19.0/s (set 20)", FPS "61 (16.6 ms)".
  - [screen] Scorecard: all four ✓ (lag compensation is built now).

### P02 — Dumb client (A.4)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Dumb client (A.4). See [CONCEPTS.md](CONCEPTS.md#a4).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P02** → F1. The play page stays in play. Play page: tap **W** from standing still 5–6 times.
- **What to point at (B.6):** Pressing W moves you only after about one RTT plus waits; HUD "input → motion: N ms" (measured). Scorecard Instant ✗, Cheat-proof ✓.
- **Observed:**
  - [screen] Mode HUD: "input → motion: 114 ms (measured, incl. simulated 40 ms RTT, median of 6) · 40–72 ms est. (A.4, no pacer margin)".
  - [screen] Scorecard: ✗ Instant "waits for the server (no prediction)", ✗ Smooth, ✓ Cheat-proof.

### P03 — Trust client (A.5)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Trust client (A.5). See [CONCEPTS.md](CONCEPTS.md#a5).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P03** → F1. The play page stays in play. Control page: F1 → P03 → **Send forged headshot claim** (the "modded client"). Then apply P01 and send it again.
- **What to point at (B.6):** In trust mode fake kills land in the kill feed. In authoritative modes the same packets are rejected and logged "rejected claim".
- **Observed:**
  - [screen] Trust mode (P03): kill feed on the player page "demo-control ☠ HS trust-mode claim bot-walker-2": the forged claim lands.
  - [screen] Authoritative (P01): kill feed "rejected claim from demo2-control: "hit bot-walker-2 in the head" — server authority: clients send inputs, not results" (second run, same build).
  - [screen] Scorecard in P03: ✓ Instant "client simulates itself", ✓ Fair "client claims its own hits", ✗ Cheat-proof "server relays client claims".

### P04 — Prediction (A.6)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Prediction (A.6). See [CONCEPTS.md](CONCEPTS.md#a6).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P04** → F1. The play page stays in play. Play page: tap **W** from standing still, then hold W.
- **What to point at (B.6):** Own movement reacts in the current frame while the server still decides.
- **Observed:**
  - [screen] Mode HUD: "input → motion: 9 ms (measured, prediction on: no network wait, median of 2)" — under one 16.7 ms frame (was 44 ms in the S4 walk; fixed in `c250ab0`).
  - [screen] "pending: #1398 … · replayed: 0 · corrections: 25 (since last Lab change) · reconcile OFF (hard snap)".
  - [screen] Scorecard: ~ Instant "predicted, but snaps back without reconciliation".

### P05 — Reconciliation (A.7)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Reconciliation (A.7). See [CONCEPTS.md](CONCEPTS.md#a7).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P05** → F1. The play page stays in play. Play page: walk with **W**; compare with P04.
- **What to point at (B.6):** HUD "pending: #41 #42 #43, replayed: 2, corrections: 0". Off shows stutter.
- **Observed:**
  - [screen] Mode HUD while moving: "pending: #1822 … #1827 · replayed: 4 · corrections: 0 (since last Lab change)" (was 4 corrections in the S4 walk).
  - [screen] Scorecard: ✓ Instant "prediction + reconciliation".

### P06 — Raw snapshots (A.8)

Status: partly: HUD and scorecard seen by scribe; the stepping itself was measured by research R6 in a headed browser, not seen by scribe

- **Idea:** Raw snapshots (A.8). See [CONCEPTS.md](CONCEPTS.md#a8).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P06** → F1. The play page stays in play. Point at the bots.
- **What to point at (B.6):** Other players visibly step every 50 ms, with bigger steps under jitter.
- **Observed:**
  - [screen] Mode HUD: "others: raw latest snapshot (no interpolation)". Scorecard: ✗ Smooth "others drawn at raw snapshots".
  - [research R6, headed browser] Run-lengths of identical other-player positions per rendered frame, interp off: at defaults a mode of 5–6 frames per snapshot hold at about 75 fps (headed Chromium on this laptop did not hold 60 fps, so A.8's "about 3 frames" at 60 fps scales up); under Bad route, freezes of 31, 38 and 47 frames. Not seen by scribe.
### P07 — Interpolation (A.9)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Interpolation (A.9). See [CONCEPTS.md](CONCEPTS.md#a9).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P07** → F1. The play page stays in play. Point at a bot and its truth ghost.
- **What to point at (B.6):** Smooth motion; the ghost runs ahead by a measured ≈ 120 ms.
- **Observed:**
  - [screen] Mode HUD: "others: interpolated 100 ms in the past | truth ghost leads what you see by 120 ms (measured: synced server clock − render time, incl. simulated 20 ms downlink)".
  - [screen] 10 samples over 5 s: 122, 122, 122, 121, 121, 121, 120, 121, 120, 120 ms (B.6 expects ≈ 120 ms).

### P08 — Three truths (A.10)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Three truths (A.10). See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P08** → F1. The play page stays in play. Play page: aim at a strafing enemy and fire.
- **What to point at (B.6):** Aim on target and the server says miss, with reason "target moved N cm since what you saw".
- **Observed:**
  - [page data] Shot event: miss, lagcomp off, seenId 4, server movedCm 135.
  - [screen] Shot reason on screen: "Miss on the server: you aimed on demo-target, but the server checked current positions (lag compensation off). Server history: they moved 135 cm between your render time and the time it checked. This client drew them 136 cm from where the server checked (client drawing vs server)."
  - [screen] Scorecard: ✗ Fair "server checks the current position".
  - [smoke] Note: the client smoke at the same commit failed its own P08 shot once ("your ray hit no player at your render time either"), so the aim in that test is flaky.

### P09 — Lag compensation (A.10)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Lag compensation (A.10). See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P09** → F1. The play page stays in play. Play page: aim at an enemy and fire.
- **What to point at (B.6):** On fire, an overlay draws the client-seen hitbox (red) and the rewound server hitbox (blue). Hits match the shooter's view.
- **Observed:**
  - [page data] Shot event: hit, hitbox 1, damage 25, render tick 11402 → rewound 11402 (resolved 11414).
  - [screen] Shot reason: "Hit demo-target — the server rewound to tick 11402.28. This client drew them 0 cm from where the server checked (client drawing vs server). · red = at your render time · blue = where the server checked". The smoke at the same commit counted the red and blue boxes (PASS).

### P10 — Scorecard (A.2)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Scorecard (A.2). See [CONCEPTS.md](CONCEPTS.md#a2).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P10** → F1. The play page stays in play. Point at the scorecard (corner).
- **What to point at (B.6):** All green only with predict, reconcile, interp, lagcomp and authority on.
- **Observed:**
  - [screen] All four green: ✓ Instant "prediction + reconciliation", ✓ Smooth "interpolation", ✓ Fair "lag compensation", ✓ Cheat-proof "server authority". P02, P03, P04, P06, P08 above each turn a different cell red.

## Latency budget (A.11)

Same walk as Core netcode above.

### P11 — Shot budget

Status: verified 2026-11-23 @ 118cbcf (perf panel on screen); the server still lists P11 as not built, so it is reached with F3, not a preset button

- **Idea:** Shot budget. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** Play page: press **F3** to open the perf panel; land real hits on another player (the target half of each segment comes back only from hits).
- **What to point at (B.6):** Stacked bar of 7 measured segments next to the `est.` 190 ms; last shot plus a rolling average of 20.
- **Observed:**
  - [screen] Walk 2026-11-23 @ `118cbcf` (perf panel mounted in `0feb23a`, glitch buttons in `118cbcf`): headless Chrome 156, separate player, target and control browsers (control page with `?admin=`), 2 walker bots, `bin/server -http 127.0.0.1:18502 -https 127.0.0.1:18545` (PID recorded, alive for the whole walk, stopped by PID). Host load average 38–87 on 8 cores at the end of the walk. The perf panel opens with **F3** (or on its presets).
  - [screen] After 8 hits: "est. (A.11 formula) 189 ms", "last shot #993 203 ms", "avg of last 8 complete 210 ms", as stacked bars of 7 segments: click → input sent (shooter frame) · uplink · wait for server tick · wait for snapshot send · downlink to target · target interpolation · target frame wait.
  - [screen] Note under the bars: "est.: A.11 formula with this room's settings and your conditioner delays (simulated)".

### P12 — Send and tick rate

Status: verified 2026-11-23 @ 118cbcf (cost meters on screen)

- **Idea:** Send and tick rate. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** On the **control page**: F1 → **P12**, then under Server settings set **tickRate** 128 and **sendRate** 20, 64, 128. Play page: F3.
- **What to point at (B.6):** Bar drops to about 103 (64/s) and about 80 (128 Hz); cost rises roughly linearly.
- **Observed:**
  - [screen] Perf panel "P12 cost at 128 Hz, N snapshots/s (measured)", 5 clients, "payload bytes; transport framing not counted":
  - [screen] 20/s: total egress 296.6 kbps; you down / up 59.0 / 71.0 kbps · 19.9 snaps/s; server ms per tick p50 / p99 0.011 / 4.079 (budget 7.81).
  - [screen] 64/s: total egress 573.3 kbps; you 115.1 / 77.2 kbps · 67.1 snaps/s; tick p50 / p99 0.022 / 6.895.
  - [screen] 128/s: total egress 924.7 kbps; you 185.6 / 82.9 kbps · 127.9 snaps/s; tick p50 / p99 0.030 / 4.005.
  - Egress grows 1 : 1.9 : 3.1 for 1 : 3.2 : 6.4 times the rate — roughly linear plus a fixed part (inputs, control). Tick p99 is noisy on this loaded host.
  - [screen] Earlier walk at `078053b`: net graph "snapshots 64.0/s (set 64)", interp buffer 31 ms. The budget bar for P12 is the P11 bar above at the chosen rates.

### P13 — Client FPS

Status: partly: 128 Hz and 132 FPS seen; 144 FPS not reached headless, budget bar not built

- **Idea:** Client FPS. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P13** → F1. The play page stays in play. Read the net graph.
- **What to point at (B.6):** Both frame segments shrink; 128 Hz + 144 FPS gives about 71 ms.
- **Observed:**
  - [screen] Net graph: server tick "@ 128 Hz", snapshots "129.9/s (set 128)", interp buffer 16 ms, FPS "132 (7.9 ms)", server tick time "p99 8.11 ms · 98.4% ok".
  - Headless Chrome reached 132 FPS, not 144. The ≈ 71 ms budget needs P11 (not built).

### P14 — Peeker's advantage

Status: not built yet

- **Idea:** Peeker's advantage. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P14**. Toggles it sets (HANDOFF B.6): Peek test: a bot holds an angle, another bot or the player peeks. Measure how long the peeker saw the holder before the holder saw the peeker
- **What to point at:** One measured number per configuration, labelled "our measurement" (Riot's figures may appear beside it as `ref`).

### P15 — Budget table

Status: verified 2026-11-23 @ 118cbcf (perf panel on screen); not a preset button yet (reached with F3)

- **Idea:** Budget table. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** Play page: F3, after a few hits (same run as P11).
- **What to point at (B.6):** Agreement within a stated tolerance; differences explained.
- **Observed:**
  - [screen] "P15 budget table: formula vs measured", n = 8 hits (est. / measured avg / diff, ms): shooter frame 8.3 / 18.1 / +9.8; uplink 20.0 / 22.9 / +2.9; wait for server tick 7.8 / 39.7 / +31.9; wait for snapshot send 25.0 / 9.8 / −15.2; downlink 20.0 / 21.4 / +1.4; target interpolation 100.0 / 89.2 / −10.8; target frame wait 8.3 / 9.3 / +1.0; **total 189 / 210 / +21 (11%)** — within the ±15% tolerance.
  - [screen] Flagged segments carry their reason, e.g. "wait for server tick — formula: half a tick on average; one shot lands anywhere in [0, 1 tick], and the server buffers inputs (pacer margin)", and "click → input sent — measured includes waiting for the 10 shots/s fire cooldown and the pacer's input tick".

## Infrastructure (A.12)

Walk 2026-11-23 @ `4b5a2e6` from the **main server** (same server as the duel walk): headless Chrome 156 opened `/infra.html`; beacons over WebTransport datagrams, 10 pings per region, median shown. All regions, ISP profiles, last miles, routes and the cable cut are **simulated** (A.16); the RTTs are measured by the browser over them. A first walk at `bc5f5cf` through `bin/infra` gave the same picture.
P20 below is from the earlier `beaconbot` run at `078053b`: `bin/beaconbot -base http://127.0.0.1:18520 -n 6 -d 16s -cut-at 8s` against `bin/infra`.

### P16 — Regions and fragile cables

Status: verified 2026-11-23 @ 4b5a2e6 (infra.html in Chromium, main server)

- **Idea:** Regions and fragile cables. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Open `https://<host-ip>:8443/infra.html`. ISP viettel, last mile good, route direct → **Ping beacons**. Enter the admin token → **Cut cables to sg** → Ping again → **Repair** → Ping again.
- **What to point at (B.6):** Ping and the budget bar change by region; a cable cut hurts only `sg`. Labelled simulated.
- **Observed:**
  - [screen] Before: hcm 10.9 · hn 32.9 · sg 42.6 ms (median of 10, 0 lost).
  - [screen] Cut ON ("Cable cut: ON (simulated)"): hcm 10.0 · hn 32.2 · **sg 176.8 ms**. Route table for sg · viettel direct went to "118 / 29 / 3.2%" (RTT / jitter / loss, simulated).
  - [screen] Repaired: hcm 10.4 · hn 34.6 · sg 42.5 ms. Only sg changed.

### P17 — Beacons and matchmaking

Status: verified 2026-11-23 @ 4b5a2e6 (infra.html in Chromium, main server)

- **Idea:** Beacons and matchmaking. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Set ISP vnpt, last mile **bad**, route relay: public → Ping → **Find match with this RTT map**.
- **What to point at (B.6):** Matchmaker UI shows ticket, RTT map, chosen region and the relaxation step.
- **Observed:**
  - [screen] RTT map: hcm 78.8 · hn 108.4 · sg 122.4 ms — no region under 60 ms.
  - [screen] Ticket t1: "0 s: ticket opened, threshold 60 ms" → "10 s: relaxed threshold to 100 ms after 10 s" → "10.1 s: matched to hcm (79 ms ≤ 100 ms)", game room `/r/hcm/ws`.

### P18 — Relay / backbone

Status: partly: 2026-11-23 @ 4b5a2e6 — the simulated route table shows backbone with less jitter and loss, and backbone medians beat public; per-sample loss did not improve and the budget bar is not on this page

- **Idea:** Relay / backbone. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** ISP vnpt, last mile bad: switch **Route** between direct, relay: public, relay: backbone and Ping each time.
- **What to point at (B.6):** Jitter and loss graphs and the budget bar improve. Labelled simulated.
- **Observed:**
  - [screen] Route table (simulated, sg · vnpt): direct 135 / 33 / 3.5%, relay-public 141 / 39 / 4.5%, relay-backbone 97 / 3 / 0% (RTT / jitter / loss, with the cable cut on).
  - [screen] Measured medians (vnpt, bad last mile): public hcm 79.6 · hn 109.4 · sg 139.7 ms; backbone hcm 73.8 · hn 111.0 · sg 120.3 ms.
  - [screen] Lost of 10: public hn 2, sg 1; backbone sg 3 — the bad last mile adds loss on every route, and 10 samples are too few to compare loss.

### P19 — Tick health

Status: partly: 2026-11-23 @ 118cbcf — the loop switch works and both loops are shown side by side, but the numbers were taken at load average 38–87 and are not a loop comparison

- **Idea:** Tick health. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Control page: F3 → **zero-alloc** / **allocating** at the top of the perf panel (admin token), then **reset window**. Play page: F3.
- **What to point at (B.6):** The naive loop shows GC spikes and a lower % within budget; the zero-alloc loop is flat. `-gcflags=-m` findings documented.
- **Observed:**
  - [screen] zero-alloc (10 s window): "Ticks within budget (15.63 ms): 100.00% of 623 · over budget 0"; tick p50 0.020 · p95 0.340 · p99 2.300 · max 15.363 ms; GC 39 cycles, pause p99 83.886 ms.
  - [screen] allocating (10 s window): "97.95% of 390 · over budget 8"; tick p50 0.020 · p95 1.450 · p99 1045.400 · max 1045.400 ms; GC 41 cycles, pause p99 1073.742 ms.
  - [screen] "last seen per loop" table shows both rows. A 1 s GC pause on a 4 MB heap points at the host (load 38–87), not the loop; bots' P19 runs in MEASUREMENTS also call timing inconclusive under load.
  - Display bug for the panel owner: with no limit set it shows "GOMEMLIMIT 8796093022208 MB" (the unset maximum printed as MB) instead of "none".

### P20 — Percentiles

Status: partly: with beaconbot 2026-11-23 @ 078053b, percentiles seen; Prometheus/Grafana alert not run

- **Idea:** Percentiles. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Regions page percentiles; `docker compose up` for Prometheus + Grafana.
- **What to point at (B.6):** The mean looks fine while p99 does not; the cable-cut drill fires the alert.
- **Observed:**
  - [bot] Per region × ISP: sg/viettel mean 94.6 ms vs p99 350 ms; hcm/vnpt mean 21 ms vs p99 86.1 ms — the mean hides the tail.
  - Not run by scribe: Prometheus, Grafana and the "p95 of one ISP" alert (deploy/).

## Other genres (A.13), in the duel mini-mode

Walk 2026-11-23 @ `4b5a2e6` from the **main server**: `NETLAB_ADMIN_TOKEN=… bin/server -http 127.0.0.1:18502 -https 127.0.0.1:18545` (PID recorded, alive for the whole walk) serves `/duel.html` and the relay at `/duel/ws` and `/duel/wt`. One headless Chrome 156 window opened `/duel.html?room=s12` (WebTransport datagrams, link "Default (40 ms)", simulated); the opponent was `bin/duelbot -room s12 -url ws://127.0.0.1:18502/duel/ws -info http://127.0.0.1:18502/api/duel/info -profile default` (input changes ≈ 9/s). Peer RTT through the relay 82–88 ms. Each row is a 10 s window after 2.5 s settling, read from the page's session stats. A first walk at `bc5f5cf` through `bin/infra` gave the same picture (D0→D3: 7.3, 8.8, 9.1, 0.0 rollbacks/s).

### P21 — Rollback

Status: verified 2026-11-23 @ 4b5a2e6 (duel page in Chromium, main server)

- **Idea:** Rollback. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Open `https://<host-ip>:8443/duel.html` in two windows side by side (or one window plus `bin/duelbot`). Click **P21 Rollback** (rollback, D = 0).
- **What to point at (B.6):** HUD: rollbacks per second, frames rolled back.
- **Observed:**
  - [screen] Banner: "P21 Rollback · When the real input arrives and differs, the machine loads a saved state and re-simulates to the present."
  - [page data] Rollback table: 7.4 rollbacks/s, 23.7 frames rolled back/s, avg depth 3.2, max 8 frames; status "rollback, D = 0 manual · 61 frames/s simulated"; peer RTT 82 ms.

### P22 — Input delay

Status: verified 2026-11-23 @ 4b5a2e6 (as measured; see the note on the B.6 wording)

- **Idea:** Input delay. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Click **P22 Input delay** (D auto), then set **D** to 0, 1, 2, 3, 4 and press **Restart both**.
- **What to point at (B.6):** Higher D gives fewer rollbacks.
- **Observed:**
  - [page data] What the page measures: **frames rolled back** fall with every frame of D (23.7 → 0.4 per s) and the average **depth** falls from 3.2 to 1.3 frames by D = 2, while the rollback **count** stays near the opponent's input-change rate (≈ 9/s) until D covers the one-way trip (≈ 2.5 frames at 82 ms RTT). Then it collapses (table below).
  - [page data] D auto picked **0** at ping 83 ms (A.13 rule: 0 below 100 ms): 10.1 rollbacks/s, 30.7 frames/s.
  - [bot] Duel's 30 s bot runs agree ([MEASUREMENTS.md](MEASUREMENTS.md#duel-p21p23-p25), Default): "rollback D2: 9.07 / 8.33 rb/s, 11.0 / 9.1 fr/s", "rollback D3: 0.70 / 2.20 rb/s, 0.7 / 2.2 fr/s".
  - B.6 says "Higher D gives fewer rollbacks". That holds only once D covers the one-way trip; below it, D cuts depth, not count. DECISIONS 52 records this.

| D | rollbacks/s | frames rolled back/s | avg depth | opponent input changes/s |
|---|---|---|---|---|
| 0 | 7.4 | 23.7 | 3.20 | 7.6 |
| 1 | 8.9 | 18.4 | 2.07 | 9.0 |
| 2 | 8.9 | 11.7 | 1.31 | 9.7 |
| 3 | 0.7 | 1.3 | 1.86 | 8.8 |
| 4 | 0.3 | 0.4 | 1.33 | 9.3 |

[page data] 10 s averages of the duel page's session counters; the on-screen table shows the same counters as last-1-s rates.

### P23 — Lockstep

Status: verified 2026-11-23 @ 4b5a2e6 (duel page in Chromium, main server)

- **Idea:** Lockstep. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Click **P23 Lockstep** (D auto), then set D = 2 and press **Restart both**.
- **What to point at (B.6):** Stalls under jitter where rollback does not.
- **Observed:**
  - [page data] Lockstep, D auto = 4 (ping 85 ms, "lockstep buffer"): 0 rollbacks, 0.2 stall frames/s, 60 frames/s simulated.
  - [page data] Lockstep, D = 2: 20.6 stall frames/s and only 43 frames/s simulated — the frame waits for the late input. Rollback at D = 0 on the same link: 0.0 stall frames/s.

## Edge cases and extras (A.10, A.14, A.15)

Same walk as Core netcode above.

### P24 — Died behind the wall

Status: partly: the cover case was staged and seen on the victim page (2026-11-23 @ 7a9cf86); changing the options was not staged

- **Idea:** Died behind the wall. See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P24** → F1. The play page stays in play. Play page: kill an enemy (4 body hits of 25). Point at the victim's screen.
- **What to point at (B.6):** The victim sees why they died behind cover; changing options changes the outcome.
- **Observed:**
  - [screen] P24 sets the simulated conditioner to 50 ms each way for every client (net graph on the target: "RTT 104 ms measured, incl. simulated 100 ms").
  - [screen] Victim page, death replay panel: "Why you died (P24, A.10) — killed by demo2-player ● you on your screen at the hit (tick 21018) ● you as the shooter saw you: the server rewound 224 ms (tick 21003) Gap between the two: 0 cm. On your screen the shooter still had line of sight." (second run, same build).
  - [page data] Cover case, staged 2026-11-23 @ `7a9cf86` (same three-browser setup, server on 18502/18545): shooter and victim at x ≈ 5.5 in the open gap; the victim strafes toward the low wall (x < 0.5 puts the 2 m wall between them). The shooter fired a head shot at the victim as drawn on the shooter's screen (drawn x 2.00 m) when the victim's own position was already x 0.29 m.
  - [screen] Victim kill feed: "cover-shooter ☠ HS cover-victim (you)", "−100 from cover-shooter". Shooter's shot reason: "Hit cover-victim in the head — the server rewound to tick 3976.68. This client drew them 2 cm from where the server checked".
  - [screen] Victim's death replay: "Why you died (P24, A.10) — killed by cover-shooter ● you on your screen at the hit (tick 3993) ● you as the shooter saw you: the server rewound 255 ms (tick 3976) Gap between the two: 189 cm. On your screen you were already behind cover. The shot was fair to the shooter, so it looks unfair to you."
  - Not done: changing the options (history cap, "favour victim when shooter RTT > X ms") and showing the outcome flip.
  - Layout issue for client: at 1280×760 the death replay panel overlaps the net graph and its last lines sit under the "no pointer lock" note.

### P25 — Glitch lab

Status: verified 2026-11-23 @ 118cbcf for the shooter glitches (rubber-band, teleport) and @ 4b5a2e6 for the duel desync

- **Idea:** Glitch lab. See [CONCEPTS.md](CONCEPTS.md#a14).
- **What to click:** Shooter: control page F1 → Glitch lab → **Rubber-band (server-only speed ×0.6)** (click again to stop) or **Teleport: 400 ms loss burst (everyone)**. Duel: duel page → **P25 Inject nondeterminism**.
- **What to point at (B.6):** Each glitch is reproducible on demand and named on screen.
- **Observed:**
  - [screen] Rubber-band while holding W: glitch box "Glitch: Rubber-banding — The server moves you at 60% speed and your client does not know: every snapshot corrects your prediction back (A.14, server-only speed modifier). corrections since last Lab change: 29 (measured)"; mode HUD "corrections: 29". [page data] speedScale 0.6, back to 1 after the second click.
  - [screen] Teleport: glitch box "Glitch: Teleporting — Every snapshot is lost for longer than the interpolation buffer: other players freeze, then jump to where they are now (A.14). max snapshot gap: 411 ms (measured, last 1 s)".
  - [page data] A strafing target as drawn on the player page, sampled every 80 ms: steps of 0.6–0.7 m, then one jump of 2.6 m (−9.72 → −12.31) when the burst ended.
  - [screen] Duel desync (`4b5a2e6`): "DESYNC at frame 125: my checksum 5499d5501b82b2b8, opponent's 2bbe03c522aa5dc8. This window flipped bit 12 of fighter 0 x at frame 125 (seed 2722834198). Restart both to resync."; checksums table "frames compared 356, my session seed 2722834198"; the stage border turns red.

### P26 — Sub-tick

Status: partly: per-shot timing error seen in shot events; the histogram is not on screen

- **Idea:** Sub-tick. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P26** → F1. The play page stays in play. Play page: fire several shots.
- **What to point at (B.6):** Shot-timing error histogram at 64 Hz, on versus off. Never claim it equals 128 Hz.
- **Observed:**
  - [page data] Shot events with sub-tick on: timing error 8.99, 4.06, 3.87 ms (subtickFrac 27840, 48509, 49319).
  - Not on screen: the on/off timing-error histogram (the server keeps it; the client does not render it).

### P27 — Compression

Status: partly: kbps down seen; raw / quantised / delta meters are not on screen

- **Idea:** Compression. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P27** → F1. The play page stays in play. Read kbps in the net graph.
- **What to point at (B.6):** kbps meter for raw, quantised and delta, at rest versus moving.
- **Observed:**
  - [screen] Net graph: kbps up/down 37.0 / 49.2 (P01 at the same moment of the walk: 37.0 / 64.9). The client smoke at this commit confirmed delta-encoded snapshots (`deltaSnaps > 0`).
  - Not on screen: the raw / quantised / bit-packed / delta byte meters.

### P28 — Interest management

Status: partly: preset applies; entities and bytes per client are not on screen

- **Idea:** Interest management. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P28** → F1. The play page stays in play. Read kbps in the net graph.
- **What to point at (B.6):** Entities and bytes per client, on versus off.
- **Observed:**
  - [screen] Net graph: kbps down 46.9. With 5 players in a small map every player is in nearby cells, so no difference is expected here.
  - Not on screen: entities per snapshot and bytes per client, on vs off.

### P29 — Transport

Status: partly: 2026-11-23 @ 118cbcf — WebSocket shows about 4× the stalls, but datagrams were not stall-free

- **Idea:** Transport. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** Two play pages, one normal (WebTransport) and one with `?transport=ws`; on each set the conditioner loss to 5% (page script below); F3.
- **What to point at (B.6):** Snapshot inter-arrival histogram: TCP shows stalls, datagrams do not.
- **Observed:**
  - [page data] Conditioner set on both pages with `session.setCond({lossPct:5},{lossPct:5})` (this left delay at 0 ms, so RTT read 1–3 ms).
  - [screen] WebTransport, 25 s: "send interval 50.0 ms · 1152 gaps", "Stalls > 3× interval (150 ms): 6 · max gap 450 ms"; net graph loss up/down 4.3 / 6.3 % "incl. simulated loss 5/5 %".
  - [screen] WebSocket, 25 s: "494 gaps", "Stalls > 3× interval (150 ms): 23 · max gap 322 ms"; net graph loss 0.0 / 0.0 % (TCP turns loss into retransmit stalls), jitter 41 ms.
  - The panel counts every gap > 150 ms. Bots' B.9 check 6 run separates loss gaps from stalls by snapshot id (DECISIONS: check 6 counts stalls) and found WS 106–119 vs WT 4–5 stalls ([MEASUREMENTS.md](MEASUREMENTS.md)).

## Playtest notes

For HANDOFF B.9 check 8: 4+ people on the LAN, conditioner at default, play one round, then walk through presets
P02 → P10 → P11–P15. The host checklist, URLs and a notes template per step are in [PLAYTEST.md](PLAYTEST.md).
Copy the session summary here afterwards.

No playtest has been run yet.

