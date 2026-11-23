# Measurements

Every number here was produced by a command in this repo, on the machine named.
Machine for all runs below: Apple Silicon Mac (darwin/arm64), Go 1.26.4, Node v26.5.0,
2026-11-23. Server and clients on the same host (localhost); the network is the in-process
conditioner at its default, 20 ms each way.

## B.9 checks

Status from the results recorded below only. "not run" = no result in this file yet.

| # | Check (HANDOFF B.9) | Status | Recorded result | Section |
|---|---|---|---|---|
| 1 | Determinism, native vs WASM, arm64 and amd64 | **pass** | Identical state hashes on every tick at 20/30/64/128 Hz | [section](#check-1--determinism-native-vs-wasm-b9-1) |
| 2 | Reconciliation, 0 corrections over 5 min | **fail** | Latest runs: 15 corrections (WebTransport), 45 (WebSocket); corrections track server starvations on a loaded host. "With modifier" half cannot run (no speed modifier yet) | [core runs](#check-2--reconciliation-0-corrections-over-5-minutes-b9-2-not-yet-met-on-a-shared-loaded-host), [bots runs](#check-2--runs-by-bots-2026-11-23-one-bot-per-server-5-minutes-each) |
| 3 | Lag compensation (unit + integration) | not run | — | — |
| 4 | Shot budget vs 190 ms est. / 71 ms | not run | — | — |
| 5 | Tick health, 10 players + 40 bots at 128 Hz, both loop variants | not run (preliminary only) | 40 bots, current loop only: 99.92% (64 Hz) / 99.93% (128 Hz) of ticks within budget; per-second p99 max 67.7 / 33.1 ms; no zero-alloc toggle, no human players | [section](#check-5-preliminary--tick-health-with-40-bots-b9-5-p19-p28) |
| 6 | Transport stalls at 5% loss, WS vs datagrams | not run | — | — |
| 7 | Client smoke (Playwright) | **partial** | 18/0/1 at `6db531d` (review: 18/1 independently), 20/0/1 at `082b412` with WT; shoot skipped: shooting not testable until M3 | [section](#check-7--client-smoke-playwright-b9-7-partial-shooting-not-testable-until-m3) |
| 8 | Team playtest, 4+ people | not run | Notes go in DEMO.md | — |

## Check 1 — Determinism: native vs WASM (B.9 #1)

Command: `make determinism` (from `games/netcode-lab`).

Input: `sim/testdata/inputs.bin`, 7680 ticks of a seeded walker stream (WASD combinations,
jumps, continuous and sudden turns, idle periods, wall contact) written by
`go run ./cmd/simtrace -record`. Each build replays it from the blue spawn at every Lab
tick rate (20, 30, 64, 128 Hz) and prints one FNV-1a state hash per tick: 4 × 7680 = 30720
lines. The WASM side is the same `client/public/sim.wasm` the browser loads, driven
through the JS API (`NetcodeSim.step`, `NetcodeSim.hash`) by `wasm/test/determinism.mjs`
in Node. amd64 runs under Rosetta 2.

Output (verbatim):

```
go:     go version go1.26.4 darwin/arm64
native (arm64):     30720 lines  sha256 de0b4ee5068db4c9
amd64 (Rosetta):    30720 lines  sha256 de0b4ee5068db4c9
wasm (node v26.5.0):    30720 lines  sha256 de0b4ee5068db4c9
last tick: 128 7679 f90223561f1d6cc3
PASS native == wasm on every tick (rates 20/30/64/128)
PASS native == amd64 on every tick
```

Negative control (the check can fail): 30516 of the 30720 hashes are distinct, so the state
changes over time. Flipping one input bit at tick 100 makes the WASM trace differ from the
native one first at line 101 (`cmp: differ: char 2298, line 101`).

Why it passes: `sim.Step` uses only integer Q16.16 arithmetic and a generated sine table,
so there is no float operation that arm64 could fuse into an FMA (see DECISIONS 1, 14).

## Unit tests

`go test ./...` (and `go test -race ./server ./net/...`), all passing on 2026-11-23:

```
ok  	netcodelab/net/clock
ok  	netcodelab/net/codec
ok  	netcodelab/net/cond
ok  	netcodelab/server
ok  	netcodelab/sim
```

Race run with output (review V7): `go test -race -count=1 ./...` in `games/netcode-lab` at HEAD `2a993fd`,
macOS arm64, Go 1.26.4, ~16 s, exit 0. This is the first recorded output for the `-race` claim above.

```
ok  	netcodelab/net/clock	1.842s
ok  	netcodelab/net/codec	2.811s
ok  	netcodelab/net/cond	3.549s
ok  	netcodelab/server	3.122s
ok  	netcodelab/sim	3.297s
ok  	netcodelab/sim/duel	3.561s
```

No test files: cmd/bot, cmd/duelbot, cmd/duelrelay, cmd/dueltrace, cmd/server, cmd/simtrace, net/transport,
server/duelrelay, shared.

They cover: codec round-trips of every message, truncated packets error, the ack window
(dups, gaps, loss, RTT), conditioner delay/order/loss/reorder and the TCP-like stall,
clock offset and tick estimate, sim walk speed / wall stop / jump height, predictor 0
corrections with matching rules, corrections with a server-only speed change, and the
control protocol (welcome, admin token, unbuilt preset refused, P02, Lab rate change,
invalid sendRate, self conditioner, `all` needs the token, 1 Hz stats).

## Check 2 — Reconciliation, 0 corrections over 5 minutes (B.9 #2): NOT YET MET on a shared, loaded host

Command: `bin/server` with defaults (64 Hz, 20 snapshots/s, conditioner 20 ms each way, no
server-only modifiers), then `bin/bot -n 2 -d 5m` (walker bots over WebSocket; they predict
and reconcile with the same `sim.Predictor` the browser uses through WASM). A correction =
the server's state for input #N differs bit for bit from what the bot predicted for #N.

| Run | Bot | Inputs | Snapshots (per s) | Corrections | Server starvations | RTT median | Max snapshot gap | Pacer margin at end |
|---|---|---|---|---|---|---|---|---|
| 30 s, 3 bots, light load | each | ~1915 | 20.0 | **0, 0, 0** | 0, 0, 0 | 40.8–41.8 ms | – | 1 tick |
| 5 min (16:42), I was also running race tests, Rosetta builds, WT bots | walker-1 | 19203 | 5999 (20.0) | 7 | 13 | 40.88 ms | 159 ms | 5.25 |
| | walker-2 | 19200 | 5998 (20.0) | 13 | 21 | 40.78 ms | 159 ms | 5.25 |
| 5 min (16:55), my side idle, other team members' Chrome/Playwright running, load avg 15 on 8 cores | walker-1 | 19168 | 5993 (20.0) | 42 | 80 | 40.72 ms | 271 ms | 5.25 |
| | walker-2 | 19170 | 5992 (20.0) | 41 | 69 | 40.72 ms | 295 ms | 5.25 |

**Audit (bots, 2026-11-23, team PID/port rule):** server lifetime unverified for all rows of this table: they were
taken while several members were active, before the PID/port rule, and the server's lifetime is not shown. Not
re-run as such; the current-HEAD reruns are in "Check 2 at HEAD" below.

Diagnosis from the server log of the second 5-minute run: 23 "tick started late" warnings
(50–152 ms late against a 15.6 ms budget), in bursts at 16:55:54, 16:57:18–23, 16:58:25,
16:59:26 and 17:01:00. Server and bots share one saturated machine. When both stall, the
server's input buffer runs empty and it repeats the last input (A.14). Every correction
lines up with such a starvation (corrections ≤ starvations in every run), and with no
starvation there was no correction. That is the A.14 rubber-band mechanism, not a sim mismatch.

Still to do for check 2: rerun on an otherwise idle machine (or server and bots on two
machines). Open design question: the pacer margin only shrinks 0.25 tick per calm 10 s,
so after bursts it stays at 5.25 ticks (≈ 82 ms of extra input delay at 64 Hz).

### Check 2 — runs by "bots", 2026-11-23 (one bot per server, 5 minutes each)

Machine: Apple M1 Pro, 8 cores, 16 GB, macOS 26.4.1, Go 1.26.4 darwin/arm64. Server and bot on
the same host, shared with the rest of the team (builds, Chrome, Playwright). Each run used its own
fresh server with default settings and the default conditioner; `condAtWelcome` in the bot output
confirms `up` and `down` = `{delayMs: 20, jitterMs: 0, lossPct: 0, dupPct: 0, reorderPct: 0}`.
No server-only speed modifier exists in the server yet, so the "with modifier" half of check 2
cannot be run (the only speed-change coverage is the `sim` predictor unit test).

Commands (from `games/netcode-lab`; `sh scripts/check2-reconcile.sh [ws|wt] 5m` does the same):

```
# WebTransport, server built at fc23a53 + core's then-uncommitted server/room.go (tickStartLate stats)
bin/server -http 127.0.0.1:28180 -https 127.0.0.1:28443
bin/bot -url https://127.0.0.1:28443/wt -info http://127.0.0.1:28180 -n 1 -d 5m
# WebSocket, server built at 31b586b (server/, sim/, net/ clean)
bin/server -http 127.0.0.1:28280 -https ""
bin/bot -url ws://127.0.0.1:28280/ws -n 1 -d 5m
```

| Run (start) | Transport | Tick | Inputs | Snapshots | **Corrections** | Server starvations | Pacer raises | RTT median / jitter | Max snapshot gap | Load avg (1 min) before → after | Server late ticks > 3 periods while bot connected (max) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 16:58 | WebTransport | 64 Hz | 19201 | 5996 | **15** | 23 | 15 | 40.90 / 0.52 ms | 216.83 ms | not recorded | 6 (85.6 ms) |
| 17:05 | WebSocket | 64 Hz | 19137 | 5983 | **45** | 92 | 55 | 43.79 / 15.62 ms | 525.67 ms | 5.30 → 14.99 | 14 (206.3 ms) |

**Audit (bots, 2026-11-23, team PID/port rule):** both rows have the server lifetime shown. Each server log has the bot's
`join` and `leave` 300 s apart (WT 16:58:18 → 17:03:18, WS 17:05:42 → 17:10:42), and the bot reported no errors.

Discarded run: a WebSocket run started at 16:58 joined a leftover 128 Hz smoke-test server of mine
(its own server failed to bind the port). It is not a default-settings run. Its numbers, for the
record only: 128 Hz, 38358 inputs, 44 corrections, 88 starvations, 44 pacer raises.

Server log of the WebTransport run: 6 "tick started late" warnings (51.6–85.6 ms against a 15.6 ms
budget) while the bot was connected, and 3 more (60–115 ms) after it left, with no client at all.
WebSocket run: 14 warnings (47–206 ms). Result: **check 2 still fails on this host** — 15 and 45
corrections, not 0. Corrections track starvations (corrections ≤ starvations, and equal to pacer
raises in the WebTransport run), which matches core's diagnosis above. The late ticks also happen
with zero clients connected, so the stalls are host scheduling, not bot load.

## Check 5 (preliminary) — tick health with 40 bots (B.9 #5, P19, P28)

Not yet the real check: B.9 #5 wants 10 players + 40 bots and **both** loop variants. The
zero-alloc vs allocating loop toggle does not exist in the server yet, so only the current loop is
measured. No human players; 40 walker bots from one process (`cmd/bot`) on the same host as the
server, so bots and server compete for the same 8 cores.

Harness: `cmd/bot -n 40 -tick HZ -stats -warmup 10s`. Before the bots join, a short-lived admin
client sets the tick rate through the Lab (`{"t":"lab","settings":{"tickRate":HZ}}`). Bot 1 records
the server's 1 Hz control `stats` message; messages received during ramp-up and the 10 s warmup are
dropped. `withinBudgetPct` is exact over all sampled ticks (tick-weighted). The server reports only
p50/p99/max of the last `tickRate` ticks each second and **no p95**, so whole-window percentiles
cannot be rebuilt: the table gives the median and maximum of the per-second values.
"Tick ms" = server processing time of one tick (`step`), not including the sleep.

Command (server built at 31b586b, server/ sim/ net/ clean):

```
HTTP_PORT=28380 sh scripts/check5-load.sh 64 40 70s 10s
HTTP_PORT=28380 sh scripts/check5-load.sh 128 40 70s 10s
```

| | 64 Hz | 128 Hz |
|---|---|---|
| Budget per tick | 15.625 ms | 7.8125 ms |
| Players in room | 40..40 | 40..40 |
| Stats windows counted (≈1 s each) | 58 | 57 |
| Ticks sampled | 3712 | 7296 |
| **% ticks within budget** | **99.92** | **99.93** |
| Tick ms p50 (median of per-second p50 / max) | 0.035 / 0.068 | 0.029 / 0.037 |
| Tick ms p95 | not reported by the server | not reported by the server |
| Tick ms p99 (median of per-second p99 / p95 of them / max) | 0.732 / 15.679 / 67.687 | 0.548 / 5.656 / 33.128 |
| Tick ms max in any second (median / max) | 0.732 / 67.687 | 1.267 / 59.611 |
| Tick start lateness p99 (median / max) | 1.557 / 63.86 ms | 2.671 / 34.243 ms |
| Worst tick start lateness since server start | 92.861 ms | 179.18 ms |
| Bot corrections, all 40 bots (≈70 s) | 660 | 2315 |
| Worst bot's server-starvation count | 37 | 146 |
| Bot RTT median (median over bots) | 40.22 ms | 40.45 ms |
| Load avg (1 min) before → after | 14.72 → 12.82 | 12.82 → 17.91 |

**Audit (bots, 2026-11-23, team PID/port rule):** server lifetime shown indirectly. Bot 1 received 70 (64 Hz) and 69 (128 Hz)
stats messages in a 70 s run, and 0 bots reported errors. The server logs were not kept. Superseded by
"Check 5 at HEAD" below.

Reading: the typical tick is far under budget (p50 ≈ 0.03 ms for 40 players), but single ticks
take up to 60–68 ms of processing time and tick starts slip by up to 179 ms. On a host with load
average 13–18 on 8 cores this is mostly descheduling, not work; the same machine shows the same
stalls with no clients (check 2 above). These numbers are therefore an upper bound on what the
loop costs and say nothing yet about GC: B.9 #5 needs a run on an idle host, `runtime/metrics` GC
pauses in the stats, and the allocating vs zero-alloc toggle.

## Check 2 follow-up — host stalls injected on purpose (2026-11-23, core)

The 5-minute runs above failed because of host stalls. To test the fix without a quiet machine, the server
process was paused with `kill -STOP` for 120 ms every 5 s (6 times in 40 s; 3 times in 25 s for the last row)
while 2 walker bots ran on the default conditioner. Host load average 10–16 on 8 cores (other members' work).

| Server build | Corrections (bot 1 + bot 2) | Server starvations | Notes |
|---|---|---|---|
| before (missed ticks dropped after > 5 periods, repeat on empty) | 15 + 14 | 21 + 25 | pacer margin ended at 5.25 / 5.75 ticks |
| + fixed-timestep catch-up | 8 + 7 | 19 + 15 | |
| + hold on empty buffer during/just after a stall | **0 + 1** | 0 + 1 | the one starvation was 4 s after the last injected stall (bot process late at load 16), counted per A.14 |

**Audit (bots, 2026-11-23, team PID/port rule):** server lifetime unverified (taken while several members were active,
before the PID rule; the server's lifetime is not shown).

Independent sleep probe (no server code), 64 Hz for 15 s on the same host: default QoS p50 0.90 ms late, p99
6.6 ms, max 23 ms; background QoS p99 33 ms, max 65 ms. The stalls are from the host; DECISIONS 22.

Not yet run by core: the 5-minute B.9 #2 rerun on the fixed server (member "bots" owns long runs).

## Check 3 (unit part) — lag compensation (2026-11-23, core)

`go test -run TestLagCompRewindHitsWhatTheShooterSaw ./server`, passing. Known history: the target crosses the
line of fire at 0.11 m/tick (7 m/s at 64 Hz); the shooter renders tick 100 and fires at tick 108.

- lagcomp off: miss, `seenId` = target, `movedCm` 88 (8 ticks × 0.11 m), no damage.
- lagcomp on: hit at `rewoundTick` 100, and the rewound box equals the box the shooter saw.
- history cap 50 ms: render time clamped (flag), miss.
- favour victim (threshold 30 ms, shooter RTT 80 ms): no rewind (flag), miss.

`TestShootOverTheWire` sends the fire input over a real WebSocket through the 20 ms conditioner and gets the
ShotResult (hit, `recvMs` ≤ `tickStartMs`) and the victim's Damage event back in snapshots.
The integration part of check 3 (two bots at 40 ms RTT, target crossing the gap) is not run yet.

## Check 7 — Client smoke, Playwright (B.9 #7): partial (shooting not testable until M3)

Forwarded by client (it cannot write here); run by client unless noted. Chromium 148 headless.

Command: `cd games/netcode-lab/client && NETLAB_ADMIN_TOKEN=labtok node smoke/smoke.mjs http://127.0.0.1:38080`

| Client commit | Server | Result | Run by |
|---|---|---|---|
| `6db531d` | built from the working tree at `5c4a0fd` | exit 0: **18 passed, 0 failed, 1 skipped** | client |
| (same) | its own server (V2) | 18 passed, 1 skipped | review, independently |
| `082b412` | (as reported) | **20 passed, 0 failed, 1 skipped**, now with the WebTransport leg | client |

New since the earlier 15-pass run:
- Pointer lock refused as a rejected promise: the overlay closes, the drag-to-look note shows, the player moves 5.37 m and dragging turns the view 0.22 rad.
- Pointer lock refused as a synchronous `WrongDocumentError`: the overlay closes, the message names the error, the player moves 9.95 m.
- Esc returns to the overlay.

Skipped: shoot. When these runs were taken the server had no hitscan. Status: **partial: shooting not testable until M3.**
The server-side shooting landed later (`a2afd2d`), but no smoke run with shooting is recorded yet.

## Duel (P21–P23, P25)

Forwarded verbatim from member "duel" (it cannot write here). Real runs on 2026-11-23, M1 Pro. **Server lifetime
unverified**: these runs predate the PID/port rule, so the relay's lifetime is not shown. They are to be re-run
after duel fixes `scripts/duel-measure.sh`.

Setup: two `bin/duelbot` peers through `bin/duelrelay` (commit `f4828bf`), WebTransport datagrams, 30 s per run,
bot input changes about 9/s, 0 desyncs, about 1790 checksums compared per peer. The conditioner applies per client
and per direction, so peer RTT through the relay is about 82 ms under Default (40 ms) and about 160 ms under Bad
route. Values are peer0 / peer1.

DEFAULT
- rollback D0 (auto): 9.20 / 8.77 rollbacks/s, 28.8 / 26.3 frames rolled back/s, max depth 6
- rollback D1: 9.17 / 8.90 rb/s, 18.8 / 18.3 fr/s
- rollback D2: 9.07 / 8.33 rb/s, 11.0 / 9.1 fr/s
- rollback D3: 0.70 / 2.20 rb/s, 0.7 / 2.2 fr/s
- lockstep auto D=4: 0 rollbacks; stalls 6 / 5 frames (103 / 83 ms) in 30 s, 0.2 frames/s
- lockstep D=2 (re-run alone): 504 / 503 stall frames, 8326 / 8499 ms, 16.8 frames/s, 43 fps

BAD ROUTE
- rollback D0: 7.83 / 7.57 rb/s, 44.4 / 42.9 fr/s, max depth 8
- rollback D1 (auto): 7.87 / 7.43 rb/s, 36.3 / 35.4 fr/s
- rollback D2: 7.70 / 7.57 rb/s, 29.2 / 25.6 fr/s
- rollback D3: 7.70 / 7.30 rb/s, 20.1 / 19.9 fr/s
- rollback D5: 4.17 / 3.93 rb/s, 5.0 / 5.3 fr/s
- lockstep auto D=6: 137 / 136 stall frames, 2350 / 2347 ms, 4.6 frames/s, 55 fps
- lockstep D=2: 1018 / 1017 stall frames, 16940 / 16876 ms, 33.9 frames/s, 26 fps

WebSocket under Bad route: every mode stalls about 15–19 frames/s (loss becomes a TCP retransmit stall), at about
41–44 fps.

Finding: the rollback count stays near the opponent's input-change rate until D covers the one-way trip (about 2.5
frames at 82 ms). Depth and frames rolled back fall with every extra frame of D.

Contaminated first runs: "wt default lockstep 2" and "ws default rollback 2" first showed RTTs of 120–370 ms because
they overlapped other work. They were re-run alone; the values above for those rows are the re-runs. The duel member
did not forward the contaminated values.

Determinism: `make duel-determinism` gives native arm64 == amd64 (Rosetta) == WASM: 25201 lines, sha256
a49b4b920738736c, 0 mismatches. Review V5 and V8 confirmed it independently.

Reproduce: `make duel-run`, then `sh scripts/duel-measure.sh 30`.


## Check 2 at HEAD — 5 minutes, 1 bot, defaults (2026-11-23 18:36–18:41, bots)

**Result: check 2 still fails on this host: 20 corrections (WebSocket) and 25 (WebTransport) in 5 minutes.**
Most of them line up with host stalls; 6 per run have no logged late event next to them (details below).

Server and bot built in a clean worktree of `91b61db` (server code = core's `a8a83a5` catch-up/hold fix,
`6c49cde` stats, `a2afd2d` M3; no uncommitted edits). Both runs ran at the same time, each with its own server,
on ports in the bots range. Commands (from `games/netcode-lab`):

```
HTTP_PORT=18600 HTTPS_PORT=18643 sh scripts/check2-reconcile.sh ws 5m
HTTP_PORT=18620 HTTPS_PORT=18663 sh scripts/check2-reconcile.sh wt 5m
```

Server lifetime: both server PIDs (38297 WS, 38298 WT) were alive at the end (`kill -0`), the bots ran 300 s with
no errors, and each server log has the bot's join and leave. Conditioner at welcome: 20 ms each way, no jitter or loss.

| Transport | **Corrections** | Server starvations | Pacer raises | Pacer margin at end | RTT median / jitter | Max snapshot gap | Server late ticks > 3 periods (max) | Probe late > 3 periods (max) | Load avg 1 min: first / mean / max / last |
|---|---|---|---|---|---|---|---|---|---|
| WebSocket | **20** | 27 | 19 | 1 tick | 41.33 / 13.54 ms | 582.19 ms | 108 (242.0 ms) | 18 (239.6 ms) | 10.59 / 18.3 / 26.64 / 21.28 |
| WebTransport | **25** | 42 | 21 | 1 tick | 43.07 / 12.07 ms | 598.70 ms | 74 (242.0 ms) | 28 (275.9 ms) | (same host, same time) |

The probe is `bin/bot -kind probe -hz 64`: a separate process with no game code that sleeps on the server's tick
schedule. It stalled as long as the servers did (up to 276 ms), so the stalls come from the host.

Corrections against stalls. Window: ±2 s around a "tick started late" line from either server or a > 3-period
probe event. "Other run" means the independent run (other transport, other server, other bot) also corrected
within 1 s:

| Run | Corrections | Near a late tick of its own server | Near any late event on the host | Other run corrected within 1 s | Neither |
|---|---|---|---|---|---|
| WebSocket | 20 | 7 | 10 | 11 | 6: 18:36:29.6, 18:36:41.7, 18:36:52.3, 18:38:22.9, 18:39:27.4, 18:39:50.2 |
| WebTransport | 25 | 13 | 15 | 10 | 6: 18:36:20.8, 18:36:23.9, 18:40:04.3, 18:40:16.2, 18:40:25.6, 18:41:06.4 |

Correction timestamps (bot wall clock):
- WS: 18:36:29.619, 18:36:41.655, 18:36:52.254, 18:37:10.126, 18:37:10.323, 18:37:33.702, 18:38:13.286,
  18:38:16.621, 18:38:22.858, 18:38:42.552, 18:38:44.906, 18:39:10.209, 18:39:27.405, 18:39:50.202, 18:39:58.312,
  18:39:58.314, 18:39:59.204, 18:40:08.608, 18:40:13.500, 18:40:58.805.
- WT: 18:36:20.825, 18:36:23.943, 18:37:10.077, 18:37:10.160, 18:37:33.632, 18:38:15.872, 18:38:42.133,
  18:38:44.873, 18:39:58.513, 18:40:02.084, 18:40:04.349, 18:40:05.764, 18:40:07.732, 18:40:07.764, 18:40:09.667,
  18:40:09.762, 18:40:10.535, 18:40:10.662, 18:40:10.662, 18:40:13.017, 18:40:16.215, 18:40:19.327, 18:40:22.465,
  18:40:25.574, 18:41:06.378.
- Server late-tick bursts (both servers): 18:37:10, 18:37:20, 18:38:13 (WS only), 18:39:20 (up to 242 ms),
  18:39:57–18:40:10 (repeated, up to 213 ms). Full lists are in the raw `server.log` of each run.

Observations:
1. Corrections that happen within 1 s of each other in two independent processes (18:37:33, 18:38:42, 18:38:44)
   point to a host-wide pause. Neither server logged a late tick then, so it was probably shorter than 3 periods
   (the warning threshold) or it hit the bots rather than the servers.
2. After the 18:39:57–18:40:10 burst, the WT run corrected at 18:40:13.0, 16.2, 19.3, 22.5 and 25.6, about every
   3.1 s, with no late tick logged. The pacer drains to 1 tick after 2 s calm at 1 tick/s (DECISIONS 40); a
   1-tick margin while host jitter is high may starve again and repeat. This is a hypothesis for core, not a
   finding.
3. The whole-window histograms were not captured in these two runs: the harness commit used for them
   (`91b61db`) lacked the capture code. It was fixed in `18bfac9`.

Not run: a quiet host. Raising the server's priority needs root (`nice -n -5` → "Permission denied"), and other
members' processes cannot be stopped.

## C3 server measurements (2026-11-23, core; `go test` on this Mac)

| Check | Command | Result |
|---|---|---|
| P19 allocations per snapshot tick, 20 clients | `go test -run TestLoopModesAllocations -v ./server` | zero-alloc **0.0**, naive **273.0** |
| P19 same bytes in both loops | `go test -run TestLoopModesSameBytes ./server` | PASS (240 packets, multiset equal) |
| P27 sizes, 10 entities, whole snapshot packet | `go test -run TestEntityEncodings -v ./net/codec` | raw 266 B, quantised 186 B, quantised + bit-packed 161 B, delta at rest 67 B, delta moving 127 B |
| P27 delta over WebSocket | `go test -run TestDeltaSnapshotsOverTheWire -v ./server` | 48–49 of 50 snapshots were deltas; 50/50 decoded positions within 1/512 m of server history |
| P29 TCP model, 20/s stream, RTT 40 ms | `go test -run TestOrderedFastRetransmitBeatsRTO ./net/cond` | lost segment delivered at ~210 ms by fast retransmit (RTO path would be 260 ms); the 3 segments behind it waited |
| P26 timing error, click at 1/4 tick, 64 Hz | `go test -run TestSubtickTimingError ./server` | sub-tick on 0 µs; quantised 11 719 µs (3/4 tick) |
| A.11 formula (P15 `est.` column) | `go test -run TestBudgetEstimateMatchesA11 ./server` | 189.6 ms default, ~103 ms at 64/s, ~70 ms at 128 Hz + 144 FPS |

These are unit and wire tests, not live-room measurements. The live P19 run (50 bots, % ticks within budget per
loop) and the P29 inter-arrival histogram belong to "bots" and the client.
