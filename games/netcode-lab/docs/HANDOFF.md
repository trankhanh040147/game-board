# Handoff: "Netcode Lab", a playable team shooter that teaches online-game latency

You are building a small, playable, multiplayer first-person shooter whose real purpose is teaching. Each
technique online games use to hide and reduce network latency must exist in the game as code that can be
switched on and off live. A presenter can then show each idea in the running game, and a team of 2–10
engineers can play it together afterwards. This is a non-commercial internal demo for backend (Go) engineers.

This document is self-contained:

- **Part A** is the domain knowledge you must implement. Read it fully before designing anything: it explains
  every mechanism, why it exists, what it costs, and the public numbers behind it.
- **Part B** is the product, stack, protocol, features, verification and milestones.

---

# Part A — Domain knowledge

## A.1 Vocabulary

- **Authoritative server.** The single source of truth for the game state. Clients send what the player
  *did* (inputs); the server decides what *happened* (positions, hits, deaths).
- **RTT (round-trip time).** Time for a packet to go client → server → client. "Ping" in games is RTT. RTT is
  measured instead of one-way delay because it needs only one clock. One-way delay is estimated as RTT/2.
- **Tick.** One step of the server simulation. A 64 Hz server ticks every 15.6 ms (the official rate of a
  well-known tactical shooter); competitive servers use 128 Hz (7.8 ms).
- **Snapshot.** A packet in which the server sends the current world state to a client. Classic Source-engine
  default: 20 snapshots/s, so one every 50 ms. The snapshot rate can be lower than the tick rate.
- **Frame.** One render of the client screen: 60 FPS is 16.7 ms, 144 FPS is 6.9 ms.

**Running assumptions for the demo's default settings:**
- server 64 Hz, snapshots 20/s, clients 60 FPS;
- RTT 40 ms (20 ms each way) for every player, which is about a good Vietnam → Singapore route by player
  reports (anecdotal, not a measurement).

## A.2 The four goals of netcode, and why they conflict

Netcode is the code that keeps several copies of one match (each client's and the server's) close enough
that the game feels right, even though packets always take time. "Right" means four goals a player can
observe:

| Goal | Player-visible meaning |
|---|---|
| **Instant** | I press a key and my character reacts immediately. |
| **Smooth** | Other players move fluidly on my screen, without stepping or jumping. |
| **Fair** | If I aim on target on my screen, I hit. |
| **Cheat-proof** | A modified client cannot declare "I hit him" or "I am over there". |

The goals pull against each other. Instant is easy if the server trusts the client, but trusting the client
destroys Cheat-proof. Every technique below exists to win one goal without losing another. The demo shows these
four cells as a live **scorecard** that changes colour as techniques are toggled.

## A.3 Why shooters are the hard case

Claypool & Claypool ("Latency and player actions in online games", CACM 2006) rank game actions by precision
and deadline:

- First-person shooting is the most latency-sensitive. The commonly cited threshold is about 100 ms (from a
  secondary summary, so say "about").
- Top-down strategy games are the least sensitive.
- Riot reported that 10–20 ms differences changed the outcome of gunfights in playtests.

Solving latency for a shooter covers most other genres, which is why the demo is a shooter. Fighting and
strategy games use different tools (A.13).

## A.4 Design 1: the "dumb client" (correct but slow)

**How it works:** the client sends key presses and renders only what the server sends back. The server
simulates everything. This is a plain request/response architecture.

**What happens when the player presses W:**
1. wait for the next client frame to send the input;
2. 20 ms uplink;
3. wait for the next server tick;
4. 20 ms downlink;
5. wait for the next client frame to draw.

The character moves only after at least one RTT plus tick wait plus frame wait: about 40–72 ms here (est.).
Gabriel Gambetta's "Fast-paced multiplayer" articles show the same effect at about 200 ms per action with
100 ms of lag.

**Scorecard:** Cheat-proof ✓ (the server decides everything), Instant ✗.

## A.5 Design 2: "trust the client" (instant but cheatable)

**How it works:** the client simulates itself and reports results ("I am at x=11", "I hit Binh in the
head"). The server only relays them.

**What goes right:** the player sees an instant response, and hits match what they saw.

**What goes wrong:** the server cannot tell a genuine client from a modified one that sends "headshot" through
a wall from across the map. The two packets look identical.

**Scorecard:** Instant ✓ and Fair ✓, Cheat-proof ✗. Comparing design 1 with design 2 shows the trade-off
space: each fails a different goal.

## A.6 Client-side prediction (Instant without giving up authority)

**How it works:**
- The client runs the **same movement rules** as the server on its **own** inputs and draws the result in the
  current frame: 0 ms of network wait.
- At the same time it sends the **input** ("I pressed W at input #41") to the server, never the result.
- The server still simulates and decides.

This was the step forward of the Quake-era engines (Glenn Fiedler's articles describe it).

**Requirement:** client and server movement code must be identical. If they differ, predictions are wrong.

**What can be predicted:**
- **Can:** your own movement, and the cosmetic parts of your own shot (muzzle flash, tracer, sound).
- **Cannot:** other players, because you do not know their keys; and the hit result, which the server decides.

**Scorecard:** Instant ✓, Cheat-proof ✓.

## A.7 Reconciliation: number inputs and replay the unconfirmed ones

**The problem.** With 40 ms RTT, the player presses W #1, #2 and #3 before the server answers #1. When the
answer "x=11" arrives, the screen already shows x=13. Snapping to 11 would jerk the character back. The
server is not wrong: x=11 is correct *as of input #1*. This happens constantly, so it is the normal case,
not a fault.

**The fix:**
1. Every input carries a **sequence number**. The client keeps the **unacknowledged** inputs in a queue.
2. The server answers "processed up to #1, x=11".
3. The client drops #1 from the queue, resets its base state to the server's x=11, and **replays** #2 and #3
   on top of it: 11 → 12 → 13.
4. With identical rules the result equals the prediction, so nothing moves on screen.

**Analogy for backend engineers:** a log with sequence numbers. The server's answer is the committed offset;
the client re-applies everything after that offset to the committed state.

**When the server computes something different** (the player was slowed by a hit, pushed, stunned), the
replayed result differs and the client corrects. A hard correction shows as **rubber-banding**. Games smooth
the correction over a few frames.

## A.8 Other players arrive in steps, not motion

The client cannot predict another player because it does not know their keys. It learns their position only
from snapshots, which arrive every 50 ms at 20/s, while the screen draws every 16.7 ms.

**Drawing the latest snapshot directly** gives this pattern: the other player stands still for about 3 frames,
then jumps one step, and repeats.

**With jitter** (normal on the Internet), one snapshot arrives 20 ms late: the player stands still longer and
the next jump is bigger.

This is the default behaviour when nothing is done, not a fault. **Scorecard:** Smooth ✗.

## A.9 Entity interpolation: render other players in the past

**The fix.** The client deliberately draws other players **about 100 ms in the past**. At that point in time it
always holds **two** known snapshots, one on each side, and draws the player gliding between them. Drawing
between two points needs the later point, which exists only if you draw in the past. Drawing "now" would
require guessing (extrapolation), which is wrong whenever the player stops or turns.

**Why 100 ms rather than 50 ms:**
- 50 ms is enough only if every snapshot arrives on time.
- The Source engine defaults to 100 ms, that is 2 × the 50 ms interval (`cl_interp 0.1`).
- Fiedler recommends about 3 × the send interval, to survive two lost packets in a row.

**Cost.** The other player you see is old: about 100 ms of buffer plus 20 ms of downlink, roughly 120 ms. Your
screen lives at two times at once: **you** in the present (predicted), **everyone else** about 120 ms in the
past. The press reported that Overwatch cut interpolation delay from about 60 to about 20 ms when it moved to
about 60 Hz updates (secondary source, say it as such).

**Scorecard:** Smooth ✓.

## A.10 "Same instant, three truths" and lag compensation

**The problem.** At the same moment, three machines see three truths:
- the **shooter's screen** shows the target about 120 ms ago, still in the open, and the shooter aims on target;
- the **server** knows the target has already moved about 120 ms further;
- the **target's screen** shows itself already reaching cover.

If the server checks the shot against the target's *current* position, the shooter aimed true and still
misses. Nobody cheated: server and client are talking about two different moments. **Scorecard:** Fair ✗.

**Lag compensation (rewind)** fixes this:
1. The server keeps a **history of player positions and hitboxes** per tick. The Source engine keeps up to
   1 s (`sv_maxunlag`) and rewinds **only players, never the whole world**.
2. The fire command carries **when** and **in which direction** the player shot.
3. The server computes which frame the shooter was *seeing*: the shot time minus the shooter's interpolation
   delay.
4. It moves the other players' hitboxes back to that frame, traces the ray, then restores them. A hit on the
   shooter's screen is a hit on the server.

Valve's developer wiki has a well-known picture of this: client-side hitbox in red, server-side rewound hitbox
in blue. Reproduce that picture as a debug overlay.

**Scorecard:** Fair ✓.

**Authority is preserved.** Even when rewinding to the shooter's view, the server receives only an input
("fire at time t, direction θ") and decides the result from **its own** history. The client never says "I hit".
The server caps how far back a client may claim (for example 1 s), so a client cannot rewind arbitrarily.

**With all four techniques the scorecard is all green:**

| Goal | Technique |
|---|---|
| Instant | prediction + reconciliation |
| Smooth | interpolation |
| Fair | lag compensation |
| Cheat-proof | server authority |

**Side effect: "died behind the wall".** Rewinding is fair to the shooter, so it looks unfair to the target.
The target can die after reaching cover on their own screen, because the server rewound to when they were
still exposed. Mitigations:
- cap the rewind window more tightly;
- favour the victim when the shooter's ping is high.

A figure of "Overwatch caps at about 220 ms" circulates but is unverified; do not use it.

**Peeker's advantage.** The player who moves out from a corner sees the defender before the defender sees
them, because of these delays. It can be reduced, never eliminated.

## A.11 The latency budget of one shot

Correctness is solved; the next question is cost in milliseconds. Follow one shot from the shooter's click
until the target **sees** the hit. Each "wait for the next X" counts as half its period on average.

| Segment | Default value (est.) |
|---|---|
| Shooter's frame wait (half of 16.7) | 8 |
| Uplink (RTT/2) | 20 |
| Wait for server tick (half of 15.6) | 8 |
| Wait for snapshot send (half of 50) | 25 |
| Downlink (RTT/2) | 20 |
| Target's interpolation buffer (2 × 50) | 100 |
| Target's frame wait (half of 16.7) | 8 |
| **Total** | **≈ 190 ms** |

**Key insight.** Only about 40 ms of this is "the network". The largest segment, the 100 ms interpolation
buffer, and most of the rest are **design choices** (snapshot rate, tick rate, FPS), which means the team can
control them. Riot built the same kind of budget when designing VALORANT's netcode.

**Lever 1: send rate and tick rate.** The Source formula is buffer = ratio / send rate.

| Configuration | Changes | Total (est.) |
|---|---|---|
| Snapshots 64/s | buffer ≈ 31 ms, snapshot wait ≈ 8 ms | ≈ 103 ms |
| Tick and send 128 Hz | tick wait ≈ 4, snapshot wait ≈ 4, buffer ≈ 16 | ≈ 80 ms |

The **price** is that server CPU and bandwidth grow roughly linearly with the rate:
- Respawn said 60 Hz versus 20 Hz costs about 3× (quoted via an Edgegap blog post).
- Riot had to cut the server frame to 2.34 ms so that three 128-tick matches fit on one CPU core.

Tick-rate guide by genre (rule of thumb, not a benchmark): 20–30 Hz for MOBA and survival games, about 60 for
action games, 64–128 for tactical shooters.

**Lever 2: client FPS.** At 144 FPS each frame wait drops from about 8 to about 3.5 ms, at both ends (shooter
and target): 128 Hz + 144 FPS gives **≈ 71 ms** (est.). The backend does not control player FPS, but it must
know about this segment, so that not everything is blamed on the network or the server.

**Real case, Riot / VALORANT, peeker's advantage:**
- Baseline was about 141 ms.
- Netcode work (Riot Direct backbone, 128-tick servers, reduced buffering) cut about 40 ms (−28%), so about
  101 ms. The 101 is a subtraction; Riot published only the reduction.
- Only with 144 FPS clients does it reach about 71 ms (−49%). Do not say "128 tick took it from 141 to 71".
- "35 ms RTT for 70% of players" was Riot's **pre-launch target**, not a measurement.
- Riot concluded peeker's advantage cannot reach zero.
- That the ≈ 71 ms in the table equals Riot's 71 is a coincidence: the two are different measurements.

**Lever 3: server placement** (A.12). It is the only lever that shrinks the two network segments.

## A.12 Infrastructure: where the server is and how packets get there

**Region choice for Vietnam:**
- International traffic depends on 6 subsea cables, which average about 10 incidents per year since 2022.
  In August 2026, 4 cables were faulty at the same time, and repairs can take months (VnExpress).
- Ping to Singapore is about 30–40 ms on a good route and 60–100 ms on a bad one. These are player reports,
  so state them as anecdotal.
- Recommendation: primary regions **in-country** (Ho Chi Minh City, Hanoi), Singapore as the SEA hub.
- Measure per ISP (Viettel, VNPT, FPT), because peering matters more than geography.
- Every 10 ms of RTT saved removes 10 ms from the budget.

**Region selection and matchmaking:**
- The client pings a **UDP beacon** in each region several times and takes the **median**. AWS GameLift
  provides UDP ping beacons because ICMP is inaccurate: many networks deprioritise or block it. PlayFab uses
  QoS beacons on port 3075.
- The RTT map travels with the matchmaking ticket.
- The matchmaker applies a **maximum-latency threshold** and **relaxes it** the longer a player waits, trading
  ping for queue time. "60 ms, relaxed to 100 ms after 20–30 s" is a sensible default, not a benchmarked one.
- Pitfall: declaring latency for a location with no fleet can make requests fail.

**Private backbone / relays** (for players far from every region):
- Put packets onto a private network at a nearby point of presence (PoP) as early as possible, instead of
  crossing many public ISP hops.
- Riot Direct is Riot's own backbone, built from 2014. It absorbed a 500 Gb/s DDoS attack aimed at VALORANT
  servers.
- The figure "31% → 80% of North American LoL players under 80 ms" comes from Quartz, a press source, and
  covers North America only.
- Valve's Steam Datagram Relay hides server IPs and picks relays. Valve admits that if the server is far from
  a relay, the relayed path can be slower.
- Mid-size studios should rent this, not build it.

**Server tick health:**
- The budget assumes every tick finishes on time. A tick that overruns its 15.6 ms (or 7.8 ms) budget adds
  wait.
- Measure the **percentage of ticks within budget**, not the average. Riot tracks "% of frames within the
  128 Hz budget" and reached ≥ 99.3% after patch 5.07.
- For Go servers, the tail risk is **GC**:
  - pre-allocate buffers and reuse slices (`s = s[:0]`);
  - use `sync.Pool` for packets;
  - check escape analysis with `-gcflags=-m`;
  - set `GOMEMLIMIT`;
  - batch UDP I/O with `ReadBatch`/`WriteBatch` from `golang.org/x/net`.
  - Go's Green Tea GC cuts GC time by roughly 10%.

**Measuring in production:**
- Measure RTT over UDP from the client, not ICMP (AWS and Microsoft guidance).
- Averages hide the players who lag. Example: mean 38 ms, but p95 85 ms and p99 140 ms (illustrative).
- Report p50/p95/p99 plus jitter and loss %, split by region × ISP × platform. Riot also sets targets as
  distributions ("% of players under X ms").
- A sudden p95 jump on one ISP is often the first signal of a cable incident, so alert on it.
- In CI, use Linux `tc netem` to simulate a Vietnam → Singapore route during a cable cut: added delay, jitter
  and loss.

## A.13 Other genres: rollback and lockstep

**Fighting games (most sensitive): rollback.** GGPO (2009):
- Each machine runs its own input immediately and **guesses** the opponent's input, usually "same as last
  frame".
- When the real input arrives and differs, the machine loads a saved state and re-simulates to the present.
- This requires a fully **deterministic** simulation.

**Input delay** reduces rollbacks: both players' inputs take effect D frames later.
- Frames to hide ≈ (RTT/2) / 16.67 ms. The first part is hidden by input delay, the rest corrected by rollback.
- Street Fighter 6 adds 0, 1 or 2 frames of input delay by ping (0 below 100 ms, 1 for 100–199 ms, 2 from
  200 ms), and does not lower it mid-match.

**Strategy games (least sensitive): lockstep.**
- Send **commands**, not state: hundreds of units make state too heavy.
- Every machine runs the same deterministic simulation, and a frame advances only when all players' commands
  for it have arrived. A playout buffer absorbs jitter.
- Determinism needs fixed-point arithmetic plus state checksums to detect **desync**.

## A.14 Symptoms players report, and their mechanism

| Symptom | Mechanism |
|---|---|
| Rubber-banding | The client's prediction is corrected back to the server's state. It is also tied to the server's input buffer running empty: Epic's Rocket League support page says the server then repeats the last input. |
| Teleporting | Packet loss longer than the interpolation buffer can cover. |
| Desync | Non-deterministic simulation in lockstep or rollback games, caught by state checksums. |

## A.15 Further techniques

**Sub-tick (CS2):**
- Input timestamps are recorded *inside* the tick interval, but simulation and broadcast stay at 64 Hz.
- Valve published no latency measurements for it, and the community is split on its effect.
- Do not claim "sub-tick = 128 tick".
- Analogy: event time versus processing time in stream processing.

**Compression** (Glenn Fiedler, simulating 901 cubes at 60 Hz):
- Uncompressed: about 17.4 Mbps.
- "Smallest-three" quaternion encoding takes rotation from 128 to 29 bits; position quantisation takes 96 to
  50 bits.
- **Delta encoding against the last snapshot the client acknowledged** saves another order of magnitude:
  about 15 kbps when the scene is at rest.
- His target was under 256 kbps; with cubes in motion he measured about 242 kbps.

**Interest management:**
- Fortnite started with 100 players and about 50,000 replicated actors; checking every actor against every
  client was too expensive.
- Unreal's Replication Graph divides the world into a grid, and each client receives only actors in nearby
  cells.
- Sending less data also shortens the server's time per tick.

**Transport:**
- TCP delivers in order. If packet 2 is lost, packets 3, 4 and 5 wait for its retransmission (head-of-line
  blocking).
- A stale snapshot is worthless once a newer one exists, so snapshots do not go over TCP. UDP delivers
  whatever arrives.
- Browsers cannot open raw UDP. **WebTransport** provides UDP-like datagrams over QUIC; it became Baseline in
  March 2026 when Safari 26.4 shipped it.

## A.16 Honesty rules for numbers

- Numbers from the running assumptions (A.1, A.11) are **estimates** and are labelled `est.`.
- Public figures (Riot, Valve, Overwatch, cable incidents, ping ranges) are **references**, attributed, and
  never displayed as this game's own measurements.
- The game shows **its own measured numbers**. Where it shows a reference or an estimate next to them, that
  column is labelled `ref` or `est.`.
- Simulated infrastructure (regions, ISP profiles, cable cuts, backbone) is labelled **simulated**.

---

# Part B — What to build

## B.1 Goals and non-goals

**Goals**

1. **Playable as a team.** 2–10 players in the browser, two teams (Blue `#2563EB` and Orange `#EA580C`), short
   rounds, one hitscan rifle, headshots, a scoreboard with ping. Fun for 15 minutes is the bar.
2. **Every Part A idea is a live toggle or preset** (B.6), with something visible on screen that shows it.
3. **Measured, not asserted.** The A.11 budget is measured live, segment by segment, and shown next to the
   estimate.
4. **Works on a LAN.** A LAN has about 1 ms RTT, which hides every problem. A built-in network conditioner
   (delay, jitter, loss, per direction, per client) makes the default experience match A.1: RTT 40 ms, 64 Hz,
   20 snapshots/s, 60 FPS.

**Non-goals**

- Not a clone of any commercial game. Use no names, maps, models, sounds, UI or weapon names from
  Counter-Strike or any other title. Genre mechanics are fine: rounds, hitscan, peeking. Art is primitives or
  CC0 assets (for example Kenney), sounds are CC0, the map is original.
- No accounts, persistence, real anti-cheat, mobile support or production hardening.

## B.2 Recommended stack, and why

| Layer | Choice | Why |
|---|---|---|
| Game server | **Go** (latest stable, ≥ 1.26), single binary | The audience is Go engineers, and the tick-health advice in A.12 must be demonstrable in this code. |
| Shared simulation | **One Go package `sim`**, compiled natively for the server and to **WebAssembly** (`GOOS=js GOARCH=wasm`) for the client | Prediction and replay (A.6, A.7) need identical rules on both sides. One source removes drift bugs. |
| Client | **TypeScript + Vite + Three.js**, Pointer Lock API, raw mouse input | Zero install: teammates open a URL. |
| Transport (game) | **WebTransport datagrams** via `quic-go` + `webtransport-go`; **WebSocket** as an alternative mode | A.15. The WebSocket (TCP) mode exists on purpose, to show head-of-line blocking under loss. |
| Transport (control) | WebTransport reliable stream (or the WebSocket) carrying JSON | Join, team, chat, Lab settings. JSON never goes in the per-tick path. |
| Wire format | Hand-written binary: little-endian, bit-packed, quantised, delta against the acked baseline | A.15 compression, with a byte counter showing raw versus compressed. |
| Network conditioner | In-process, in the server's send/receive path, per client and direction: base delay, jitter, loss %, duplicate %, reorder | Required for a LAN. Also ship `scripts/netem.sh` (Linux `tc netem`) for CI. |
| Regions and matchmaking | The same server binary run as N region instances (`hcm`, `hn`, `sg`) with simulated base RTT per player profile; a Go matchmaker over HTTP; a beacon endpoint per region | A.12. |
| Relay | A tiny Go datagram relay; conditioner profiles "public internet" versus "backbone" | A.12. Simulated and labelled. |
| Metrics | `prometheus/client_golang`, Prometheus + Grafana in Docker Compose with a provisioned dashboard and an alert rule | A.12 percentiles and tick health. |
| Bots | Headless Go clients using the same `sim` package | Fill teams, run the peek test, load-test interest management, run CI. |
| Duel mini-mode | 2D canvas 1v1, deterministic **fixed-point** sim in Go/WASM | A.13 rollback, input delay, lockstep and desync. A shooter does not use them, so they live in a separate mode. |
| Tests | `go test` (including native-versus-WASM determinism), headless bot integration tests, Playwright smoke test | B.9. |
| Run | `make dev` (Vite + server with hot reload) and `docker compose up` (everything, including Grafana) | One command each. |

Browser note: WebTransport on `localhost` needs a self-signed **ECDSA** certificate valid **≤ 14 days**, passed
to the client via `serverCertificateHashes`. Generate it at server start and serve the hash over HTTP. Chrome,
Edge and Firefox work, and Safari from 26.4. If WebTransport fails, fall back to WebSocket with a visible
banner.

## B.3 Game design (minimum that is still fun)

- **Map "Courtyard"** (original): Blue spawn, an **open gap** that players must cross, a **low wall** giving
  cover, Orange spawn, and two side lanes so that peeking corners exist. This layout makes A.10 easy to show:
  the shooter aims at a runner crossing the gap toward the wall. Geometry is a list of axis-aligned boxes in
  `shared/map.json`, read by both sim builds.
- **Movement:** WASD, mouse look, jump. Acceleration, friction and gravity run in `sim`'s fixed timestep.
  Player collider is an AABB with swept collision against map boxes.
- **Weapon:** one hitscan rifle at 600 rpm, **no random spread** (spread muddies the lag-compensation demo).
  Recoil is cosmetic and client-only. Body 25 damage, head 100. Hitboxes are one head box and one body box per
  player, kept in the server's history.
- **Mode:** team deathmatch, 2-minute rounds, respawn after 3 s, kill feed, scoreboard with ping, loss and FPS
  columns.
- **Predicted cosmetics:** muzzle flash, tracer, impact decal and sound play instantly. Hit marker and damage
  numbers appear only when the server confirms.

## B.4 Simulation and timing

All values are live-configurable from the Lab panel. The defaults match A.1.

| Setting | Default | Allowed |
|---|---|---|
| Server tick rate | 64 Hz | 20, 30, 64, 128 |
| Snapshot send rate | 20/s | 10, 20, 30, 64, 128 (≤ tick rate) |
| Interpolation buffer | 2 × send interval (100 ms at 20/s) | 0–250 ms, or "auto = k × interval" |
| Client FPS cap | 60 | 30, 60, 144, uncapped |
| Lag-compensation history cap | 1000 ms | 0–1000 ms |
| Simulated RTT | 40 ms (20 each way) | 0–300 ms, plus jitter and loss |

Rules that are easy to get wrong:

1. **Fixed timestep everywhere in `sim`.** Never feed frame `dt` into the simulation. Render by interpolating
   between sim states (the "fix your timestep" accumulator).
2. **Float determinism between native and WASM.** Go may fuse `a*b+c` into an FMA instruction on arm64 (Apple
   Silicon) but not on wasm, which gives different results. Prevent fusion with explicit conversions,
   `float64(a*b) + c`, or use fixed-point. A test must prove that native and WASM produce identical state hashes
   (B.9).
3. **Clock sync.** The client estimates the server tick from ping/pong timestamps (NTP-style: median of the
   lowest-RTT samples). It runs its prediction ahead of the server by about RTT/2 plus a small margin, so that
   inputs arrive just before the tick that needs them. The server keeps a small per-client input buffer; when
   the buffer is empty it repeats the last input and counts that event (A.14).
4. **Redundant inputs.** Every input packet carries the last 3 unacknowledged inputs.
5. **Lag compensation uses the shooter's render time.** The fire command carries the tick and fraction at which
   the client was *rendering* other players (server time minus interpolation buffer). The server clamps it to
   the history cap, rewinds only the other players' hitboxes, traces, then restores them.
6. **The server never accepts results from clients**, except in the deliberately unsafe trust-client mode.

## B.5 Protocol (hot path is binary)

All datagrams start with `u8 type, u16 seq, u16 ack, u32 ackBits`, a Fiedler-style ack header.

- **C→S `Input`:** `u32 inputSeq`, `u32 clientTick`, `u16 buttons`, `i16 yaw`, `i16 pitch` (quantised), up to
  3× redundant. When fire is pressed, also `u32 renderTick`, `u16 renderFrac`, `u16 subtickFrac`.
- **S→C `Snapshot`:**
  - `u32 serverTick` and `u32 lastProcessedInputSeq` (the ack reconciliation depends on);
  - the client's own authoritative state;
  - `u8 baselineId`;
  - a delta-encoded list of relevant entities: id, quantised position, yaw, health, animation state;
  - events: hit confirm, kill, damage taken, and optional debug rewind data.
- **C→S `SnapshotAck`:** the baseline id, so the server knows what it can delta against.
- **Ping/Pong:** client send time, server receive time, server send time.
- **Debug feed** (only when the truth overlay is on): the server's current position of every player, for
  drawing "ghosts".
- **Control (JSON, reliable):** join, team, region, Lab changes (admin token only), chat, round state.

Write the codec once in Go, used by the server, bots and the client through WASM.

## B.6 Feature map: every idea as a toggle you can see

Each row is a toggle in the Lab panel and a numbered **preset (P01…)**, ordered as a teaching sequence. Each
preset sets every toggle to the right state in one click. "Observe" is both what the presenter shows and the
acceptance criterion.

### Core netcode (A.4–A.10)

| Preset | Idea | Implementation | Observe |
|---|---|---|---|
| P01 | Vocabulary | Net graph HUD: RTT, tick, snapshot rate, FPS | All four values visible and correct. |
| P02 | Dumb client (A.4) | `mode=dumb`: render only server state, even for yourself | Pressing W moves you only after about one RTT plus waits; HUD "input → motion: N ms" (measured). Scorecard Instant ✗, Cheat-proof ✓. |
| P03 | Trust client (A.5) | `mode=trust`: the client sends its position and hit claims, the server relays. Button "modded client": a bot or the presenter claims headshots through walls | In trust mode fake kills land in the kill feed. In authoritative modes the same packets are rejected and logged "rejected claim". |
| P04 | Prediction (A.6) | `predict=on` | Own movement reacts in the current frame while the server still decides. |
| P05 | Reconciliation (A.7) | `reconcile=on/off` (off means hard snap to server state) | HUD "pending: #41 #42 #43, replayed: 2, corrections: 0". Off shows stutter. |
| P06 | Raw snapshots (A.8) | `interp=off`, with jitter in the conditioner | Other players visibly step every 50 ms, with bigger steps under jitter. |
| P07 | Interpolation (A.9) | `interp=on`, buffer slider, optional **truth ghost** (server's current position) | Smooth motion; the ghost runs ahead by a measured ≈ 120 ms. |
| P08 | Three truths (A.10) | `lagcomp=off`; presenter view (B.7) shows shooter view / server now / target view | Aim on target and the server says miss, with reason "target moved N cm since what you saw". |
| P09 | Lag compensation (A.10) | `lagcomp=on`, history cap slider | On fire, an overlay draws the client-seen hitbox (red) and the rewound server hitbox (blue). Hits match the shooter's view. |
| P10 | Scorecard (A.2) | Four-cell scorecard computed from active modes | All green only with predict, reconcile, interp, lagcomp and authority on. |

### Latency budget (A.11)

| Preset | Idea | Implementation | Observe |
|---|---|---|---|
| P11 | Shot budget | Trace every shot on the server-synced clock: click → next client frame → send → server receive → tick start → snapshot send → target receive → interpolation delay → target frame | Stacked bar of 7 measured segments next to the `est.` 190 ms; last shot plus a rolling average of 20. |
| P12 | Send and tick rate | Selectors, plus cost meters: server ms per tick, bytes/s per client, total egress | Bar drops to about 103 (64/s) and about 80 (128 Hz); cost rises roughly linearly. |
| P13 | Client FPS | FPS cap, applied to all clients via the Lab | Both frame segments shrink; 128 Hz + 144 FPS gives about 71 ms. |
| P14 | Peeker's advantage | Peek test: a bot holds an angle, another bot or the player peeks. Measure how long the peeker saw the holder before the holder saw the peeker | One measured number per configuration, labelled "our measurement" (Riot's figures may appear beside it as `ref`). |
| P15 | Budget table | The P11 data as a table: formula value (A.11) beside measured value per segment for current settings | Agreement within a stated tolerance; differences explained. |

### Infrastructure (A.12)

| Preset | Idea | Implementation | Observe |
|---|---|---|---|
| P16 | Regions and fragile cables | Three region instances `hcm`, `hn`, `sg`. The player picks a simulated ISP profile (Viettel, VNPT, FPT) that sets base RTT and jitter per region. Button "cable cut" raises RTT and loss on routes to `sg` | Ping and the budget bar change by region; a cable cut hurts only `sg`. Labelled simulated. |
| P17 | Beacons and matchmaking | Client pings each region's beacon over WebTransport datagrams (UDP underneath, not ICMP) 10× and takes the median; the ticket carries the RTT map; the matchmaker applies a max-latency threshold and relaxes it (demo: 60 → 100 ms after 10 s, configurable) | Matchmaker UI shows ticket, RTT map, chosen region and the relaxation step. |
| P18 | Relay / backbone | Route via relay with conditioner "public" (high jitter and loss) versus "backbone" (low) | Jitter and loss graphs and the budget bar improve. Labelled simulated. |
| P19 | Tick health | Tick-duration histogram, **% ticks within budget**, GC pauses from `runtime/metrics`. Toggle "allocating loop" (allocate per entity per tick, naive encoding) versus "zero-alloc loop" (pre-allocated buffers, `s = s[:0]`, `sync.Pool`); `GOMEMLIMIT` setting; 50 bots | The naive loop shows GC spikes and a lower % within budget; the zero-alloc loop is flat. `-gcflags=-m` findings documented. |
| P20 | Percentiles | Clients report RTT, jitter and loss; Prometheus histograms labelled region × ISP × platform; Grafana p50/p95/p99; alert "p95 of one ISP > X for 1 min"; `scripts/netem.sh` profile "VN → SG cable cut" | The mean looks fine while p99 does not; the cable-cut drill fires the alert. |

### Other genres (A.13), in the duel mini-mode

| Preset | Idea | Implementation | Observe |
|---|---|---|---|
| P21 | Rollback | Run local input now, predict the opponent as "repeat last", save state each frame, and on a late input load and resimulate | HUD: rollbacks per second, frames rolled back. |
| P22 | Input delay | D frames, auto by ping (0 below 100 ms, 1 for 100–199, 2 from 200) or manual | Higher D gives fewer rollbacks. |
| P23 | Lockstep | No frame advances until both inputs arrive, plus a playout buffer | Stalls under jitter where rollback does not. |

### Edge cases and extras (A.10, A.14, A.15)

| Preset | Idea | Implementation | Observe |
|---|---|---|---|
| P24 | Died behind the wall | Victim death replay: the victim's own last frames versus the server's rewound position at hit time. Options: history cap, "favour victim when shooter RTT > X ms" | The victim sees why they died behind cover; changing options changes the outcome. |
| P25 | Glitch lab | Buttons: "server-only speed modifier" (rubber-band), "loss burst > buffer" (teleport), in the duel "inject nondeterminism" (desync caught by per-frame checksum) | Each glitch is reproducible on demand and named on screen. |
| P26 | Sub-tick | Use `subtickFrac` for fire timing within the tick, versus quantising to the tick | Shot-timing error histogram at 64 Hz, on versus off. Never claim it equals 128 Hz. |
| P27 | Compression | Toggles: quantisation, bit packing, delta against the acked baseline | kbps meter for raw, quantised and delta, at rest versus moving. |
| P28 | Interest management | Grid cells; replicate only entities in nearby cells; 50+ bots | Entities and bytes per client, on versus off. |
| P29 | Transport | WebTransport datagrams versus WebSocket, with 5% loss | Snapshot inter-arrival histogram: TCP shows stalls, datagrams do not. |

## B.7 Presenter experience

- **Lab panel** (F1, admin token from env): every toggle, grouped as in B.6, plus one-click presets P01–P29.
  Settings apply server-wide and are broadcast, so the whole room sees the same mode. A banner shows the
  active preset and a one-line explanation of the idea, taken from Part A.
- **Presenter / spectator view:** a top-down 2D view of the Courtyard. For each player it shows the server's
  true position, the interpolated version other clients render, and the locally predicted version (the
  "three truths"). It can pause and step through the last 2 s from a server-side ring buffer, to explain a
  single shot frame by frame.
- **Net graph HUD:** RTT, jitter, loss, snapshot rate, interp buffer, pending inputs, corrections, server tick
  ms, FPS, kbps up/down.
- **Scorecard widget** in the corner (A.2).
- **Conditioner panel:** per-client sliders and presets "LAN", "Default (40 ms)", "Bad route (80 ms, jitter
  15, loss 1%)", "Cable cut".

## B.8 Repository layout

```
netcode-lab/
  cmd/server/        game server (also serves the client build and the beacon)
  cmd/matchmaker/    tickets, RTT map, threshold relaxation
  cmd/relay/         datagram relay
  cmd/bot/           headless bots (fill, peek test, load)
  sim/               shared deterministic simulation (native + wasm): movement, collision, hitscan
  sim/duel/          fixed-point duel sim (rollback, lockstep)
  net/               codec, ack header, conditioner, clock sync
  server/            rooms, tick loop, lag-comp history, interest grid, metrics
  wasm/              WASM entry exposing sim + codec to TS
  client/            Vite + TS + Three.js: render, input, prediction, interpolation, HUDs, Lab panel
  shared/map.json    Courtyard geometry
  deploy/            docker-compose.yml, prometheus.yml, grafana dashboards + alert rule
  scripts/           netem.sh, certs, load tests
  docs/              ARCHITECTURE.md, CONCEPTS.md (Part A, kept current), DEMO.md, MEASUREMENTS.md
```

Copy Part A into `docs/CONCEPTS.md` and link each preset's banner to its section.

## B.9 Verification (run these, don't just write them)

1. **Determinism:** the same recorded input stream in native `sim` and WASM `sim` (via Node) gives identical
   state hashes every tick, on arm64 and amd64.
2. **Reconciliation:** a bot moving under the default conditioner with no server-only modifiers gives
   **0 corrections** over 5 minutes. With the speed modifier, corrections appear and are smoothed.
3. **Lag compensation:** a unit test with a known history checks that a ray at render time T hits the rewound
   hitbox and misses the current one. An integration test with two bots at 40 ms RTT and a target crossing the
   gap gives a hit rate equal to "what the shooter saw", within tolerance.
4. **Budget:** at default settings the measured shot budget is within ±15% of the 190 ms estimate; at 128 Hz +
   144 FPS it is near 71 ms. Record actual numbers in `docs/MEASUREMENTS.md`.
5. **Tick health:** 10 players plus 40 bots at 128 Hz on a dev laptop: the zero-alloc loop keeps p99 tick time
   under budget and ≥ 99% of ticks within budget. Report both loop variants.
6. **Transport:** with 5% loss, WebSocket mode shows inter-arrival stalls longer than 3× the send interval;
   datagram mode does not.
7. **Client smoke (Playwright):** join, move, shoot, open the Lab, apply every preset, with no console errors.
8. **Team playtest:** 4+ people on the LAN, conditioner at default, play one round, then walk through
   presets P02 → P10 → P11–P15. Write notes in `DEMO.md`.

## B.10 Milestones (each ends playable, with its own demo)

1. **M0 Walking skeleton:** tick loop, WebTransport connect, a box moving on the Courtyard, dumb-client mode,
   conditioner, net graph. (P01, P02)
2. **M1 Prediction + reconciliation,** WASM sim, determinism test. (P04, P05)
3. **M2 Snapshots + interpolation,** truth ghost, raw mode. (P06, P07)
4. **M3 Shooting:** hitscan, history, lag comp on/off, three-truths view, trust-client and modded-client
   modes, scorecard. (P03, P08–P10, P24)
5. **M4 Game loop:** teams, rounds, scoreboard, bots, CC0 sounds. It is now fun to play.
6. **M5 Budget and rates:** shot tracing, tick/send/FPS controls, cost meters, peek test, budget table.
   (P11–P15)
7. **M6 Server performance and wire:** zero-alloc versus allocating loop, GC metrics, compression, interest
   grid, transport toggle, sub-tick. (P19, P26–P29)
8. **M7 Infrastructure:** regions, beacons, matchmaker, relay, Prometheus/Grafana, alert, netem script.
   (P16–P18, P20)
9. **M8 Duel mini-mode:** rollback, input delay, lockstep, desync checksum. (P21–P23, P25)
10. **M9 Presenter polish:** every preset with its explanation banner, `DEMO.md` script, README, a GIF per
    preset.

Commit per milestone. Do not move on while the previous milestone's checks fail.

## B.11 Done when

- `make dev` and `docker compose up` work from a clean clone, and a teammate on the LAN can join from a
  browser URL.
- Every row in B.6 has a working toggle and preset with the described observation, listed step by step in
  `DEMO.md`.
- All B.9 checks pass, with outputs saved in `docs/MEASUREMENTS.md`.
- A 4-player playtest round has been played without crashes, with notes in `DEMO.md`.
- Every number on screen is either measured by the game, or labelled `est.`, `ref` or `simulated` (A.16).
