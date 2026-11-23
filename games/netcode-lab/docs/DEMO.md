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

1. On the host, from games/netcode-lab: `make run` (builds WASM, server and client, then runs
   `bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443`).
2. Admin token for the Lab panel: set `NETLAB_ADMIN_TOKEN`, or copy the generated `adminToken` from the server log.
3. LAN players open `https://<host-ip>:8443` and accept one certificate warning. The start card then shows
   "✓ Game server connected over WebTransport" (seen 2026-11-23 @ e10d4de on https://127.0.0.1:8443, headless Chrome 156).
4. If that fails, players open `http://<host-ip>:8080`. The start card shows "connected over WebSocket" and the banner
   shows "WebSocket fallback — page is plain HTTP, not a secure context; game packets go over TCP." (seen 2026-11-23 @ e10d4de
   on http://172.16.3.48:8080). Note: `http://127.0.0.1:8080` is a secure context, so on the host itself that URL
   uses WebTransport. Add `?transport=ws` to force WebSocket.
   Not verified: a second machine on the LAN, and the certificate warning click in a headed browser.
5. Allow TCP 8080 and TCP + UDP 8443 through the host firewall.

## Core netcode (A.4–A.10)

### P01 — Vocabulary

Status: verified 2026-11-23 @ e10d4de

- **Idea:** Vocabulary. See [CONCEPTS.md](CONCEPTS.md#a1).
- **What to click:** open the page with `?admin=<token>`, press **F1**, click **P01**. The Lab footer shows "active preset P01". Press F1 to close.
- **What to point at:** the net graph (top left). Each row says where its value comes from (`measured`, `server`, `setting`).
- **Banner:** "P01 RTT, tick, snapshot and frame: 64 Hz server, 20 snapshots/s, 60 FPS, 40 ms RTT."
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - RTT 41 ms (measured), server tick "2069 @ 64 Hz" (server), snapshots 19.7/s (set 20, measured), FPS 61 (16.7 ms, measured).
  - All four B.6 values are visible and match the defaults (40 ms RTT, 64 Hz, 20/s, 60 FPS).

### P02 — Dumb client

Status: verified 2026-11-23 @ e10d4de (pointer-lock step not verified, see note)

- **Idea:** Dumb client (A.4). See [CONCEPTS.md](CONCEPTS.md#a4).
- **What to click:** F1 → **P02** → F1. Click the view to lock the mouse. From standing still, tap **W** several times.
- **What to point at:** the mode HUD line "input → motion: N ms (measured, median of K)", and the scorecard.
- **Banner:** "P02 The client only draws what the server sends: correct, cheat-proof, and you move one RTT plus waits late."
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - "input → motion: 103 ms (measured, median of 6)" with RTT 41 ms, so one RTT plus tick, snapshot and frame waits.
  - Mode HUD: "prediction off: you see only the server's state of yourself".
  - Scorecard: ✗ Instant "waits for the server (no prediction)", ✓ Cheat-proof "server authority".
- **Note:** Headless Chrome does not grant pointer lock, so the test hook set `input.locked`; the W presses were real keyboard events. The Play click → pointer lock step is not verified.

### P03 — Trust client (A.5)

Status: not built yet

- **Idea:** Trust client (A.5). See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P03**. Toggles it sets (HANDOFF B.6): `mode=trust`: the client sends its position and hit claims, the server relays. Button "modded client": a bot or the presenter claims headshots through walls
- **What to point at:** In trust mode fake kills land in the kill feed. In authoritative modes the same packets are rejected and logged "rejected claim".

### P04 — Prediction

Status: partly: input → motion measured 44 ms, not "the current frame" (16.7 ms at 60 FPS)

- **Idea:** Prediction (A.6). See [CONCEPTS.md](CONCEPTS.md#a6).
- **What to click:** F1 → **P04** → F1. Tap **W** from standing still, then hold W.
- **What to point at:** "input → motion" (compare with P02), and the corrections count. P04 has reconcile off, so each snapshot snaps you back.
- **Banner:** "P04 Your own movement runs locally at once; without reconciliation each snapshot snaps you back to the past."
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - "input → motion: 44 ms (measured, median of 4)", against 103 ms in P02.
  - Mode HUD: "pending: #1329 … #1334 … · replayed: 0 · corrections: 89 (since last Lab change) · reconcile OFF (hard snap)".
  - Scorecard: ~ Instant "predicted, but snaps back without reconciliation".
- **Open:** B.6 asks for a reaction in the current frame; 44 ms is about 2–3 frames. The stutter is visual and was not checked headless. Headless Chrome does not grant pointer lock, so the test hook set `input.locked`; the W presses were real keyboard events. The Play click → pointer lock step is not verified.

### P05 — Reconciliation

Status: partly: corrections were 4 after walking, not 0

- **Idea:** Reconciliation (A.7). See [CONCEPTS.md](CONCEPTS.md#a7).
- **What to click:** F1 → **P05** → F1. Walk with **W**. To show the contrast, switch to P04 (reconcile off).
- **What to point at:** the mode HUD line "pending: #… · replayed: N · corrections: N".
- **Banner:** "P05 Unacknowledged inputs are replayed on top of the server state: same rules, so nothing moves."
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - While moving: "input → motion: 29 ms (measured, median of 3) | pending: #1816 … #1821 … · replayed: 5 · corrections: 4 (since last Lab change)".
  - After stopping: "replayed: 8 · corrections: 4". The net graph showed "server input buffer 0 (starved 51)" and a 110 ms max snapshot gap.
  - Scorecard: ✓ Instant "prediction + reconciliation".
- **Open:** B.6 expects "corrections: 0". The 4 corrections fit the B.9 check 2 issue that review (V1) is chasing; input-buffer starvation is one candidate. Headless Chrome does not grant pointer lock, so the test hook set `input.locked`; the W presses were real keyboard events. The Play click → pointer lock step is not verified.

### P06 — Raw snapshots

Status: partly: the P06 preset is not built (server lists it "not built yet"); the effect works through Lab settings, and the stepping was not checked visually

- **Idea:** Raw snapshots (A.8). See [CONCEPTS.md](CONCEPTS.md#a8).
- **What to click (until P06 is built):** F1 → under "My network conditioner (simulated)" click **Bad route (80 ms, jitter 15, loss 1%)** → under "Server settings" untick **interp** → F1.
- **What to point at:** the bots. They should step every 50 ms, with bigger steps under jitter. Mode HUD: "others: raw latest snapshot (no interpolation)".
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - Banner "Custom Lab settings (no preset)"; Lab footer "active preset custom".
  - Mode HUD: "others: raw latest snapshot (no interpolation)"; net graph "interp buffer off (raw)".
  - Net graph: RTT 81 ms, jitter 19 ms, snapshots 19.0/s, max snapshot gap 102 ms. "loss up/down" showed 0.0 / 0.0 % within the 1.5 s window, although the profile sets 1%.
  - Scorecard: ✗ Smooth "others drawn at raw snapshots".

### P07 — Interpolation

Status: partly: the P07 preset is not built; through Lab settings, verified 2026-11-23 @ e10d4de

- **Idea:** Interpolation (A.9). See [CONCEPTS.md](CONCEPTS.md#a9).
- **What to click (until P07 is built):** F1 → tick **interp** and **truthGhost** under "Server settings" → conditioner **Default (40 ms)** → F1.
- **What to point at:** smooth bots, the truth ghost running ahead of each bot, and the HUD line "truth ghost leads what you see by N ms".
- **Observed** (Run 2026-11-23 @ e10d4de: headless Chrome for Testing 156 over WebTransport (`https://127.0.0.1:8443`), server `NETLAB_ADMIN_TOKEN=demo bin/server -http 127.0.0.1:8080 -https 127.0.0.1:8443`, 2 walker bots (`bin/bot -n 2`), default conditioner.):
  - Mode HUD: "others: interpolated 100 ms in the past | truth ghost leads what you see by 120 ms (measured: synced server clock − render time)".
  - 10 samples over 5 s: 121, 120, 120, 120, 120, 120, 120, 120, 120, 120 ms. B.6 expects ≈ 120 ms.
  - Net graph: "interp buffer 100 ms (2× interval)". Scorecard: ✓ Smooth "interpolation".

### P08 — Three truths (A.10)

Status: not built yet

- **Idea:** Three truths (A.10). See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P08**. Toggles it sets (HANDOFF B.6): `lagcomp=off`; presenter view (B.7) shows shooter view / server now / target view
- **What to point at:** Aim on target and the server says miss, with reason "target moved N cm since what you saw".

### P09 — Lag compensation (A.10)

Status: not built yet

- **Idea:** Lag compensation (A.10). See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P09**. Toggles it sets (HANDOFF B.6): `lagcomp=on`, history cap slider
- **What to point at:** On fire, an overlay draws the client-seen hitbox (red) and the rewound server hitbox (blue). Hits match the shooter's view.

### P10 — Scorecard (A.2)

Status: not built yet

- **Idea:** Scorecard (A.2). See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P10**. Toggles it sets (HANDOFF B.6): Four-cell scorecard computed from active modes
- **What to point at:** All green only with predict, reconcile, interp, lagcomp and authority on.


## Latency budget (A.11)

### P11 — Shot budget

Status: not built yet

- **Idea:** Shot budget. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P11**. Toggles it sets (HANDOFF B.6): Trace every shot on the server-synced clock: click → next client frame → send → server receive → tick start → snapshot send → target receive → interpolation delay → target frame
- **What to point at:** Stacked bar of 7 measured segments next to the `est.` 190 ms; last shot plus a rolling average of 20.

### P12 — Send and tick rate

Status: not built yet

- **Idea:** Send and tick rate. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P12**. Toggles it sets (HANDOFF B.6): Selectors, plus cost meters: server ms per tick, bytes/s per client, total egress
- **What to point at:** Bar drops to about 103 (64/s) and about 80 (128 Hz); cost rises roughly linearly.

### P13 — Client FPS

Status: not built yet

- **Idea:** Client FPS. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P13**. Toggles it sets (HANDOFF B.6): FPS cap, applied to all clients via the Lab
- **What to point at:** Both frame segments shrink; 128 Hz + 144 FPS gives about 71 ms.

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

### P16 — Regions and fragile cables

Status: not built yet

- **Idea:** Regions and fragile cables. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P16**. Toggles it sets (HANDOFF B.6): Three region instances `hcm`, `hn`, `sg`. The player picks a simulated ISP profile (Viettel, VNPT, FPT) that sets base RTT and jitter per region. Button "cable cut" raises RTT and loss on routes to `sg`
- **What to point at:** Ping and the budget bar change by region; a cable cut hurts only `sg`. Labelled simulated.

### P17 — Beacons and matchmaking

Status: not built yet

- **Idea:** Beacons and matchmaking. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P17**. Toggles it sets (HANDOFF B.6): Client pings each region's beacon over WebTransport datagrams (UDP underneath, not ICMP) 10× and takes the median; the ticket carries the RTT map; the matchmaker applies a max-latency threshold and relaxes it (demo: 60 → 100 ms after 10 s, configurable)
- **What to point at:** Matchmaker UI shows ticket, RTT map, chosen region and the relaxation step.

### P18 — Relay / backbone

Status: not built yet

- **Idea:** Relay / backbone. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P18**. Toggles it sets (HANDOFF B.6): Route via relay with conditioner "public" (high jitter and loss) versus "backbone" (low)
- **What to point at:** Jitter and loss graphs and the budget bar improve. Labelled simulated.

### P19 — Tick health

Status: not built yet

- **Idea:** Tick health. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P19**. Toggles it sets (HANDOFF B.6): Tick-duration histogram, **% ticks within budget**, GC pauses from `runtime/metrics`. Toggle "allocating loop" (allocate per entity per tick, naive encoding) versus "zero-alloc loop" (pre-allocated buffers, `s = s[:0]`, `sync.Pool`); `GOMEMLIMIT` setting; 50 bots
- **What to point at:** The naive loop shows GC spikes and a lower % within budget; the zero-alloc loop is flat. `-gcflags=-m` findings documented.

### P20 — Percentiles

Status: not built yet

- **Idea:** Percentiles. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P20**. Toggles it sets (HANDOFF B.6): Clients report RTT, jitter and loss; Prometheus histograms labelled region × ISP × platform; Grafana p50/p95/p99; alert "p95 of one ISP > X for 1 min"; `scripts/netem.sh` profile "VN → SG cable cut"
- **What to point at:** The mean looks fine while p99 does not; the cable-cut drill fires the alert.


## Other genres (A.13), in the duel mini-mode

### P21 — Rollback

Status: not built yet

- **Idea:** Rollback. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P21**. Toggles it sets (HANDOFF B.6): Run local input now, predict the opponent as "repeat last", save state each frame, and on a late input load and resimulate
- **What to point at:** HUD: rollbacks per second, frames rolled back.

### P22 — Input delay

Status: not built yet

- **Idea:** Input delay. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P22**. Toggles it sets (HANDOFF B.6): D frames, auto by ping (0 below 100 ms, 1 for 100–199, 2 from 200) or manual
- **What to point at:** Higher D gives fewer rollbacks.

### P23 — Lockstep

Status: not built yet

- **Idea:** Lockstep. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P23**. Toggles it sets (HANDOFF B.6): No frame advances until both inputs arrive, plus a playout buffer
- **What to point at:** Stalls under jitter where rollback does not.


## Edge cases and extras (A.10, A.14, A.15)

### P24 — Died behind the wall

Status: not built yet

- **Idea:** Died behind the wall. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P24**. Toggles it sets (HANDOFF B.6): Victim death replay: the victim's own last frames versus the server's rewound position at hit time. Options: history cap, "favour victim when shooter RTT > X ms"
- **What to point at:** The victim sees why they died behind cover; changing options changes the outcome.

### P25 — Glitch lab

Status: not built yet

- **Idea:** Glitch lab. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P25**. Toggles it sets (HANDOFF B.6): Buttons: "server-only speed modifier" (rubber-band), "loss burst > buffer" (teleport), in the duel "inject nondeterminism" (desync caught by per-frame checksum)
- **What to point at:** Each glitch is reproducible on demand and named on screen.

### P26 — Sub-tick

Status: not built yet

- **Idea:** Sub-tick. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P26**. Toggles it sets (HANDOFF B.6): Use `subtickFrac` for fire timing within the tick, versus quantising to the tick
- **What to point at:** Shot-timing error histogram at 64 Hz, on versus off. Never claim it equals 128 Hz.

### P27 — Compression

Status: not built yet

- **Idea:** Compression. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P27**. Toggles it sets (HANDOFF B.6): Toggles: quantisation, bit packing, delta against the acked baseline
- **What to point at:** kbps meter for raw, quantised and delta, at rest versus moving.

### P28 — Interest management

Status: not built yet

- **Idea:** Interest management. See [CONCEPTS.md](CONCEPTS.md) for the Part A section.
- **What to click:** Lab panel (F1) → preset **P28**. Toggles it sets (HANDOFF B.6): Grid cells; replicate only entities in nearby cells; 50+ bots
- **What to point at:** Entities and bytes per client, on versus off.

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

