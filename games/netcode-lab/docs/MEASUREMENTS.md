# Measurements

Every number here was produced by a command in this repo, on the machine named.
Machine for all runs below: Apple Silicon Mac (darwin/arm64), Go 1.26.4, Node v26.5.0,
2026-11-23. Server and clients on the same host (localhost); the network is the in-process
conditioner at its default, 20 ms each way.

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
