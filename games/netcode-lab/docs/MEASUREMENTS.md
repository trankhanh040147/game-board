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
| 7 | Client smoke (Playwright) | not run | No result recorded in this file | — |
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

| Run (start) | Transport | Tick | Inputs | Snapshots | **Corrections** | Server starvations | Pacer raises | RTT median / jitter | Max snapshot gap | Load avg (1 min) before → after |
|---|---|---|---|---|---|---|---|---|---|---|
| 16:58 | WebTransport | 64 Hz | 19201 | 5996 | **15** | 23 | 15 | 40.90 / 0.52 ms | 216.83 ms | not recorded |
| 17:05 | WebSocket | 64 Hz | 19137 | 5983 | **45** | 92 | 55 | 43.79 / 15.62 ms | 525.67 ms | 5.30 → 14.99 |

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

Reading: the typical tick is far under budget (p50 ≈ 0.03 ms for 40 players), but single ticks
take up to 60–68 ms of processing time and tick starts slip by up to 179 ms. On a host with load
average 13–18 on 8 cores this is mostly descheduling, not work; the same machine shows the same
stalls with no clients (check 2 above). These numbers are therefore an upper bound on what the
loop costs and say nothing yet about GC: B.9 #5 needs a run on an idle host, `runtime/metrics` GC
pauses in the stats, and the allocating vs zero-alloc toggle.
