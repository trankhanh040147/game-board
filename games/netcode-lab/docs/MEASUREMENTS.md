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
| 2 | Reconciliation, 0 corrections over 5 min | **fail (loaded host)** | Latest at `8a760ac`: 14 (WS) and 14 (WT) at load avg mean 27; 24 of 28 within 2 s of a host stall. Earlier 20/25 at `91b61db`. Modifier half: speedScale 0.8 gives 2394 corrections in 120 s. Quiet-window run owed | [latest](#check-2-rerun-at-8a760ac--pacer-probe-floor-7bcc6de-and-lead-pacer-0b4e1af-loaded-host-2026-11-23-20262031-bots), [speed modifier](#check-2-second-half--server-only-speed-modifier-on-2026-11-23-18481850-bots) |
| 3 | Lag compensation (unit + integration) | **pass** | Unit: core's rewind test passes. Integration (DECISIONS 39 bar: ≥ 300 shots, ≥ 97%): lagcomp on 1500/1500 = 100.0%; off 70.0% of 2023 (reported only) | [integration](#check-3-integration--shooter-vs-runner-lagcomp-on-and-off-2026-11-23-18481854-bots) |
| 4 | Shot budget vs 190 ms est. / 71 ms | **partial** | Default within ±15%: bots 211.5 ± 9.7 ms, browser 214.4 / 206.6 / 211.0 ms (loaded host). 128 Hz + 144 FPS (modelled): 90.4 ms vs ≈ 71 (not met); quiet-window repeat owed | [bots](#check-4--p11--p15--measured-shot-budget-vs-a11-2026-11-23-20192023-bots), [browser](#check-4-in-the-browser--first-in-browser-shot-budget-forwarded-from-duel-d3-d8ffe39) |
| 5 | Tick health, 10 players + 40 bots at 128 Hz, both loop variants | **not met / inconclusive** | 40 bots, current loop (load ~15): tick p99 1.52 ms, 99.81% within budget. P19 with 50 bots at load 36–64: zero-alloc p99 22.1 ms, naive 8.4 ms, neither ≥ 99%; host-dominated. Zero-alloc allocates 37% less (1117 vs 1780 MB) but not zero | [at HEAD](#check-5-at-head--40-bots-server-whole-window-histograms-2026-11-23-18551858-bots), [P19](#check-5--p19--zero-alloc-vs-allocating-loop-50-bots-at-128-hz-2026-11-23-20152019-bots-inconclusive-on-timing) |
| 6 | Transport stalls at 5% loss, WS vs datagrams | **partial** | Gaps > 3× send interval per bot in 2 min: WS 106–119, WT 4–5 (expected ≈ 0.3 from loss alone; load avg up to 36, no gap timestamps yet) | [section](#check-6--p29--snapshot-inter-arrival-websocket-vs-webtransport-datagrams-at-5-loss-2026-11-23-bots) |
| 7 | Client smoke (Playwright) | **pass** | v3: 36/0/0 twice at `078053b` (client), 35/0/1 (review V12), real P09/P08 shots; earlier 18/0/1 and 20/0/1 | [v3](#check-7--client-smoke-on-protocol-v3-forwarded-by-lead-from-client-and-review) |
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

**Superseded** by "Duel re-run under the PID/port rule (D3)" below. The rows in this section are kept for the record.

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

## Check 2, second half — server-only speed modifier on (2026-11-23 18:48–18:50, bots)

`speedScale` 0.8 is set through the Lab before the bot joins. The server moves the player at 80% speed and the
client does not know it, so every snapshot should disagree with the prediction. Clean worktree build at `152ea15`.

```
HTTP_PORT=18600 HTTPS_PORT=18643 sh scripts/check2-reconcile.sh ws 2m '{"speedScale":0.8}'
```

| Run | Inputs | Snapshots | **Corrections** | Replayed inputs | Starvations | RTT median / jitter | Server late ticks > 3 periods (max) | Load avg 1 min first / mean / max |
|---|---|---|---|---|---|---|---|---|
| WS, 120 s | 7678 | 2399 | **2394** | 9470 | 5 | 42.14 / 2.34 ms | 12 (120.3 ms) | 16.55 / 17.43 / 19.24 |

Server lifetime: PID 72447 alive at the end, no bot errors, 120 s run. Server whole-window figures for this run:
tick time p50 0.01 ms, p99 0.07 ms, max 135.25 ms, 99.97% within budget. Start lateness p99 7.77 ms, max 120.32 ms,
99.52% within budget, 37 catch-up ticks.

Result: **corrections appear, as B.9 #2 expects**: 2394 of 2399 snapshots corrected the prediction. Whether they
are smoothed is a rendering property of the browser client, so a headless bot cannot measure it. A Go bot also
has no render loop that could smooth anything. Smoothing is to be shown in the client (P25 rubber-band).

Discarded: a first speedScale run at 18:42 crashed its server at 0.1 s with `fatal error: sync: unlock of unlocked
mutex` in `server.(*hist).reset` (server/metrics.go:44), triggered by the harness's `statsReset`. `statsReset` is
now opt-in (`-statsreset`), and the bug is reported to core.

## Check 3 integration — shooter vs runner, lagcomp on and off (2026-11-23 18:48–18:54, bots)

Tolerance fixed in advance by core (DECISIONS 39). Pass with lagcomp on: at least 300 shots and at least 97%
agreement between the shooter's verdict and the server's `hitId`; clamped shots count as disagreements. Lagcomp
off is reported only.

Setup (`bin/bot -kind shootrun`, cmd/bot/shoot.go):
- Two bots, default conditioner (20 ms each way), 64 Hz, 20 snapshots/s, interp 100 ms.
- The shooter (blue) stands at its spawn. The runner (orange) walks to the gap and patrols x −7 → 7 at z −1.5,
  passing behind the 2 m low wall (x −3…3). Its path therefore has open ground, wall edges and full cover.
- Every `ceil(64/10)` = 7 inputs the shooter aims at the runner's rendered body centre and fires. The rendered
  position is interpolated between snapshots at server tick − 100 ms, and that time is sent as `renderTick`/`renderFrac`.
- The shooter's verdict is `sim.RayPlayer` against the rendered position, with `sim.TraceMap` for walls. It is
  compared with the ShotResult `hitId` for the same `shotSeq`.

Both runs ran at the same time on separate servers, from a clean worktree build at `152ea15`:

```
HTTP_PORT=18630 sh scripts/check3-lagcomp.sh on 6m
HTTP_PORT=18640 sh scripts/check3-lagcomp.sh off 6m
```

| lagcomp | Shots compared | Agree | **Agreement** | Shooter saw hit | Server hit | Clamped | Server "moved" p50 / p95 / max | Verdict |
|---|---|---|---|---|---|---|---|---|
| on | 1500 | 1500 | **100.0%** | 276 | 276 | 0 | 0 / 0 / 0 cm | **PASS** (≥ 300 shots, ≥ 97%) |
| off | 2023 | 1416 | **70.0%** | 795 | 188 | 0 | 0 / 106 / 138 cm | reported only |

Context:
- Server lifetime: PIDs 72442 (on) and 72444 (off) were alive at the end, both bots ran 360 s with no errors.
- RTT medians: shooter 41.70 / runner 40.91 ms (on), 40.66 / 40.47 ms (off).
- Server late ticks > 3 periods: 33 (on) and 24 (off).
- Load average 1 min: 16.55 at the start, 15.62 at the end (15-min 20.50 → 18.76).

With lagcomp off, every disagreement goes the same way: the shooter saw a hit and the server missed. The server
says the target had moved about 1.05 m between what the shooter saw and the resolve tick (`movedCm` 105–106 on the
first examples). That is the P08 "three truths" gap: about 10 ticks of render delay plus uplink at roughly 7 m/s.

Limits:
1. The shooter always aims at the body centre, so grazing shots within a few cm of a box edge are rare. The 100%
   says the rewind places the target where the shooter saw it, but it barely tests edge cases. A follow-up could
   add a random aim offset of up to the body half-width.
2. Every shot that rewinds to the render time reports `movedCm` 0 by definition (DECISIONS 38).

Discarded: runs at 18:42 built from the shared working tree, which held core's uncommitted server edits (lagcomp
on: 1273 shots, 100%; off: 1893 shots, 74.7%). They are not counted because their server code is not a commit.

## Check 5 at HEAD — 40 bots, server whole-window histograms (2026-11-23 18:55–18:58, bots)

Still preliminary for B.9 #5: current loop only (the P19 allocating vs zero-alloc toggle is not built yet), 40 bots
and no human players. Clean worktree build at `152ea15`. Each run had a fresh server, 40 walker bots from one
process for 100 s, and a 10 s warmup for the per-second figures. The whole window is the server's own histogram
since start, read from the last 1 Hz stats message; `statsReset` was not used because it crashes the server (see
check 2, second half). It therefore includes the ~2 s ramp-up and the warmup.

```
HTTP_PORT=18610 sh scripts/check5-load.sh 64 40 100s 10s
HTTP_PORT=18610 sh scripts/check5-load.sh 128 40 100s 10s
```

Server lifetime: the script prints the server PID and checks it at the end: 88056 (64 Hz) and 92374 (128 Hz),
both "alive at end"; 0 bots with errors.

| | 64 Hz | 128 Hz |
|---|---|---|
| Budget per tick | 15.625 ms | 7.8125 ms |
| Load avg 1 min, before → after | 14.25 → 15.01 | 14.77 → 16.01 |
| Whole-window tick time: samples | 6400 | 12765 |
| Tick time p50 / p95 / **p99** / p999 / max | 0.04 / 0.9 / **2.16** / 26.48 / 378.67 ms | 0.04 / 0.77 / **1.52** / 12.27 / 71.72 ms |
| Tick time **% within budget** (over budget) | **99.81** (12) | **99.81** (24) |
| Start lateness p50 / p95 / p99 / p999 / max | 0.2 / 1.01 / 21.01 / 382.70 / 382.70 ms | 0.24 / 2.81 / 19.29 / 87.97 / 87.97 ms |
| Start lateness % within budget (over budget) | 98.88 (72) | 97.38 (335) |
| Catch-up ticks / schedule resets | 72 / 0 | 335 / 0 |
| GC: cycles, pause p50 / p99 / max | 64, 0.049 / 3.67 / 12.58 ms | 92, 0.049 / 2.62 / 41.94 ms |
| Heap, total allocated, goroutines | 15.3 MB, 609 MB, 140 | 25.1 MB, 909 MB, 140 |
| Per-second view after warmup: tick-weighted % within budget | 99.79 (5632 ticks) | 99.79 (11264 ticks) |
| Bot corrections, all 40 bots / worst bot's starvations | 95 / 7 | 822 / 41 |
| Bot RTT median (median over bots) | 40.39 ms | 40.32 ms |

Reading against B.9 #5 ("p99 tick time under budget and ≥ 99% of ticks within budget"):
- **Tick processing time** meets both at 128 Hz with the current loop: p99 1.52 ms < 7.81 ms, 99.81% within budget.
- **Tick start lateness** does not. It is 97.38% within budget at 128 Hz, with p99 19.29 ms. The no-game-code
  probe sees the same lateness on this host (check 2 at HEAD), so this is host scheduling.
- **Not yet:** both loop variants (P19 toggle), 10 human players, an idle host, and `statsReset` to drop the ramp-up.

GC allocates about 6 MB/s at 64 Hz and 9 MB/s at 128 Hz for 40 players (609 MB and 909 MB over ~100 s). The
41.9 ms GC pause max at 128 Hz is larger than one tick budget.

## Check 6 / P29 — snapshot inter-arrival, WebSocket vs WebTransport datagrams at 5% loss (2026-11-23, bots)

Bots on protocol v3 (`9079108`: decode with baselines, ack `snapId`). Clean worktree build at `84c8dd4`. The
conditioner for every player was set by an admin client (`-cond`, `all:true`) to 20 ms each way and 5% loss each
way. Send rate 20/s, so the interval is 50 ms and a stall means a gap over 150 ms. Three walker bots per transport,
2 minutes, a fresh server for each transport (the WT server also serves WS on its HTTP port).

```
HTTP_PORT=18650 HTTPS_PORT=18651 sh scripts/p29-transport.sh 2m 5 3
```

Server lifetime: both servers were alive at the end (`kill -0`), and no bot reported errors.

| Transport | Bot | Snapshots | Inter-arrival p50 / p95 / p99 / max (ms) | **Gaps > 3× interval** | Histogram (multiples of 50 ms) |
|---|---|---|---|---|---|
| WebSocket | 1 | 2400 | 46.97 / 83.25 / 242.09 / 269.27 | **106** | 0–1×: 1808, 1–2×: 479, 2–3×: 6, 3–4×: 65, 4–5×: 39, 5–6×: 2 |
| WebSocket | 2 | 2399 | 46.95 / 99.55 / 229.08 / 247.18 | **112** | 0–1×: 1814, 1–2×: 465, 2–3×: 7, 3–4×: 63, 4–5×: 49 |
| WebSocket | 3 | 2398 | 46.94 / 145.32 / 240.77 / 252.70 | **119** | 0–1×: 1807, 1–2×: 458, 2–3×: 13, 3–4×: 64, 4–5×: 54, 5–6×: 1 |
| WebTransport | 1 | 2266 | 47.16 / 93.33 / 109.55 / 225.95 | **4** | 0–1×: 1542, 1–2×: 668, 2–3×: 51, 3–4×: 3, 4–5×: 1 |
| WebTransport | 2 | 2287 | 47.15 / 86.63 / 110.42 / 294.54 | **4** | 0–1×: 1581, 1–2×: 638, 2–3×: 63, 3–4×: 3, 5–6×: 1 |
| WebTransport | 3 | 2286 | 47.14 / 88.68 / 110.20 / 206.97 | **5** | 0–1×: 1577, 1–2×: 647, 2–3×: 56, 3–4×: 4, 4–5×: 1 |

Host load average (1/5/15 min), start / end: WS 29.96 20.42 11.71 / 21.49 20.52 12.89; WT 20.65 20.36 12.88 / 35.76
24.78 15.51.

Reading:
- **WebSocket:** no snapshot is lost (2398–2400 in 120 s). Instead, about 4.6% of gaps are over 3× the interval,
  in a cluster at 150–270 ms: the simulated TCP retransmit stall blocks every later snapshot (DECISIONS 8).
- **WebTransport:** about 5.4% of snapshots are lost (2266–2287 received), so the gaps sit at 1–2× and 2–3×. That is
  one or two drops in a row with no stall behind them.
- **Not met in the strict sense:** WT still shows 4–5 gaps over 3× per bot. Five percent loss gives three drops in
  a row with p ≈ 1.25·10⁻⁴, so only about 0.3 such gaps are expected per bot in 2 minutes. The load average reached
  35.8 during the WT run, so these are probably host pauses, but this run kept no gap timestamps that would prove it.
- **Status:** B.9 #6 is **partial**. The WS-vs-datagram contrast is clear (106–119 vs 4–5 stalls per bot), but
  "datagram mode does not stall" is not shown on this host.

## P14 — peeker's advantage, our measurement (2026-11-23 20:12–20:14, bots)

Protocol: research R3 item 2. Clean worktree build at `453daf7`. Code in cmd/bot/peek.go.
- **Holder (blue):** stands still at its spawn and does not shoot.
- **Peeker (orange):** hides behind the 2 m low wall at (−1, −2). It moves out to (5, −2), past the wall's east
  edge, holds 0.5 s, comes back and waits 1.5 s. This repeats for 20 crossings.
- **Visibility:** line of sight from one player's eye to the other's eye height, tested against the map boxes
  (`sim.TraceMap`).
- **Times:** all three are in server ms.
  - `t_expose` = the server time of the tick that processed the first peeker input whose resulting position is
    visible from the holder. The tick comes from the snapshot's `lastProcessedInputSeq` (one input per tick), and
    the time from its `serverTimeMs`.
  - `t_peekerSees` = the first 60 FPS frame of the peeker client in which its own predicted position sees the
    holder. Frame times are mapped to server ms with the peeker's clock sync.
  - `t_holderSees` = the first 60 FPS frame of the holder client in which the interpolated peeker is visible.
    Interpolation uses the client's arrival-clock model: render server time = local now + max(serverMs − recvMs over
    2 s) − 100 ms buffer.
- **Advantage** = `t_holderSees − t_peekerSees`.
- **Deviations from R3:**
  - The crossing id is a counter shared by the two bots in one process; the server has no crossing id.
  - Frames are modelled at 60 FPS with ±2 ms loop granularity; there is no renderer.

```
HTTP_PORT=18660 sh scripts/p14-peek.sh default 20
HTTP_PORT=18670 sh scripts/p14-peek.sh bad 20      # Bad route: 40 ms each way, jitter 15 ms, loss 1% (client Lab profile)
```

| Profile | Crossings started / complete | **Advantage, mean ± sd (min–max)** | t_peekerSees − t_expose | t_holderSees − t_expose | RTT median (holder / peeker) | Corrections (holder / peeker) |
|---|---|---|---|---|---|---|
| Default (40 ms RTT) | 20 / 20 | **160.83 ± 9.67 ms** (149.91–183.07) | −42.73 ± 8.23 ms | 118.09 ± 5.02 ms | 40.86 / 41.95 ms | 0 / 9 |
| Bad route (≈ 88 ms RTT measured) | 20 / 20 | **186.01 ± 16.51 ms** (146.94–216.69) | −58.14 ± 11.86 ms | 127.86 ± 9.50 ms | 87.86 / 88.68 ms | 0 / 69 |

Label: **our measurement**. Riot's figures (A.11: about 141 → 101 → 71 ms) are a `ref` only and a different
measurement.

Context:
- Both runs ran at the same time on separate servers.
- Host load average went from 31.66 to 39.43 (1 min). Server late ticks over 3 periods: 27 (default) and 25 (bad).
- Server lifetime: PIDs 48964 and 48961 were alive at the end, and no bot reported errors.

Reading:
- **Holder side:** about 118 ms after exposure, which is close to the R3 estimate of downlink 20 + buffer 100.
- **Peeker side:** it sees the holder about 43 ms **before** the server has it exposed. Its prediction runs ahead
  of the server by about RTT/2 plus the pacer margin.
- **Total:** the advantage is therefore about 120 + 40 ms. Under Bad route the holder side grows less than the
  extra 20 ms of delay, because the arrival-clock model keys on the least-delayed snapshot, and jitter widens the spread.
- **Caveat:** peeker corrections (9 and 69) mean some exposures may be off by the correction size.

## Pacer margin, before/after DECISIONS 51 (2026-11-23, core) — quiet run still owed

Command: `bin/server -http 127.0.0.1:<port> -https ""`, then
`node wasm/test/client-loop.mjs client/public/sim.wasm client/public/wasm_exec.js ws://127.0.0.1:<port>/ws 60 60`
(60 s, the input loop runs once per 16.7 ms "frame" like a rAF browser; prints margin and min lead every 5 s).
`PACER_LEGACY=1` selects the old starvation-only feedback.

| Run | Host load avg | Margin over 60 s (5 s samples) | Corrections | Min lead seen |
|---|---|---|---|---|
| before (9079108) | 36 | 4,4,4,5,5,6,6,6,6,6,6 | 23 | not reported then |
| after (0b4e1af), lead mode | 26 → 47 | 4,5,3,4,5,5,6,6,5,5,6 | 22 | −6 |
| A/B at the same time, after: legacy feedback | 44 | 1,1,1,2,4,4,4,5,5,5,6,5 | 21 | −13 |
| A/B at the same time, after: lead mode | 44 | 1,2,2,3,5,4,4,6,5,4,6 | 13 | −12 |

On this host, inputs arrived up to 13 ticks (~200 ms) after their stamp. That comes from stalls of the Node
client and the server under load, and no margin rule can absorb it. These runs therefore do not show the
clean-link behaviour; the unit tests do (`go test -run 'TestPacerLead' -v ./net/clock`): margin 6 → lead 1 in
12 s with 0 starvations, and settling at lead 3 when the host needs 3 ticks. **Owed**: the same 60 s command on
a host with load average < 5, before and after.

## Check 5 / P19 — zero-alloc vs allocating loop, 50 bots at 128 Hz (2026-11-23 20:15–20:19, bots): inconclusive on timing

Clean worktree build at `aa29916`. Each run had a fresh server set to 128 Hz and the loop variant through the Lab
(`{"loop":"zeroalloc"}` / `{"loop":"naive"}`). Then 50 walker bots from one process for 100 s; `statsReset` after
a 10 s warmup, so the whole window covers about the last 88 s. There are no human players; B.9 #5 asks for 10 players
+ 40 bots, and 50 bots stand in for them.

```
HTTP_PORT=18610 sh scripts/check5-load.sh 128 50 100s 10s zeroalloc
HTTP_PORT=18610 sh scripts/check5-load.sh 128 50 100s 10s naive
```

Server lifetime: PIDs 57361 (zero-alloc) and 63522 (naive) were alive at the end; 0 bots with errors.

| | zero-alloc | allocating ("naive") |
|---|---|---|
| **Load avg 1 min, before → after** | **41.81 → 64.10** | **59.04 → 36.28** |
| Tick time p50 / p95 / **p99** / p999 / max | 0.06 / 4.18 / **22.11** / 282.59 / 282.59 ms | 0.06 / 1.75 / **8.42** / 35.24 / 94.41 ms |
| Tick time % within 7.81 ms budget (over) | 96.97 (336) | 98.94 (116) |
| Start lateness p50 / p95 / p99 / max | 0.54 / 529.98 / 529.98 / 529.98 ms | 0.1 / 6.61 / 37.36 / 177.12 ms |
| Start lateness % within budget; catch-up ticks | 82.79; 2104 | 95.58; 691 |
| GC cycles; pause p50 / p99 / max | 79; 0.13 / 117.4 / 134.2 ms | 125; 0.066 / 25.2 / 117.4 ms |
| **Total allocated by the server (whole run)** | **1117 MB** | **1780 MB** |
| Heap at end; goroutines | 40.5 MB; 170 | 27.4 MB; 170 |
| Bot corrections (all 50) / worst starvations / RTT median | 1404 / 74 / 64.61 ms | 717 / 49 / 41.04 ms |

Reading:
- **Timing: no verdict.** The zero-alloc run looks worse, but it ran while the host load average climbed to 64 on
  8 cores, with one 530 ms stall and a bot RTT median of 64.6 ms against the 40 ms conditioner. The naive run
  started at load 59 and ended at 36. Neither run meets B.9 #5 (p99 under budget and ≥ 99% within). These numbers
  measure the host, not the loop. A real comparison needs a quiet host and the two runs back to back.
- **Allocation: a real difference, independent of load.** Zero-alloc allocated 37% less (1117 vs 1780 MB, 79 vs
  125 GC cycles). It is still far from zero: about 11 MB/s for 50 players at 128 Hz. This is reported to core.

### Second pair, 20:21–20:23, old and new builds side by side (still a loaded host)

Old = server and `sim.wasm` built at 9079108 (sequential play, starvation-only pacer). New = 0b4e1af (scheduled
play, lead pacer). Same 60 s frame-paced Node client, separate servers and ports, run one minute apart.

| Build | Load avg | Margin every 5 s | Min lead per 5 s | Starvations | Corrections | Raises |
|---|---|---|---|---|---|---|
| old | 29–33 | 2,4,4,4,4,5,5,5,6,6,6 | −2,3,3,2,4,4,5,5,4,5,6 | 28 | 16 | 14 |
| new | 23–26 | 1,1,1,2,2,3,2,3,3,3,3 | 0,−4,−6,−8,−4,−1,1,−2,1,0,3 | 16 | 7 | 4 |

The old build shows the root cause directly: inputs arrived 3–6 ticks early, yet the server kept starving and the
margin kept rising. The server drained the buffer, so being early bought nothing. The new build stops at 3. Its
negative leads are inputs that really arrived late (host stalls, load > 20), and those are counted as starvations.
This is still not the quiet-host run (load < 5), which remains owed.

## Check 4 / P11 / P15 — measured shot budget vs A.11 (2026-11-23 20:19–20:23, bots)

The shooter/runner bots (`-kind shootrun -fps F -buf B`, cmd/bot/budget.go). Only hits count, because the target
needs a Damage event. Each segment is a difference of two times mapped to server ms:
- **Shooter side:** the click is uniform within the frame that sampled it, then the frame and the fire input's
  send time; these use the shooter's clock sync.
- **Server side:** `ShotResult.recvMs` and `tickStartMs`.
- **Target side:** `serverTimeMs` of the first target snapshot carrying the Damage event, and the target's arrival
  time.
- **Interpolation and target frame:** render time is the client's arrival-clock model (arrival + buffer), then the
  next frame.

Frames are **modelled** in the bot: there is no display. 144 FPS was not reached on a real display (research: this
laptop's display runs 60/120 Hz), so the "fast" row is a model of 144 FPS frame waits.

```
HTTP_PORT=18690 sh scripts/check4-budget.sh default 2m   # build 7917547
HTTP_PORT=18690 sh scripts/check4-budget.sh fast 2m      # build 7397f20 (first attempt failed: server not listening after 1 s at load 33; the script now waits for /api/info)
```

| Segment (mean ms; sd) | A.11 est. default | **Measured default** (64 Hz, 20/s, 60 FPS, buffer 100) | A.11 est. 128 Hz + 144 FPS | **Measured fast** (128 Hz, 128/s, 144 FPS modelled, buffer 15.6) |
|---|---|---|---|---|
| Shooter frame wait | 8 | 7.76; 4.62 | ≈ 3.5 | 3.25; 1.88 |
| Frame → input sent (pacer) | (not in A.11) | 8.68; 4.86 | (not in A.11) | 3.45; 2.05 |
| Uplink | 20 | 20.76; 2.55 | 20 | 21.06; 2.23 |
| Wait for server tick | 8 | **45.69; 5.99** | ≈ 4 | **23.43; 5.12** |
| Wait for snapshot send | 25 | 18.06; 15.11 | ≈ 4 | 0.06; 0.31 |
| Downlink | 20 | 21.18; 1.81 | 20 | 21.01; 1.61 |
| Target interpolation | 100 | 81.10; 15.53 | ≈ 16 | 14.65; 1.79 |
| Target frame wait | 8 | 8.30; 4.80 | ≈ 3.5 | 3.48; 2.08 |
| **Total** | **≈ 190** | **211.53; 9.71** (p50 210.03, p95 230.27) | **≈ 71** | **90.39; 6.22** (p50 89.32, p95 100.06) |
| Shots measured | | 109 | | 112 |

Context:
- Server lifetime: PIDs 68352 (default) and 74836 (fast) were alive at the end; no bot errors.
- RTT medians were 41.6–44.7 ms.
- Host load average: default 29.72 → 33.05, fast 28.79 → 25.89.
- Server late ticks over 3 periods: 41 (default) and 100 (fast).

Verdict against B.9 #4:
- **Default: pass.** 211.5 ms is +11.3% over the 190 ms estimate, inside the ±15% bar.
- **128 Hz + 144 FPS: not "near 71".** 90.4 ms is +27%.

Where the difference comes from:
1. **"Wait for server tick" is the largest gap: 46 ms against 8, and 23 ms against 4.** The pacer sends each input
   early, by RTT/2 plus a margin (DECISIONS 15, 40, 51), so it waits in the server's playout buffer until its tick.
   A.11 assumes the input arrives at a random point in the tick. Our design trades this wait for fewer
   starvations: its cost is about 38 ms at 64 Hz and 19 ms at 128 Hz.
2. **"Frame → input sent"** (about 9 ms at 60 FPS and 3.5 ms at 144) is a segment A.11 does not have. The client
   sends inputs on the tick schedule, not every frame.
3. **Interpolation and snapshot wait.**
   - Interpolation is shorter than the buffer (81 against 100 ms) because the arrival-clock model counts from
     arrival, and the snapshot already carries about 20 ms of downlink.
   - At 128/s the snapshot goes out in the same tick (0.06 ms).
   - At 20/s the snapshot wait averages 18 ms, not 25. Shots fire every 7 ticks while snapshots go every 3–4 ticks,
     so not every phase is sampled.

## Check 7 — client smoke on protocol v3 (forwarded by lead from client and review)

| Client commit | Server | Result | Run by |
|---|---|---|---|
| `078053b` (v3) | built from `9be4b0e` | **36 passed, 0 failed, 0 skipped**, run twice | client |
| HEAD at the time | review's own server | **35 passed, 0 failed, 1 skipped** | review V12, independently |

The client run applied 16 enabled presets. It included a real P09 hit confirm, the P08 miss reason, and a P27 delta
check (28 delta snapshots with `compDelta` on). Client `npm test`: 18/18. The smoke checks that presets P12, P13,
P19, P27 and P28 apply and broadcast; their measured effects are in "Preset effects" below. Status: **pass** (the
shooting step is now exercised). Verbatim output is with the client member.

## Check 4 in the browser — first in-browser shot budget (forwarded from duel D3, `d8ffe39`)

Two headless Chromium pages at 60.5 fps, `smoke/perf.mjs`, duel's own server on :18760, defaults (64 Hz, 20/s,
40 ms conditioner). 12 real hits, all 12 traced with the target half. **Loaded host.**

| Segment | est. | measured (ms) |
|---|---|---|
| Shooter frame | 8.3 | 10.4 |
| Uplink | 20.0 | 25.4 |
| Server tick wait | 7.8 | 48.6 (the server holds about 2 inputs; the half-tick formula ignores this) |
| Snapshot wait | 25.0 | 22.5 |
| Downlink | 20.0 | 21.3 |
| Target interp | 100.0 | 77.0 |
| Target frame | 8.3 | 9.3 |
| **Total** | **189.5** | **214.4** (+13%) |

Two earlier runs gave 206.6 and 211.0 ms. Status: **check 4 default: within tolerance (3 runs, loaded host)**.
This agrees with the bots' 211.5 ms above. The quiet-window repeat and the 128 Hz + 144 FPS case are still owed;
144 FPS cannot be honestly reached on this 60/120 Hz display.

## Duel re-run under the PID/port rule (D3, forwarded from duel)

The relay's PID stayed alive for all 48 runs; 0 desyncs. WebTransport. Raw data: `bin/duel-measure-v2.jsonl`.
Caveat: the run overlapped M7 builds, so the Bad route D=1 row may be perturbed.

| Profile | Mode | Result |
|---|---|---|
| Default | rollback D=0/1/2/3 | 8.8 / 9.3 / 9.3 / 0.8 rollbacks/s; 28.6 / 19.8 / 9.4 / 0.8 frames rolled back/s |
| Default | lockstep auto D=4 | 0.67 stall frames/s |
| Default | lockstep D=2 | 15.3 stall frames/s at 44.8 fps |
| Bad route | rollback D=0–3 | 7.5 rollbacks/s each; 43.7 / 35.9 / 27.1 / 19.4 frames rolled back/s |
| Bad route | lockstep auto D=6 | 5.1 stall frames/s at 54.8 fps |
| Bad route | lockstep D=2 | 33.8 stall frames/s at 26.1 fps |
| Bad route, WebSocket | all modes | 13–22 stall frames/s at 38–46 fps |


## Check 2 rerun at 8a760ac — pacer probe floor (7bcc6de) and lead pacer (0b4e1af), loaded host (2026-11-23 20:26–20:31, bots)

**Result: check 2 still fails on this host: 14 corrections (WS) and 14 (WT) in 5 minutes. Loaded host:** load
average 18.0–36.9, mean 27.3. Clean worktree build at `8a760ac`. The bots use `OnServerLead` (DECISIONS 51). Both
runs ran at the same time, each with its own server.

```
HTTP_PORT=18600 HTTPS_PORT=18643 sh scripts/check2-reconcile.sh ws 5m
HTTP_PORT=18620 HTTPS_PORT=18663 sh scripts/check2-reconcile.sh wt 5m
```

| Transport | **Corrections** | Starvations | Pacer raises | **Pacer margin at end** | RTT / jitter | Server late ticks > 3 periods (max) | Server start lateness p99 / within budget | Probe late > 3 periods (max) | Load avg 1 min first / mean / max / last |
|---|---|---|---|---|---|---|---|---|---|
| WS | **14** | 18 | 10 | 2 ticks | 42.55 / 6.89 ms | 107 (493.5 ms) | 27.56 ms / 98.23% | 35 (294.8 ms) | 25.61 / 27.34 / 36.87 / 36.87 |
| WT | **14** | 19 | 11 | 1 tick | 44.69 / 5.93 ms | 107 (440.1 ms) | 26.66 ms / 98.32% | 30 (294.4 ms) | (same host, same time) |

Server lifetime: PIDs 90655 (WS) and 90616 (WT) were alive at the end; the bots ran 300 s with no errors.
Server tick processing stayed small: p99 0.24 / 0.25 ms, 99.96% / 99.98% within budget.

Corrections against host stalls: a correction counts as matched when it falls within 2 s of a "tick started late"
line from either server or a > 3-period probe event. WS: 13 of 14 matched (unmatched: 20:26:32.660). WT: 11 of 14
matched (unmatched: 20:28:09.026, 20:29:34.117, 20:30:41.272). The worst stall was a 362–494 ms pause of both servers
at 20:27:45. The no-game-code probe also saw pauses up to 295 ms.

Compared with the run at `91b61db` (20 / 25 corrections at a mean load of 18), corrections fell and the 3.1 s
repeat pattern after a burst is gone. The load was higher this time, so the two runs are not a controlled
comparison. A pass or fail on a quiet host is still owed: `sh scripts/quiet-window.sh` runs it.

## P19 receive-path allocations (2026-11-23, core; host load 30–36)

`bin/server -pprof -infra=false`, 20 walker bots for 25 s, allocation profile diffed between t=8 s and t=20 s:

| Build | Bytes allocated in 12 s | Main sources |
|---|---|---|
| 0bbe723 | 29.6 MB | WebSocket `io.ReadAll` 9.2 MB + per-read timeout contexts ~5 MB, ordered FIFO 4.6 MB, baselines 2 MB, stats JSON 3.6 MB, input decode 1.5 MB |
| after DECISIONS 53 | 7.2 MB | pprof's own gzip 2.2 MB, stats JSON 1.5 MB, baseline/pool warm-up 2 MB, timers 0.5 MB |

Allocation volume is a byte count, so it does not depend on host load. The GC-pause and tick-time comparison
(bots' check 5) still needs the quiet window.
