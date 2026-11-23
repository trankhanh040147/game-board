# Netcode Lab

Netcode Lab is a browser team shooter for 2–10 players on a LAN, with one hitscan rifle and an original map, the
Courtyard, plus a small 2D duel mode (rollback, input delay, lockstep) and a regions page (simulated ISPs, beacons,
matchmaking, cable cut). Each latency technique is a live Lab toggle a presenter can switch during play; the ideas
are in [docs/CONCEPTS.md](docs/CONCEPTS.md) and the presenter script is in [docs/DEMO.md](docs/DEMO.md).

## Play in 2 minutes

Ask the host for their IP, then:

1. Open **`https://<host-ip>:8443`** in Chrome, Edge or Firefox.
2. Accept the **one** certificate warning (the server makes a self-signed certificate at start). The start card
   should say "✓ Game server connected over WebTransport".
3. Click **Play**.

| Key | Action |
|---|---|
| W A S D | move |
| Space | jump |
| mouse | look (if the browser refuses pointer lock, drag to look) |
| left click | fire |
| Tab (hold) | scoreboard |
| Esc | release the mouse |
| F1 | Lab panel (presets need the presenter's admin token) |
| F2 | presenter view (top-down "three truths") |
| F3 | budget / cost / tick health / arrival panel (P11, P12, P15, P19, P29) |
| F4 | wire and timing panel (P26, P27, P28) |

- **Fallback:** if the HTTPS page fails, open `http://<host-ip>:8080`. It plays over WebSocket and shows a banner.
- **Region:** add `?region=hcm`, `?region=hn` or `?region=sg` to join that region's room over a simulated route
  (optional `&isp=viettel|vnpt|fpt`). The start card then says "region room hcm (simulated route)".
- **Few players?** The host adds bots: Lab (F1, admin token) → **Fill teams (3v3)**, or starts the server with
  `-fill -1`. Bot names end in `[bot]`.
- **Other pages** on the same server: `/duel.html` (duel mini-mode), `/infra.html` (regions, beacons, matchmaker),
  `/concepts.html` (Part A).

## Prerequisites (host)

- Go 1.26 (verified with go1.26.4 darwin/arm64).
- Node with npm (verified with Node v26.5.0, npm 11.17.0). Client tests use `node --test` with native TS type
  stripping, so Node ≥ 23 is needed.
- A Chromium-based browser or Firefox.
- Optional: Docker with Compose, for `deploy/`.

## Build, test and run

Run every command from `games/netcode-lab`. Every command marked OK was run by scribe on 2026-11-23 in a fresh
`git clone` of `feat/netcode-lab` at `8c4c1e1` and exited 0. Servers ran on scribe's test ports (185xx) and were
stopped by PID.

**On a fresh clone, run `make client` before starting the server.** `client/dist` and `bin/duel-www` are
git-ignored, and the server serves the game, duel and infra pages from them.

| Command | What it does | Result at 8c4c1e1 |
|---|---|---|
| `make` (= `make all`) | `client/public/sim.wasm` + `wasm_exec.js`, `bin/server`, `bin/bot` | OK (6 s) |
| `make client` | `npm install` + Vite build into `client/dist`, then the duel and infra pages into `bin/duel-www` | OK (11 s) |
| `make test` | `go test ./...` | OK: cmd/bot, net/clock, net/codec, net/cond, server, server/matchmaker, sim, sim/duel |
| `cd client && npm test` | Client unit tests | OK: 19 pass, 0 fail |
| `make determinism` | B.9 check 1: shooter and duel sims, native arm64 vs amd64 (Rosetta) vs WASM | OK: shooter `de0b4ee5068db4c9`, duel `a49b4b920738736c` on all three |
| `make duel` | `bin/duelrelay`, `bin/duelbot` (+ duel page) | OK |
| `make infra` | `bin/infra`, `bin/beaconbot`, `bin/matchmaker`, `bin/relay` (+ pages) | OK |
| `make run` | Builds server + client, then `bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443` | Not run (8080/8443 are reserved for the demo). The same binary ran as `bin/server -http 0.0.0.0:18502 -https 0.0.0.0:18545 -fill 4`: `/`, `/duel.html`, `/infra.html`, `/concepts.html`, `/api/info`, `/metrics` all HTTP 200; 4 fill bots started at boot and stopped with the server |
| `NETLAB_ADMIN_TOKEN=<token> node smoke/smoke.mjs http://127.0.0.1:<http>` (in `client/`) | B.9 check 7 browser smoke | OK: 55 passed, 0 failed, 0 skipped |
| `cd deploy && docker compose -p <name> up --build -d` (ports via env, see below) | Game, infra, Prometheus, Grafana | OK: up in 35 s; game `/` and infra `/infra.html` HTTP 200, Prometheus healthy; `docker compose -p <name> down` OK. The full P20 drill (Grafana panel with data, alert FIRING) ran at `d2c12c6`, see DEMO.md P20 |

LAN join checked at `8c4c1e1` from the host's LAN IP in headless Chrome 156: `https://<lan-ip>:18545` joined over
WebTransport, `http://<lan-ip>:18502` over WebSocket; `?region=hcm` joined the hcm region room.

Not run by scribe this time: `make dev` (Vite in the foreground; its proxy targets `http://localhost:8080` unless
`NETLAB_SERVER` is set), `make bots` (its URL is fixed to `ws://127.0.0.1:8080/ws`), `make duel-run` (:8090/:8453)
and `make infra-run` (:18720/:18721). The game server now serves the duel and infra pages itself, so those two are
optional. Measurement scripts are in `scripts/`; their runs are in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

### Server flags (`bin/server`, [cmd/server/main.go](cmd/server/main.go))

| Flag | Default | Meaning |
|---|---|---|
| `-http` | `0.0.0.0:8080` | Plain HTTP: page + WebSocket (`/ws`) |
| `-https` | `0.0.0.0:8443` | HTTPS (TCP) + WebTransport (UDP, `/wt`) on one port number; empty disables |
| `-dist` | `client/dist` | Built client directory |
| `-www` | `bin/duel-www` | Extra built pages served after `-dist` (`infra.html`, `duel.html`); empty disables |
| `-infra` | `true` | Mount the M7 demo: region rooms `/r/{hcm,hn,sg}`, beacons, matchmaker, `/metrics` |
| `-advertise-https-port` | `0` | HTTPS/WebTransport port to tell browsers when it differs from the listen port (docker port mapping); 0 = the listen port |
| `-fill` | `0` | Start this many fill bots at boot (`-1` = balance the teams; needs `-bot`) |
| `-bot` | `bin/bot` | Bot binary for fill bots and the Lab's P14 peek test; empty disables |
| `-relax-after` | `10` | Matchmaker: seconds before the threshold relaxes |
| `-pprof` | `false` | Serve `net/http/pprof` at `/debug/pprof/` (P19 profiling) |
| `-v` | `false` | Debug logging |

Make variables: `HTTP`, `HTTPS` (listen addresses for `run` and `dev`), `N`, `D` (bots).

**Fill bots** (bots that roam, cross the gap and shoot): `bin/server -fill 4` (or `-fill -1` to balance the teams),
or the Lab's "Bots (fill the teams)" buttons **Fill teams (3v3)** and **Remove bots** (admin token). Their names end
in `[bot]`. Scribe checked `-fill`; the Lab buttons are covered by the client smoke (MEASUREMENTS check 7: fill-bot buttons, 55/0/0 at `8c4c1e1`).

**Docker Compose** (`deploy/`): host ports move with env vars `GAME_HTTP_PORT`, `GAME_HTTPS_PORT`, `INFRA_HTTP_PORT`,
`INFRA_HTTPS_PORT`, `PROM_PORT`, `GRAFANA_PORT`; admin token `NETLAB_ADMIN_TOKEN` (default `lab`). Use your own
project name (`-p`) on a shared machine. `--build` rebuilds the image tag `netcode-lab:local`.

## Host checklist

The full host checklist for a team session (LAN IP, firewall 8080/TCP and 8443/TCP+UDP, admin token, walkthrough
and notes template) is [docs/PLAYTEST.md](docs/PLAYTEST.md).

## Admin token (Lab panel)

Set `NETLAB_ADMIN_TOKEN` before starting the server (`NETLAB_ADMIN_TOKEN=secret make run`), or copy the generated
`adminToken=` from the server log. The presenter opens the page with `?admin=<token>` or types it into the Lab (F1).
Drive the Lab from a second window or device so the play page keeps the mouse; `?spectate=1` joins without a player.

## Repository layout

Committed tree at `8c4c1e1`:

| Path | Contents |
|---|---|
| `Makefile` | Build, run, test, determinism, duel and infra targets |
| `go.mod`, `go.sum` | Go module `netcodelab` |
| `cmd/server` | Game server (also serves the duel relay, infra demo and pages) |
| `cmd/bot` | Walker, shootrun and fill bots, load harness |
| `cmd/simtrace`, `cmd/dueltrace` | Trace generators for the determinism checks |
| `cmd/duelrelay`, `cmd/duelbot` | Stand-alone duel relay and headless duel peer |
| `cmd/infra`, `cmd/beaconbot`, `cmd/matchmaker`, `cmd/relay` | Stand-alone M7 infra server, beacon bots, matchmaker, UDP relay |
| `server/` | Room, tick loop, combat and lag compensation, settings and presets, cost meters, metrics, glitches, fill bots, peek test; `duelrelay/`, `matchmaker/`, `regions/`, `promx/` |
| `sim/` | Fixed-point movement, collision, hitboxes, rays, predictor; `sim/duel` is the integer duel sim |
| `net/` | `clock`, `codec`, `cond` (conditioner), `transport` |
| `wasm/` | Browser WASM entry points (`main.go`, `duel/`) and determinism/dev scripts in `test/` |
| `shared/` | `map.json` (Courtyard), embedded into native and WASM builds |
| `client/` | Vite + TypeScript + three.js: `index.html` (game), `duel.html`, `infra.html`, `concepts.html`; `src/`, `test/`, `smoke/`, `public/` (CC0 assets) |
| `scripts/` | Measurement and drill scripts (checks 2–6, P14, P29, cable-cut drill, presets effect, quiet window, duel), `netem.sh` (Linux only) |
| `deploy/` | `Dockerfile`, `docker-compose.yml` (game, infra, Prometheus, Grafana), `prometheus/`, `grafana/` |
| `docs/` | HANDOFF, CONCEPTS, DECISIONS, ARCHITECTURE, PROTOCOL, DEMO, PLAYTEST, MEASUREMENTS, PRESETS-STATUS, STATUS, ASSETS, AUDIT-A16, `presets.json`, `evidence/` |

Build outputs (`bin/`, `client/dist`, `client/public/*.wasm`, `wasm_exec.js`) are git-ignored.

## Status

Board and decisions: [docs/STATUS.md](docs/STATUS.md). Preset build state: [docs/PRESETS-STATUS.md](docs/PRESETS-STATUS.md).
B.9 check results: top of [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md). What could not be made to work, with evidence and what a human must do: [docs/BLOCKERS.md](docs/BLOCKERS.md). What each preset shows and what was seen:
[docs/DEMO.md](docs/DEMO.md).

## Known gaps

Details and evidence: [docs/BLOCKERS.md](docs/BLOCKERS.md).

- **No team playtest yet** (B.9 check 8). The checklist is ready in docs/PLAYTEST.md.
- **No second machine tested.** LAN joins were checked from the host's own LAN IP.
- **Checks 2 and 5 are not met on this shared, loaded host, and the fast budget case (128 Hz + 144 FPS) needs a 144 Hz display**; see BLOCKERS.md.
- **Fixed ports in some targets:** `make bots` uses `ws://127.0.0.1:8080/ws`; the Vite dev proxy defaults to
  `localhost:8080`; `make duel-run` and `make infra-run` use their built-in defaults. Run the binaries with flags to
  use other ports.
