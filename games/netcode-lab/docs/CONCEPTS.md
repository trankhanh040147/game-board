Copied from HANDOFF.md Part A; keep in sync.

# Part A — Domain knowledge

<a id="a1"></a>

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

<a id="a2"></a>

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

<a id="a3"></a>

## A.3 Why shooters are the hard case

Claypool & Claypool ("Latency and player actions in online games", CACM 2006) rank game actions by precision
and deadline:

- First-person shooting is the most latency-sensitive. The commonly cited threshold is about 100 ms (from a
  secondary summary, so say "about").
- Top-down strategy games are the least sensitive.
- Riot reported that 10–20 ms differences changed the outcome of gunfights in playtests.

Solving latency for a shooter covers most other genres, which is why the demo is a shooter. Fighting and
strategy games use different tools (A.13).

<a id="a4"></a>

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

<a id="a5"></a>

## A.5 Design 2: "trust the client" (instant but cheatable)

**How it works:** the client simulates itself and reports results ("I am at x=11", "I hit Binh in the
head"). The server only relays them.

**What goes right:** the player sees an instant response, and hits match what they saw.

**What goes wrong:** the server cannot tell a genuine client from a modified one that sends "headshot" through
a wall from across the map. The two packets look identical.

**Scorecard:** Instant ✓ and Fair ✓, Cheat-proof ✗. Comparing design 1 with design 2 shows the trade-off
space: each fails a different goal.

<a id="a6"></a>

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

<a id="a7"></a>

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

<a id="a8"></a>

## A.8 Other players arrive in steps, not motion

The client cannot predict another player because it does not know their keys. It learns their position only
from snapshots, which arrive every 50 ms at 20/s, while the screen draws every 16.7 ms.

**Drawing the latest snapshot directly** gives this pattern: the other player stands still for about 3 frames,
then jumps one step, and repeats.

**With jitter** (normal on the Internet), one snapshot arrives 20 ms late: the player stands still longer and
the next jump is bigger.

This is the default behaviour when nothing is done, not a fault. **Scorecard:** Smooth ✗.

<a id="a9"></a>

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

<a id="a10"></a>

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

<a id="a11"></a>

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

<a id="a12"></a>

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

<a id="a13"></a>

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

<a id="a14"></a>

## A.14 Symptoms players report, and their mechanism

| Symptom | Mechanism |
|---|---|
| Rubber-banding | The client's prediction is corrected back to the server's state. It is also tied to the server's input buffer running empty: Epic's Rocket League support page says the server then repeats the last input. |
| Teleporting | Packet loss longer than the interpolation buffer can cover. |
| Desync | Non-deterministic simulation in lockstep or rollback games, caught by state checksums. |

<a id="a15"></a>

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

<a id="a16"></a>

## A.16 Honesty rules for numbers

- Numbers from the running assumptions (A.1, A.11) are **estimates** and are labelled `est.`.
- Public figures (Riot, Valve, Overwatch, cable incidents, ping ranges) are **references**, attributed, and
  never displayed as this game's own measurements.
- The game shows **its own measured numbers**. Where it shows a reference or an estimate next to them, that
  column is labelled `ref` or `est.`.
- Simulated infrastructure (regions, ISP profiles, cable cuts, backbone) is labelled **simulated**.
