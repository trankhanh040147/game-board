# Netcode Lab

Netcode Lab is a browser team shooter for 2–10 players on a LAN, with one hitscan rifle and an original map, the
Courtyard, plus a small 2D duel mode for rollback and lockstep. Each latency technique (prediction, reconciliation,
interpolation, lag compensation and the rest) is a live Lab toggle a presenter can switch during play; the ideas are
in [docs/CONCEPTS.md](docs/CONCEPTS.md) and the presenter script is in [docs/DEMO.md](docs/DEMO.md).

> **At `aa01c11` browsers cannot join the shooter.** Since `8819ee7` the server and `sim.wasm` speak protocol/API v3,
> but the browser client still expects API v2. The start card shows "sim.wasm apiVersion 3, client expects 2" and
> falls back to the offline spectator camera. See [Known gaps](#known-gaps).

## Prerequisites

- Go 1.26 (verified with go1.26.4 darwin/arm64).
- Node with npm (verified with Node v26.5.0, npm 11.17.0). Client tests use `node --test` with native TS type
  stripping, so Node ≥ 23 is needed.
- A Chromium-based browser or Firefox (WebTransport with `serverCertificateHashes`).
- Optional: Docker with Compose, for `deploy/` (see below).

## Build, test and run

Run every command from `games/netcode-lab`. Each command marked OK was run by scribe on 2026-11-23 from a clean
worktree at `aa01c11` and exited 0. Long-running servers were started on scribe's test ports (185xx), not the demo
ports, and stopped by PID.

**On a fresh clone, run `make client` before starting the server.** `client/dist` is git-ignored and the server
serves the page from it.

| Command | What it does | Result at aa01c11 |
|---|---|---|
| `make` (= `make all`) | `client/public/sim.wasm` + `wasm_exec.js`, `bin/server`, `bin/bot` | OK |
| `make client` | `npm install` + Vite build into `client/dist` (also builds the WASM) | OK (Vite warns that one chunk is > 500 kB) |
| `make test` | `go test ./...` | OK: net/clock, net/codec, net/cond, server, server/matchmaker, sim, sim/duel |
| `cd client && npm test` | Client unit tests | OK: 12 pass, 0 fail |
| `make determinism` | B.9 check 1: shooter sim native arm64 vs amd64 (Rosetta) vs WASM, then `make duel-determinism` | OK: shooter `de0b4ee5068db4c9` and duel `a49b4b920738736c` on all three targets |
| `make duel-determinism` | Duel sim and its rollback/lockstep sessions, native vs amd64 vs WASM | OK (runs inside `make determinism`) |
| `make duel` | Duel page into `bin/duel-www`, `bin/duelrelay`, `bin/duelbot` | OK |
| `make infra` | `bin/infra` (regions, beacons, matchmaker, `/metrics`), `bin/beaconbot`, `bin/matchmaker`, `bin/relay` | OK |
| `make run` | Builds server + client, then `bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443` | Not run at aa01c11 (8080/8443 are reserved for the demo). Same binary checked with `bin/server -http 127.0.0.1:18502 -https 127.0.0.1:18545`: page served, bots joined |
| `bin/bot -url ws://127.0.0.1:<http>/ws -n 2 -d 4s` | Walker bots over WebSocket | OK: 2 bots reported stats |
| `bin/bot -url https://127.0.0.1:<https>/wt -info http://127.0.0.1:<http> -n 1 -d 4s` | Walker bot over WebTransport | OK |
| `NETLAB_ADMIN_TOKEN=<token> node smoke/smoke.mjs http://127.0.0.1:<http>` (in `client/`) | B.9 check 7 browser smoke | **FAIL** at aa01c11 (1 passed, 1 failed: API v2/v3 mismatch). At `e7d4272`: 34 passed, 0 failed, 0 skipped |
| `bin/duelrelay -http … -https …` (`make duel-run` uses :8090 / :8453) | Duel relay + page | OK: `/` redirects to `/duel.html`, HTTP 200 |
| `bin/infra -http … -https … -www bin/duel-www` (`make infra-run` uses :18720 / :18721) | Regions page and metrics | OK: `/infra.html` and `/metrics` HTTP 200 |
| `cd deploy && docker compose config -q` | Validates the Compose file | OK. `docker compose up` (game, infra, Prometheus, Grafana) was **not run** by scribe |

Not run: `make dev` (Vite in the foreground; its proxy targets `http://localhost:8080` unless `NETLAB_SERVER` is set),
`make bots` (its URL is fixed to `ws://127.0.0.1:8080/ws`), `make duel-run` and `make infra-run` with their default
ports. Measurement scripts are in `scripts/` (check 2, check 3, check 5, duel); their runs and outputs are in
[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

Server flags (`bin/server`, [cmd/server/main.go](cmd/server/main.go)):

| Flag | Default | Meaning |
|---|---|---|
| `-http` | `0.0.0.0:8080` | Plain HTTP: page + WebSocket (`/ws`) |
| `-https` | `0.0.0.0:8443` | HTTPS (TCP) + WebTransport (UDP, `/wt`) on one port number; empty disables |
| `-dist` | `client/dist` | Built client directory |
| `-v` | `false` | Debug logging |

Make variables: `HTTP`, `HTTPS` (listen addresses for `run` and `dev`), `N`, `D` (bots).

## Join from another machine on the LAN

At start the server mints a self-signed ECDSA P-256 certificate valid 10 days, with the host's IPs as SANs, and logs
them. The host checklist for the team playtest is [docs/PLAYTEST.md](docs/PLAYTEST.md).

1. Host IP (macOS): `ipconfig getifaddr en0`.
2. **WebTransport:** open `https://<host-ip>:8443` and accept one certificate warning.
3. **WebSocket fallback:** open `http://<host-ip>:8080`.
4. Firewall: allow TCP 8080 and TCP + UDP 8443.

Checked at `e7d4272` from the LAN IP on scribe's ports: the HTTPS page joined over WebTransport and the HTTP page
over WebSocket with the fallback banner (details in PLAYTEST.md). At `aa01c11` the join fails (see the note at the top).

## Admin token (Lab panel)

Set `NETLAB_ADMIN_TOKEN` before starting the server (`NETLAB_ADMIN_TOKEN=secret make run`), or copy the generated
`adminToken=` from the server log. The presenter opens the page with `?admin=<token>` or types it into the Lab (F1).
F2 opens the presenter view; `?spectate=1` joins without a player.

## Repository layout

Committed tree at `aa01c11`:

| Path | Contents |
|---|---|
| `Makefile` | Build, run, test, determinism, duel and infra targets |
| `go.mod`, `go.sum` | Go module `netcodelab` |
| `cmd/server` | Shooter game server |
| `cmd/bot` | Walker and shootrun bots, load harness (`-tick`, `-stats`, `-warmup`) |
| `cmd/simtrace`, `cmd/dueltrace` | Trace generators for the determinism checks |
| `cmd/duelrelay`, `cmd/duelbot` | Duel relay (WS + WebTransport) and headless duel peer |
| `cmd/infra`, `cmd/beaconbot`, `cmd/matchmaker`, `cmd/relay` | M7 regions, beacons, matchmaker, UDP relay |
| `server/` | Room, tick loop, combat and lag compensation, settings and presets, cost meters, metrics; `duelrelay/`, `matchmaker/`, `regions/`, `promx/` |
| `sim/` | Fixed-point movement, collision, hitboxes, rays, predictor; `sim/duel` is the integer duel sim |
| `net/` | `clock`, `codec`, `cond` (conditioner), `transport` |
| `wasm/` | Browser WASM entry points (`main.go`, `duel/`) and determinism/dev scripts in `test/` |
| `shared/` | `map.json` (Courtyard), embedded into native and WASM builds |
| `client/` | Vite + TypeScript + three.js client: `index.html` (game), `duel.html`, `infra.html`, `concepts.html`; `src/`, `test/`, `smoke/`, `public/` (CC0 assets) |
| `scripts/` | `check2-reconcile.sh`, `check2-summary.py`, `check3-lagcomp.sh`, `check5-load.sh`, `duel-measure.sh`, `netem.sh` (Linux only) |
| `deploy/` | `Dockerfile`, `docker-compose.yml` (game, infra, Prometheus, Grafana), `prometheus/`, `grafana/` |
| `docs/` | HANDOFF, CONCEPTS, DECISIONS, ARCHITECTURE, PROTOCOL, DEMO, PLAYTEST, MEASUREMENTS, STATUS, ASSETS, AUDIT-A16, `presets.json` |

Build outputs (`bin/`, `client/dist`, `client/public/*.wasm`, `wasm_exec.js`) are git-ignored.

## Status

The board, open risks and lead decisions are in [docs/STATUS.md](docs/STATUS.md). B.9 check results are at the top
of [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

## Known gaps

- **Client API v2 vs server API v3 (since `8819ee7`).** Browsers cannot join the shooter at `aa01c11`; the smoke test
  fails. It passed at `e7d4272` (34/0/0).
- **No team playtest yet** (B.9 check 8). The checklist is ready in docs/PLAYTEST.md.
- **No second machine tested.** The LAN-IP join was checked on the host itself.
- **`docker compose up` not run by scribe.** Only `docker compose config -q` was checked.
- **Fixed ports in some targets:** `make bots` uses `ws://127.0.0.1:8080/ws`; the Vite dev proxy defaults to
  `localhost:8080`; `make duel-run` and `make infra-run` use their built-in defaults. Run the binaries with flags to
  use other ports.
