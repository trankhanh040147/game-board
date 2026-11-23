# Blockers

One entry per thing the team could not make work on this machine, with evidence. Numbers are copied from
[MEASUREMENTS.md](MEASUREMENTS.md); the B.9 status table is at its top. Written 2026-11-23 by scribe; last updated at `d982f18`.

## 1. B.9 check 5 — tick health at 128 Hz (≥ 99% of ticks within budget, p99 under budget)

**Status:** not met; every run was on a loaded host.

**Evidence** (50 walker bots standing in for 10 players + 40 bots, 128 Hz, budget 7.81 ms, `statsReset` after 10 s):

| Run | Host load avg | Allocating loop | Zero-alloc loop |
|---|---|---|---|
| Quiet window, 21:39–21:42 ([section](MEASUREMENTS.md#check-5--p19-50-bots-128-hz-statsreset-after-10-s-loaded-again-165--293)) | 16–29 | **99.02%** within, p99 **7.57 ms** | 98.79%, p99 10.44 ms (window holds a 377 ms tick) |
| Rerun at `bfc7213`, 21:49–21:53, recorded in `f718420` ([section](MEASUREMENTS.md#check-5-rerun-both-loops-2026-11-23-21492153-bots-host-not-quiet)) | 24–61 | 95.04%, p99 39.67 ms | 97.14%, p99 23.05 ms |

- In the rerun, **82%** (zero-alloc) and **91%** (allocating) of the seconds with a tick over budget coincide with a
  host stall seen by the server's late-tick log or by a separate 128 Hz probe with no game code. The probe alone paused
  over 3 periods about 185 times per run, up to 180 ms.
- The load came from processes outside the team: the owner's Chrome helpers, a WebKit content process, and a `node`
  process at up to 138% CPU (MEASUREMENTS "Quiet window" host table).
- What is not host load: zero-alloc allocates **70% less** (277 MB vs 918 MB; 24 vs 59 GC cycles).

**Why blocked:** a pass/fail on tick time needs a host whose other processes are idle. This shared laptop never was
during the runs.

**What a human must do:** rerun `scripts/quiet-window.sh` (check 5 step) on an idle machine or a Linux box, both loop
variants, and record the result in MEASUREMENTS.md.

## 2. B.9 check 4 — the fast case (128 Hz + 144 FPS, "near ≈ 71 ms")

**Status:** default case passes; fast case just outside.

**Evidence** ([quiet window, check 4](MEASUREMENTS.md#check-4-2-min-each-frames-modelled-in-the-bot)):
- Default (64 Hz, 20/s, 60 FPS): **195.9 ± 8.8 ms**, +3.1% of the 190 ms est. — pass.
- Fast (128 Hz, 128/s, 144 FPS **modelled**): **81.8 ± 6.0 ms**, +15.2% over ≈ 71 — just outside a ±15% reading.
- Named gap: the **playout buffer**, 15.7 ms measured against about 4 ms in the formula. Load rose from 5 to 16 during
  that run, with 296 late ticks.

**Why blocked:** the frame segments are modelled in the bot at 144 FPS because this display cannot render 144 FPS, so
the browser cannot measure the fast case end to end. The playout-buffer gap is a known pacer trade-off.

**What a human must do:** measure the fast case in a browser on a 144 Hz monitor (P11/P15 panel, F3), on a quiet host.

## 3. B.9 check 8 — human team playtest

**Status:** not run.

**Evidence:** the host checklist, URLs and a notes template per step are ready in [PLAYTEST.md](PLAYTEST.md). LAN joins
were checked only from the host's own LAN IP (HTTPS → WebTransport, HTTP → WebSocket, `?region=hcm`), in headless
Chrome (README, "Build, test and run").

**Why blocked:** it needs 4+ people on the LAN; agents cannot play.

**What a human must do:** run the session in PLAYTEST.md with 4+ people, conditioner at default, one round, then
P02 → P10 → P11–P15, and copy the notes into DEMO.md. This also covers what is still unverified: **a second physical
machine joining and accepting the certificate warning** in a visible browser.

## 4. B.9 check 2 — 0 corrections over 5 minutes

**Status:** not met on this host. The code cause is fixed.

**Evidence** ([section](MEASUREMENTS.md#check-2-after-cores-late-input-grace-18e1e23-decisions-57--2026-11-23-21552203-bots-loaded-host)):
- Quiet window ([section](MEASUREMENTS.md#check-2-5-min-1-bot-per-transport-defaults-load-5384)), load 5.3–8.4: 1
  correction each on WebSocket and WebTransport, about 6 s after join, from the lead-mode pacer's probe-down.
- Core's fix `18e1e23` (DECISIONS 57: hold a late input for one tick instead of repeating it) removed that start-up
  correction: `heldLate` 10 / 9 shows the grace tick absorbing those late inputs.
- Rerun at `1fc9cf5` (load 19–67; the servers logged 238 / 253 late ticks over 3 periods): **2 corrections on WS and 2
  on WT** in 5 minutes. 3 of the 4 coincide with host stalls (WT 21:56:06.4, WS 21:59:46.1, WT 21:59:46.5); **1 is
  unexplained** (WS 21:59:36.3, no logged stall within ±2 s).
- Second half of check 2: with the server-only `speedScale` 0.8, 2397 of 2399 snapshots corrected the prediction, as
  B.9 #2 expects. Smoothing is drawn by the browser (P25 rubber-band).

**Why blocked:** the remaining corrections match repeated inputs during host stalls on a shared, loaded laptop; a
pass/fail needs a quiet host.

**What a human must do:** rerun `scripts/check2-reconcile.sh ws 5m` and `… wt 5m` on an idle machine and record the
result in MEASUREMENTS.md.

## 5. Background processes not owned by the team

**Status:** left untouched on purpose.

| PID | Command | Ports | Working directory | Started |
|---|---|---|---|---|
| 18141 | `bin/server -http 127.0.0.1:18780 -https 127.0.0.1:18743 -dist client/dist` | 18780 / 18743 | `/private/tmp/netlab-bf5cffe` | 20:35 |
| 20847 | `./bin/server -http 127.0.0.1:18080 -https 127.0.0.1:18443 -dist client/dist` | 18080 / 18443 | another checkout, `game-board-netcode-lab-dsh` | 21:13 |

Every member reported these are not theirs (team rule: stop only your own PIDs). They add load to the host and are
listed in MEASUREMENTS "Quiet window". **What a human must do:** stop them if they are not needed.
