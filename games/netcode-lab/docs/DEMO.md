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
  - Banner: "P01 Vocabulary — Clients send what the player did (inputs); the server decides what happened (positions, hits, deaths). Read A.1 →"
  - Net graph: RTT 46 ms "measured, incl. simulated 40 ms", server tick "8305 @ 64 Hz", snapshots "19.0/s (set 20)", FPS "61 (16.6 ms)".
  - Scorecard: all four ✓ (lag compensation is built now).

### P02 — Dumb client (A.4)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Dumb client (A.4). See [CONCEPTS.md](CONCEPTS.md#a4).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P02** → F1. The play page stays in play. Play page: tap **W** from standing still 5–6 times.
- **What to point at (B.6):** Pressing W moves you only after about one RTT plus waits; HUD "input → motion: N ms" (measured). Scorecard Instant ✗, Cheat-proof ✓.
- **Observed:**
  - Mode HUD: "input → motion: 114 ms (measured, incl. simulated 40 ms RTT, median of 6) · 40–72 ms est. (A.4, no pacer margin)".
  - Scorecard: ✗ Instant "waits for the server (no prediction)", ✗ Smooth, ✓ Cheat-proof.

### P03 — Trust client (A.5)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Trust client (A.5). See [CONCEPTS.md](CONCEPTS.md#a5).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P03** → F1. The play page stays in play. Control page: F1 → P03 → **Send forged headshot claim** (the "modded client"). Then apply P01 and send it again.
- **What to point at (B.6):** In trust mode fake kills land in the kill feed. In authoritative modes the same packets are rejected and logged "rejected claim".
- **Observed:**
  - Trust mode (P03): kill feed on the player page "demo-control ☠ HS trust-mode claim bot-walker-2": the forged claim lands.
  - Authoritative (P01): kill feed "rejected claim from demo2-control: "hit bot-walker-2 in the head" — server authority: clients send inputs, not results" (second run, same build).
  - Scorecard in P03: ✓ Instant "client simulates itself", ✓ Fair "client claims its own hits", ✗ Cheat-proof "server relays client claims".

### P04 — Prediction (A.6)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Prediction (A.6). See [CONCEPTS.md](CONCEPTS.md#a6).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P04** → F1. The play page stays in play. Play page: tap **W** from standing still, then hold W.
- **What to point at (B.6):** Own movement reacts in the current frame while the server still decides.
- **Observed:**
  - Mode HUD: "input → motion: 9 ms (measured, prediction on: no network wait, median of 2)" — under one 16.7 ms frame (was 44 ms in the S4 walk; fixed in `c250ab0`).
  - "pending: #1398 … · replayed: 0 · corrections: 25 (since last Lab change) · reconcile OFF (hard snap)".
  - Scorecard: ~ Instant "predicted, but snaps back without reconciliation".

### P05 — Reconciliation (A.7)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Reconciliation (A.7). See [CONCEPTS.md](CONCEPTS.md#a7).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P05** → F1. The play page stays in play. Play page: walk with **W**; compare with P04.
- **What to point at (B.6):** HUD "pending: #41 #42 #43, replayed: 2, corrections: 0". Off shows stutter.
- **Observed:**
  - Mode HUD while moving: "pending: #1822 … #1827 · replayed: 4 · corrections: 0 (since last Lab change)" (was 4 corrections in the S4 walk).
  - Scorecard: ✓ Instant "prediction + reconciliation".

### P06 — Raw snapshots (A.8)

Status: partly: HUD and scorecard seen; the visual stepping was not measured here (research R6 measured it headed)

- **Idea:** Raw snapshots (A.8). See [CONCEPTS.md](CONCEPTS.md#a8).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P06** → F1. The play page stays in play. Point at the bots.
- **What to point at (B.6):** Other players visibly step every 50 ms, with bigger steps under jitter.
- **Observed:**
  - Mode HUD: "others: raw latest snapshot (no interpolation)". Scorecard: ✗ Smooth "others drawn at raw snapshots".

### P07 — Interpolation (A.9)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Interpolation (A.9). See [CONCEPTS.md](CONCEPTS.md#a9).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P07** → F1. The play page stays in play. Point at a bot and its truth ghost.
- **What to point at (B.6):** Smooth motion; the ghost runs ahead by a measured ≈ 120 ms.
- **Observed:**
  - Mode HUD: "others: interpolated 100 ms in the past | truth ghost leads what you see by 120 ms (measured: synced server clock − render time, incl. simulated 20 ms downlink)".
  - 10 samples over 5 s: 122, 122, 122, 121, 121, 121, 120, 121, 120, 120 ms (B.6 expects ≈ 120 ms).

### P08 — Three truths (A.10)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Three truths (A.10). See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P08** → F1. The play page stays in play. Play page: aim at a strafing enemy and fire.
- **What to point at (B.6):** Aim on target and the server says miss, with reason "target moved N cm since what you saw".
- **Observed:**
  - Shot event: miss, lagcomp off, seenId 4, server movedCm 135.
  - Shot reason on screen: "Miss on the server: you aimed on demo-target, but the server checked current positions (lag compensation off). Server history: they moved 135 cm between your render time and the time it checked. This client drew them 136 cm from where the server checked (client drawing vs server)."
  - Scorecard: ✗ Fair "server checks the current position".
  - Note: the client smoke at the same commit failed its own P08 shot once ("your ray hit no player at your render time either"), so the aim in that test is flaky.

### P09 — Lag compensation (A.10)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Lag compensation (A.10). See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P09** → F1. The play page stays in play. Play page: aim at an enemy and fire.
- **What to point at (B.6):** On fire, an overlay draws the client-seen hitbox (red) and the rewound server hitbox (blue). Hits match the shooter's view.
- **Observed:**
  - Shot event: hit, hitbox 1, damage 25, render tick 11402 → rewound 11402 (resolved 11414).
  - Shot reason: "Hit demo-target — the server rewound to tick 11402.28. This client drew them 0 cm from where the server checked (client drawing vs server). · red = at your render time · blue = where the server checked". The smoke at the same commit counted the red and blue boxes (PASS).

### P10 — Scorecard (A.2)

Status: verified 2026-11-23 @ 078053b

- **Idea:** Scorecard (A.2). See [CONCEPTS.md](CONCEPTS.md#a2).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P10** → F1. The play page stays in play. Point at the scorecard (corner).
- **What to point at (B.6):** All green only with predict, reconcile, interp, lagcomp and authority on.
- **Observed:**
  - All four green: ✓ Instant "prediction + reconciliation", ✓ Smooth "interpolation", ✓ Fair "lag compensation", ✓ Cheat-proof "server authority". P02, P03, P04, P06, P08 above each turn a different cell red.

## Latency budget (A.11)

Same walk as Core netcode above.

### P11 — Shot budget

Status: not built yet

- **Idea:** Shot budget. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P11**. Toggles it sets (HANDOFF B.6): Trace every shot on the server-synced clock: click → next client frame → send → server receive → tick start → snapshot send → target receive → interpolation delay → target frame
- **What to point at:** Stacked bar of 7 measured segments next to the `est.` 190 ms; last shot plus a rolling average of 20.

### P12 — Send and tick rate

Status: partly: rates and buffer seen; the cost meters and the budget bar are not on screen

- **Idea:** Send and tick rate. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P12** → F1. The play page stays in play. Read the net graph.
- **What to point at (B.6):** Bar drops to about 103 (64/s) and about 80 (128 Hz); cost rises roughly linearly.
- **Observed:**
  - Net graph: snapshots "64.0/s (set 64)", interp buffer "31 ms (2× interval)", max snapshot gap 26 ms, kbps down 110.6 (P01: 64.9).
  - Server `stats` (not rendered): total egress 554 kbps at 64/s vs 299 kbps at 20/s, 5 clients ("payload bytes; transport framing not counted").
  - Not on screen: server ms per tick / bytes per client meters and the budget bar (P11 is not built).

### P13 — Client FPS

Status: partly: 128 Hz and 132 FPS seen; 144 FPS not reached headless, budget bar not built

- **Idea:** Client FPS. See [CONCEPTS.md](CONCEPTS.md#a11).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P13** → F1. The play page stays in play. Read the net graph.
- **What to point at (B.6):** Both frame segments shrink; 128 Hz + 144 FPS gives about 71 ms.
- **Observed:**
  - Net graph: server tick "@ 128 Hz", snapshots "129.9/s (set 128)", interp buffer 16 ms, FPS "132 (7.9 ms)", server tick time "p99 8.11 ms · 98.4% ok".
  - Headless Chrome reached 132 FPS, not 144. The ≈ 71 ms budget needs P11 (not built).

### P14 — Peeker's advantage

Status: not built yet

- **Idea:** Peeker's advantage. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P14**. Toggles it sets (HANDOFF B.6): Peek test: a bot holds an angle, another bot or the player peeks. Measure how long the peeker saw the holder before the holder saw the peeker
- **What to point at:** One measured number per configuration, labelled "our measurement" (Riot's figures may appear beside it as `ref`).

### P15 — Budget table

Status: not built yet

- **Idea:** Budget table. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P15**. Toggles it sets (HANDOFF B.6): The P11 data as a table: formula value (A.11) beside measured value per segment for current settings
- **What to point at:** Agreement within a stated tolerance; differences explained.


## Infrastructure (A.12)

Run 2026-11-23 @ `078053b`: `NETLAB_ADMIN_TOKEN=… bin/infra -http 127.0.0.1:18520 -https 127.0.0.1:18555 -www bin/duel-www`, then `bin/beaconbot -base http://127.0.0.1:18520 -n 6 -d 16s -cut-at 8s`. All regions, ISP profiles and the cable cut are **simulated**. The regions **page** (`/infra.html`) returned HTTP 200 but was not walked in a browser by scribe. The shooter client cannot join a region room yet (duel asked client for `?region=`).

### P16 — Regions and fragile cables

Status: verified with beaconbot 2026-11-23 @ 078053b (page not walked)

- **Idea:** Regions and fragile cables. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Regions page (`make infra-run`, or `bin/infra`): pick an ISP; press **cable cut**.
- **What to point at (B.6):** Ping and the budget bar change by region; a cable cut hurts only `sg`. Labelled simulated.
- **Observed:**
  - Beacon RTT p50 per region over 16 s (cable cut on at 8 s): hcm 9.9–16.1 ms, hn 32.9–41.1 ms, sg 98.8–118.4 ms (p99 291–433 ms). Only sg rose. Labelled simulated.

### P17 — Beacons and matchmaking

Status: partly: with beaconbot 2026-11-23 @ 078053b, matching seen; the relaxation step was not exercised

- **Idea:** Beacons and matchmaking. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Regions page: open a matchmaking ticket.
- **What to point at (B.6):** Matchmaker UI shows ticket, RTT map, chosen region and the relaxation step.
- **Observed:**
  - All 6 tickets: "ticket opened, threshold 60 ms" → "matched to hcm (10–18 ms ≤ 60 ms)" at 0 s, with the RTT map (e.g. hcm 9.99, hn 36.06, sg 43.21 ms). Nobody waited, so the 60 → 100 ms relaxation did not trigger.

### P18 — Relay / backbone

Status: not checked by scribe

- **Idea:** Relay / backbone. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Regions page: route public vs backbone (`beaconbot -route relay-public|relay-backbone`).
- **What to point at (B.6):** Jitter and loss graphs and the budget bar improve. Labelled simulated.

### P19 — Tick health

Status: not built yet

- **Idea:** Tick health. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P19**. Toggles it sets (HANDOFF B.6): Tick-duration histogram, **% ticks within budget**, GC pauses from `runtime/metrics`. Toggle "allocating loop" (allocate per entity per tick, naive encoding) versus "zero-alloc loop" (pre-allocated buffers, `s = s[:0]`, `sync.Pool`); `GOMEMLIMIT` setting; 50 bots
- **What to point at:** The naive loop shows GC spikes and a lower % within budget; the zero-alloc loop is flat. `-gcflags=-m` findings documented.

### P20 — Percentiles

Status: partly: with beaconbot 2026-11-23 @ 078053b, percentiles seen; Prometheus/Grafana alert not run

- **Idea:** Percentiles. See [CONCEPTS.md](CONCEPTS.md#a12).
- **What to click:** Regions page percentiles; `docker compose up` for Prometheus + Grafana.
- **What to point at (B.6):** The mean looks fine while p99 does not; the cable-cut drill fires the alert.
- **Observed:**
  - Per region × ISP: sg/viettel mean 94.6 ms vs p99 350 ms; hcm/vnpt mean 21 ms vs p99 86.1 ms — the mean hides the tail.
  - Not run by scribe: Prometheus, Grafana and the "p95 of one ISP" alert (deploy/).

## Other genres (A.13), in the duel mini-mode

Run 2026-11-23 @ `078053b`: `bin/duelrelay -http 127.0.0.1:18510 -https 127.0.0.1:18553`, then `bin/duelbot -pair -url ws://127.0.0.1:18510/duel/ws -info http://127.0.0.1:18510/api/duel/info -d 10s -profile bad <mode>` (two headless peers, "bad" route profile). The duel **page** (`/duel.html`) was not walked in a browser by scribe.

### P21 — Rollback

Status: verified with bots 2026-11-23 @ 078053b (page not walked)

- **Idea:** Rollback. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Duel page (`make duel-run`, or `bin/duelrelay`): mode **rollback**, D = 0.
- **What to point at (B.6):** HUD: rollbacks per second, frames rolled back.
- **Observed:**
  - `-mode rollback -delay 0`: 6.1 and 6.4 rollbacks/s, 30.7 and 36.7 frames rolled back/s, max depth 8, peer RTT ≈ 173 ms, desync none.

### P22 — Input delay

Status: partly: with bots 2026-11-23 @ 078053b, D = 2 cut frames rolled back and stalls, not the rollback count

- **Idea:** Input delay. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Duel page: change input delay D (auto or a frame count).
- **What to point at (B.6):** Higher D gives fewer rollbacks.
- **Observed:**
  - D = 0 → D = 2 (rollback): rollbacks/s 6.1 → 6.1 (side 0), frames rolled back/s 30.7 → 24.0, avg depth 5.0 → 3.9, stall frames/s 6.5 → 1.9.
  - B.6 expects "higher D gives fewer rollbacks"; in these 10 s runs the count stayed the same and the depth dropped.

### P23 — Lockstep

Status: verified with bots 2026-11-23 @ 078053b (page not walked)

- **Idea:** Lockstep. See [CONCEPTS.md](CONCEPTS.md#a13).
- **What to click:** Duel page: mode **lockstep**, D = 2.
- **What to point at (B.6):** Stalls under jitter where rollback does not.
- **Observed:**
  - `-mode lockstep -delay 2`: 22.6 fps, 37.5 stall frames/s (6.2 s of 10 s stalled), 0 rollbacks, desync none — against 1.9 stall frames/s for rollback at the same D.

## Edge cases and extras (A.10, A.14, A.15)

Same walk as Core netcode above.

### P24 — Died behind the wall

Status: partly: death replay seen on the victim page; the "reached cover" case and the option changes were not staged

- **Idea:** Died behind the wall. See [CONCEPTS.md](CONCEPTS.md#a10).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P24** → F1. The play page stays in play. Play page: kill an enemy (4 body hits of 25). Point at the victim's screen.
- **What to point at (B.6):** The victim sees why they died behind cover; changing options changes the outcome.
- **Observed:**
  - P24 adds simulated delay to the shooter (net graph on the target: "RTT 104 ms measured, incl. simulated 100 ms").
  - Victim page, death replay panel: "Why you died (P24, A.10) — killed by demo2-player ● you on your screen at the hit (tick 21018) ● you as the shooter saw you: the server rewound 224 ms (tick 21003) Gap between the two: 0 cm. On your screen the shooter still had line of sight." (second run, same build).
  - In this run the target stood in the open, so the gap was 0 cm; the "behind the wall" case (target reaching cover) was not staged.

### P25 — Glitch lab

Status: not checked by scribe

- **Idea:** Glitch lab. See [CONCEPTS.md](CONCEPTS.md#a14).
- **What to click:** Duel page glitch buttons; see duel's results in [MEASUREMENTS.md](MEASUREMENTS.md#duel-p21p23-p25).
- **What to point at (B.6):** Each glitch is reproducible on demand and named on screen.

### P26 — Sub-tick

Status: partly: per-shot timing error seen in shot events; the histogram is not on screen

- **Idea:** Sub-tick. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P26** → F1. The play page stays in play. Play page: fire several shots.
- **What to point at (B.6):** Shot-timing error histogram at 64 Hz, on versus off. Never claim it equals 128 Hz.
- **Observed:**
  - Shot events with sub-tick on: timing error 8.99, 4.06, 3.87 ms (subtickFrac 27840, 48509, 49319).
  - Not on screen: the on/off timing-error histogram (the server keeps it; the client does not render it).

### P27 — Compression

Status: partly: kbps down seen; raw / quantised / delta meters are not on screen

- **Idea:** Compression. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P27** → F1. The play page stays in play. Read kbps in the net graph.
- **What to point at (B.6):** kbps meter for raw, quantised and delta, at rest versus moving.
- **Observed:**
  - Net graph: kbps up/down 37.0 / 49.2 (P01 at the same moment of the walk: 37.0 / 64.9). The client smoke at this commit confirmed delta-encoded snapshots (`deltaSnaps > 0`).
  - Not on screen: the raw / quantised / bit-packed / delta byte meters.

### P28 — Interest management

Status: partly: preset applies; entities and bytes per client are not on screen

- **Idea:** Interest management. See [CONCEPTS.md](CONCEPTS.md#a15).
- **What to click:** On the **control page** (`https://<host>:8443/?admin=<token>`, a second browser or device): F1 → **P28** → F1. The play page stays in play. Read kbps in the net graph.
- **What to point at (B.6):** Entities and bytes per client, on versus off.
- **Observed:**
  - Net graph: kbps down 46.9. With 5 players in a small map every player is in nearby cells, so no difference is expected here.
  - Not on screen: entities per snapshot and bytes per client, on vs off.

### P29 — Transport

Status: not built yet

- **Idea:** Transport. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P29**. Toggles it sets (HANDOFF B.6): WebTransport datagrams versus WebSocket, with 5% loss
- **What to point at:** Snapshot inter-arrival histogram: TCP shows stalls, datagrams do not.

## Playtest notes

For HANDOFF B.9 check 8: 4+ people on the LAN, conditioner at default, play one round, then walk through presets
P02 → P10 → P11–P15. The host checklist, URLs and a notes template per step are in [PLAYTEST.md](PLAYTEST.md).
Copy the session summary here afterwards.

No playtest has been run yet.

