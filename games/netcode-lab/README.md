# Netcode Lab

Netcode Lab is a browser team shooter for 2–10 players on a LAN, with one hitscan rifle and an original map, the Courtyard.
Each latency technique (prediction, reconciliation, interpolation, lag compensation and the rest) is meant to be a
live toggle a presenter can switch during play; the ideas are in [docs/CONCEPTS.md](docs/CONCEPTS.md) and the
presenter script is in [docs/DEMO.md](docs/DEMO.md).

## Prerequisites

- Go 1.26 (verified with go1.26.4 darwin/arm64).
- Node with npm (verified with Node v26.5.0, npm 11.17.0). The client tests use `node --test` with native TS type
  stripping, so Node ≥ 23 is needed for `npm test`.
- A Chromium-based browser or Firefox (WebTransport with `serverCertificateHashes`).

## Build and run

Run every command from `games/netcode-lab`. Each command below was run from a clean worktree at `fc23a53` and
exited 0.

| Command | What it does | Result at fc23a53 |
|---|---|---|
| `make` (= `make all`) | Builds `client/public/sim.wasm` + `wasm_exec.js`, `bin/server`, `bin/bot` | OK |
| `make client` | `npm install` + Vite production build into `client/dist` (also builds the WASM) | OK (Vite warns that one chunk is > 500 kB) |
| `make test` | `go test ./...` | OK: net/clock, net/codec, net/cond, server, sim pass |
| `cd client && npm test` | Client unit tests | OK: 10 pass, 0 fail |
| `make determinism` | B.9 check 1: sim trace native arm64 vs amd64 (Rosetta) vs WASM in Node | OK: identical sha256 on every tick at 20/30/64/128 Hz |
| `make run` | Builds server + client, then `bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443` | OK: page served with HTTP 200 on both ports |
| `make bots N=2 D=4s` | N walker bots over WebSocket for duration D against the local server | OK: 2 bots joined, walked, reported stats |

Server flags (`bin/server`, see [cmd/server/main.go](cmd/server/main.go)):

| Flag | Default | Meaning |
|---|---|---|
| `-http` | `0.0.0.0:8080` | Plain HTTP: page + WebSocket (`/ws`) |
| `-https` | `0.0.0.0:8443` | HTTPS (TCP) + WebTransport (UDP, `/wt`) on one port number; empty disables |
| `-dist` | `client/dist` | Built client directory |
| `-v` | `false` | Debug logging |

Make variables: `HTTP`, `HTTPS` (listen addresses), `N`, `D` (bots). Bots also run over WebTransport:
`bin/bot -url https://127.0.0.1:8443/wt -n 2 -d 5s` (verified; the bot fetches the cert hash from `-info`,
default `http://127.0.0.1:8080`).

## Join from another machine on the LAN

At start the server mints a self-signed ECDSA P-256 certificate valid 10 days, with the host's IPs as SANs. It
logs the cert hash and the IP list.

1. Find the host IP (macOS: `ipconfig getifaddr en0`).
2. **WebTransport:** open `https://<host-ip>:8443` and accept one certificate warning.
3. **WebSocket fallback:** open `http://<host-ip>:8080`.
4. The host firewall must allow TCP 8080 and TCP + UDP 8443.

## Admin token (Lab panel)

The Lab panel needs an admin token. Set `NETLAB_ADMIN_TOKEN` before starting the server, for example
`NETLAB_ADMIN_TOKEN=secret make run`. If it is not set, the server generates one and logs it as `adminToken=` in a
warning line.

## Repository layout

Committed tree at `fc23a53`:

| Path | Contents |
|---|---|
| `Makefile` | Build, run, test and determinism targets |
| `go.mod`, `go.sum` | Go module `netcodelab` |
| `cmd/server` | Game server entry point (flags above) |
| `cmd/bot` | Walker bot over WebSocket or WebTransport |
| `cmd/simtrace` | Sim trace generator for the determinism check |
| `server/` | Room, tick loop, settings, HTTP/HTTPS + WebTransport, certificate |
| `sim/` | Fixed-point movement, collision, hitboxes, predictor with reconciliation |
| `net/clock`, `net/codec`, `net/cond`, `net/transport` | Clock sync, binary codec with acks, network conditioner, WS/WT transports |
| `wasm/` | WASM entry point for the browser; `wasm/test` holds the determinism and dev scripts |
| `shared/` | `map.json` (Courtyard), embedded into native and WASM builds |
| `client/` | Vite + TypeScript + three.js browser client (`src/game`, `src/hud`, `src/render`, `test/`, `public/sfx`) |
| `docs/` | HANDOFF, CONCEPTS, DECISIONS, DEMO, STATUS, ASSETS, LEAD-PROMPT |

Build outputs: `bin/` (ignored), `client/dist` (ignored), `client/public/sim.wasm` and `wasm_exec.js` (not ignored).

## Status

The board, open risks and lead decisions are in [docs/STATUS.md](docs/STATUS.md).

## Known gaps

- **Playing in the browser over the network is not verified.** The client networking is still being wired, so no
  browser has joined a round yet. The page loads (HTTP 200), but the cert-warning flow and the WebSocket-fallback
  banner were not tested in a browser.
- **No second machine tested.** The LAN IP is in the cert SANs and the ports listen on 0.0.0.0, but only
  127.0.0.1 was tested.
- **`make dev` was not run.** It starts Vite in the foreground (page on http://localhost:5173, proxied to the
  server).
- **WASM build outputs are not git-ignored.** After `make`, `client/public/sim.wasm` and
  `client/public/wasm_exec.js` show as untracked files.
- **`go test ./...` does not cover `wasm/`.** It has a `js/wasm` build tag; `make determinism` covers it.
