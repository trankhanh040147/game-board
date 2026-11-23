# Architecture (M0–M4, Go side)

```
browser (client/, TS)                         Go server (cmd/server)
  sim.wasm  = sim + codec + clock + pacer        server.Room: tick loop @ tickRate
     │ predict / reconcile / encode / decode       ├─ per client: input playout buffer, sim.State
     ▼                                             ├─ cond.Link up   (client→server delay/jitter/loss)
  WebSocket /ws  or  WebTransport /wt  ◀──────▶    ├─ cond.Link down (server→client)
  (binary = hot path, JSON = control)              └─ snapshots @ sendRate, 1 Hz stats JSON
cmd/bot: same sim/codec/clock natively, over the same transports
```

| Package | Role |
|---|---|
| `sim/` | Deterministic movement: Q16.16 fixed point, no floats in `Step`. Swept AABB collision per axis against `shared/map.json`. Hitboxes. `Predictor` = prediction + reconciliation (A.6, A.7). `ray.go`: hitscan geometry (float64, server + cosmetics only, outside the hash). |
| `shared/` | `map.json` (Courtyard), embedded into native and WASM builds. |
| `net/codec` | Binary messages and the ack header `Endpoint` (see PROTOCOL.md). |
| `net/cond` | In-process network conditioner, one `Link` per client per direction. |
| `net/clock` | `Sync` (NTP-style clock and tick estimate) and `Pacer` (when to send inputs). |
| `net/transport` | One `Conn` interface; WebSocket (`coder/websocket`) and WebTransport (`quic-go/webtransport-go` v0.13). |
| `server/` | Room, tick loop, settings, presets, control JSON, HTTP/HTTPS/HTTP3 serving, startup cert. `combat.go`: lag-comp history ring (512 ticks), shot resolution, damage/death/respawn, claims (trust mode), rounds, scoreboard, presenter history. `metrics.go`: whole-window tick histograms, GC stats. |
| `cmd/server` | Binary. `cmd/bot`: headless walker bots. `cmd/simtrace`: determinism trace. |
| `wasm/` | `GOOS=js GOARCH=wasm` entry → `client/public/sim.wasm` (+ `wasm_exec.js`). |

## Running

```
make wasm                       # client/public/sim.wasm + wasm_exec.js
make server && bin/server       # HTTP :8080 (page + WS), HTTPS + WebTransport :8443
make dev                        # server + Vite (http://localhost:5173, proxies /ws and /api to :8080)
make bots N=3 D=30s             # walker bots against :8080
make test                       # go test ./...
make determinism                # B.9 check 1
```

`NETLAB_ADMIN_TOKEN` sets the Lab token; if unset the server prints a random one
at start. Flags: `-http 0.0.0.0:8080`, `-https 0.0.0.0:8443` (empty disables
HTTPS/WebTransport), `-dist client/dist`.

LAN: teammates open `http://<LAN-IP>:8080/` (WebSocket only, fallback banner) or
`https://<LAN-IP>:8443/` (click through the self-signed cert once; WebTransport
works). The cert is ECDSA P-256, valid 10 days, minted at every start with SANs
`localhost`, `127.0.0.1`, `::1` and every non-loopback interface IP, so the hash
changes on restart: fetch `/certhash` on every connect.

## Timing model

- Server: `Room.Run` sleeps to an absolute schedule (`next += period`); each
  tick drains each client's input buffer (one input, or two when > 3 queued),
  steps the sim with `dt = DtForRate(tickRate)` and, by accumulator, sends snapshots.
- Client: runs `sim.Step` at the **same fixed dt**, never the frame delta. The
  pacer sends one input per server tick, stamped `clientTick = estServerTick +
  RTT/2·rate + margin`. It sends early by that much and raises the margin by
  one tick each time the server reports a starvation (`own.starved` changed).
- Conditioner default: 20 ms each way (RTT 40 ms, A.1). On WebSocket the links
  are "ordered": loss becomes a retransmit stall (≥ 200 ms RTO) that blocks later
  packets (simulated TCP head-of-line). On WebTransport loss drops the datagram.

## WASM JS API (`globalThis.NetcodeSim`, apiVersion 3)

Load: include `wasm_exec.js`, then

```ts
const go = new Go();
const ready = new Promise<void>(r => (globalThis.onNetcodeSimReady = r));
const { instance } = await WebAssembly.instantiateStreaming(fetch("sim.wasm"), go.importObject);
go.run(instance);          // do not await: it never returns
await ready;               // NetcodeSim is now set
const S = globalThis.NetcodeSim;
```

Units: every position/velocity is an **integer in Q16.16** (`S.FX = 65536`;
metres = `v / S.FX`). Angles are int16 (`S.angleFromRadians(rad)`,
`S.angleToRadians(a)`); quantise the mouse yaw/pitch **before** predicting so
client and server use the same value. Y up, yaw 0 faces −Z, positive yaw turns
left (same as Three.js `rotation.y`). Handles (`conn`, `pred`, `clock`,
`pacer`) are integers; `S.free(h)` releases one.

```ts
type State = { x, y, z, vx, vy, vz: number /*Q16.16 int*/, onGround: boolean, yaw: number, pitch: number /*int16*/ };
type Input = { buttons: number, yaw: number, pitch: number };
type Cmd   = Input & { seq: number, clientTick: number, renderTick?: number, renderFrac?: number, subtickFrac?: number };
```

Constants: `S.HIT {none:0, body:1, head:2}`, `S.FX`, `S.BTN {forward:1, back:2, left:4, right:8, jump:16, fire:32}`,
`S.ANIM {onGround:1, moving:2, dead:4}`, `S.PLAYER {halfWidth:0.4, height:1.8,
eyeHeight:1.6, body:{half:0.35, top:1.45}, head:{half:0.17, bottom:1.45, top:1.8}}`
(metres, relative to the feet position), `S.mapJSON` (string, same as
`/shared/map.json`: `boxes[{id,min,max}]`, `spawns{blue,orange}` in metres),
`S.apiVersion`, `S.protocolVersion`.

| Function | Returns | Notes |
|---|---|---|
| `dtForRate(hz)` | int | fixed dt in Q16.16 s (64 → 1024) |
| `step(state, input, dt)` | State | one sim tick |
| `hash(state)` | 16-hex string | FNV-1a 64 of the state |
| `newPredictor(state)` | handle | use `welcome.spawn` |
| `predictorReset(pred, state)` | – | e.g. on respawn |
| `predict(pred, cmd, dt)` | State | applies now and keeps cmd pending |
| `reconcile(pred, serverState, lastProcessedInputSeq, dt, replay, life?, dead?)` | `{state, corrected, replayed, respawned, delta:[dx,dy,dz]}` | `replay = settings.reconcile`; false = hard snap (P04). Pass `own.life` and `own.dead` (v2): a changed life (respawn) or dead state is not counted as a correction, and nothing is replayed while dead. `delta` = old − new predicted position, for visual smoothing |
| `predictorInfo(pred)` | `{state, corrections, replayed, pending:[seq]}` | HUD "pending: #41 #42, replayed, corrections" |
| `pendingCmds(pred)` | Cmd[] | |
| `newConn()` | handle | ack state of one connection |
| `encodeInputFromPredictor(conn, pred, nowMs)` | Uint8Array | newest pending cmd + up to 3 earlier unacked |
| `encodeInput(conn, cmds, nowMs)` | Uint8Array | explicit list, keeps the newest 4 |
| `encodePing(conn, nowMs)` | Uint8Array | `nowMs = performance.now()` |
| `encodeSnapshotAck(conn, snapId, serverTick, nowMs)` | Uint8Array | send for each snapshot, with **`msg.snapId`** (v3; it was baselineId). The conn handle keeps the delta baselines, so P27 works with no client change other than this |
| `decode(conn, bytes, nowMs)` | object | updates acks; see below |
| `connStats(conn)` | `{sent, acked, lost, rttMs, received, duplicates, old, remoteGaps}` | `rttMs` is ack-based (includes the wait for the next packet back) |
| `encodeClaim(conn, {seq, clientTick, x, y, z, victimId, hitbox}, nowMs)` | Uint8Array | type 7: trust mode (P03) and the "modded client" button |
| `aimDir(yaw, pitch)` | `[x,y,z]` | unit view direction, same as the server's ray |
| `traceMap(x, y, z, yaw, pitch)` | metres | distance from the eye (feet + 1.6 m) to the first map box: tracer end / impact decal |
| `fireCooldownTicks(tickRate)` | int | 600 rpm rule (ceil(rate/10) inputs between shots) |
| `newClock()` | handle | |
| `clockPong(clock, pongMsg, recvNowMs)` | – | pass the decoded pong |
| `clockEstimate(clock, nowMs)` | `{ready, offsetMs, rttMs, minRttMs, lastRttMs, jitterMs, samples, serverTimeMs, serverTick, tickRate}` | `serverTick` is fractional. The client derives the interpolation render time from snapshot arrival instead (measured ghost lead 120 ms, A.9) |
| `newPacer()` | handle | |
| `pacerDue(pacer, clock, nowMs)` | number[] | clientTicks to send an input for **now** (0–4); call every frame/2 ms |
| `pacerFeedback(pacer, snapshot.own.starved, nowMs)` | – | on every snapshot |
| `pacerInfo(pacer)` | `{marginTicks, raises}` | |
| `angleFromRadians(rad)`, `angleToRadians(a)` | number | |

`decode` result: always `{type, dup, seq, ack, ackBits}`; ignore when `dup`. Plus:

- `type:"snapshot"`: `serverTick, serverTimeMs, lastProcessedInputSeq, own:{state, health, inputBuffer, starved, inputLead, dead, life}, snapId, baselineId, encoding (S.ENC bits), entities:[{id, team (0 blue,1 orange), x, y, z, yaw, pitch, health, anim}], events:[...]`. Events are decoded (dedupe them, they repeat until acked):
  - `{type:"shot", shotSeq, resolveTick, renderTick, renderFrac, rewoundTick, rewoundFrac, flags, lagcomp, clamped, favoured, killed, trust, hitId, hitbox, damage, victimHp, seenId, seenHitbox, movedCm, seenPos:[x,y,z], usedPos:[x,y,z], wallDistM, recvMs, tickStartMs, subtickFrac, timingErrMs}`: hit marker / damage number only from this (B.3); P08 miss reason = `seenId && !hitId` → "target moved movedCm cm"; P09 red box = `seenPos`, blue box = `usedPos`; P11 S2 = `recvMs`, S3 = `tickStartMs`, S4 = this snapshot's `serverTimeMs`
  - `{type:"damage", shotSeq, shooterId, hitbox, damage, health, resolveTick, flags, killed}`
  - `{type:"death", life, shooterId, hitbox, flags, lagcomp, shotSeq, resolveTick, rewoundTick, rewoundFrac, hitPos, nowPos, shooterPos, shooterYaw, shooterPitch, respawnTick}`: P24 replay (`hitPos` = where the server placed you, `nowPos` = where you were)
- `type:"pong"`: `clientSendMs, serverRecvMs, serverSendMs, serverTick, tickFrac, tickRate`
- `type:"debug"`: `serverTick, players:[{id,x,y,z}]` (truth ghost)
- `type:"invalid"` / `"unknown"`

Minimal client loop (this exact sequence runs in `wasm/test/client-loop.mjs`
against the real server):

```ts
ws.send(JSON.stringify({t:"join", name}));            // text frame
// on welcome: pred = S.newPredictor(msg.spawn); settings = msg.settings
// every 250 ms: ws.send(S.encodePing(conn, performance.now()))
// on binary: m = S.decode(conn, bytes, now)
//   pong     -> S.clockPong(clock, m, now)
//   snapshot -> S.pacerFeedback(pacer, m.own.starved, now)
//               if (m.lastProcessedInputSeq > 0) r = S.reconcile(pred, m.own.state, m.lastProcessedInputSeq, S.dtForRate(settings.tickRate), settings.reconcile)
//               ws.send(S.encodeSnapshotAck(conn, m.baselineId, m.serverTick, now))
// every frame: for (const t of S.pacerDue(pacer, clock, now)) {
//                 const cmd = {seq: ++seq, clientTick: t, buttons, yaw, pitch};
//                 if (settings.predict) S.predict(pred, cmd, dt) else <keep cmd for redundancy only>;
//                 ws.send(S.encodeInputFromPredictor(conn, pred, now)); }
```

Dumb mode (P02, `predict:false`): still send inputs, but draw your own player
from `snapshot.own.state` only. Encoding needs pending commands, so either keep
calling `predict` and ignore its state for drawing, or build the cmd list
yourself and use `encodeInput(conn, last4, now)`.

## Shooting from the client (M3)

- Fire input: set `S.BTN.fire` on the input of the tick the click lands in, with
  `renderTick`/`renderFrac` = the server time the client is drawing **other**
  players at (the interpolation render time, as a fractional server tick), and
  `subtickFrac` (P26, unused yet). Client measures render time from snapshot
  arrival (client note, 2026-11-23); the server rewinds to exactly what it is
  sent, clamped to `historyMs`.
- Cosmetics (flash, tracer to `traceMap`, decal, sound) play at once; hit marker
  and damage numbers only on a `shot` event (B.3).
- Trust mode (`settings.authority == "trust"`): send `encodeClaim` every tick
  with your predicted position, and with `victimId`/`hitbox` when your own ray
  hits someone. The "modded client" button sends a claim with a far `victimId`
  and `hitbox: 2` in any mode: the server relays it in trust mode and rejects it
  otherwise (`claimRejected` broadcast).
- Spectator / presenter: `{t:"join", spectate:true}`, then `{t:"history"}` for
  the 2 s server ring, and `debugpos` relays from players while `truthGhost` is on.
- Scorecard: `welcome.scorecard` / `settings.scorecard` (computed on the server
  from `authority`, `predict`, `reconcile`, `interp`, `lagcomp`). There is no
  `mode` key: dumb = `predict:false`, trust = `authority:"trust"`.

## Client duties added in v3 (M5/M6)

- Fire input: also send `subtickFrac` = how far into the current input tick the click happened (0..65535), and
  stamp `renderTick/renderFrac` **at the click**. With `settings.subtick` off the server times the shot at the
  tick end anyway (P26 shows the error).
- P11: when a `damage` event reaches the target client, it sends `{t:"shotSeen", shooterId, shotSeq,
  recvServerMs, interpMs, frameServerMs}` (server-clock ms via `clockEstimate`). The shooter receives
  `{t:"shotTrace", ...}` and joins it on `shotSeq` with its own click/frame/send times and the ShotResult's
  `recvMs`/`tickStartMs`.
- P12/P15: `stats.cost`, `stats.youCost` and `stats.budgetEst` (the `est.` column).
- P27: `stats.you.entityBytes` gives raw/quant/bitpack/delta bytes per second for the meters.
- P28: `stats.you.entitiesPerSnapshot`.

## Tick health (P19)

- `settings.loop`: `zeroalloc` (default) reuses room-owned scratch (entity list, snapshot, debug feed, encode
  buffers from `server/pool.go`). The downlink conditioner hands each buffer back through `cond.Link.Release`
  after it is sent. `naive` allocates a new entity object, entity slice, snapshot and encode buffer per client
  per tick, and a new history slice each tick. Both send identical bytes (`TestLoopModesSameBytes`).
  Measured: 0.0 vs 273 allocations per snapshot tick with 20 clients (`TestLoopModesAllocations`).
- The conditioner heap no longer boxes items into `container/heap` interfaces. The two goroutines per client
  (one per direction) remain; they are per connection, not per tick.
- `go build -gcflags=-m ./server ./net/cond ./net/codec` findings (2026-11-23):
  - `append escapes to heap` in `codec.Writer` and the conditioner: amortized growth of reused buffers. Once
    capacity is reached nothing allocates, as the 0.0 allocs/tick shows.
  - `&Link{}`, `rand.New`, `time.NewTimer` escape once per connection.
  - The `map[string]any` control messages (kill feed, claim rejected, stats) escape. They are per event or 1 Hz,
    never per tick.
  - quic-go's `SendDatagram` copies the payload into a fresh slice (quic-go v0.62 `connection.go:3059`). That
    allocation is in the transport and outside this loop.
- `settings.goMemLimitMB` calls `runtime/debug.SetMemoryLimit`; 0 restores the limit the process started with
  (GOMEMLIMIT env). `stats.window.gc` reports cycles, pause p50/p99/max and heap bytes from `runtime/metrics`.

## Known limits

- One room. P11, P15, P19 and P29 presets stay `built:false` until the client shows their data (the server half is
  done).
- WebTransport: verified with the Go bot and by "client" with Chromium 148
  (`https://127.0.0.1:<port>/wt` with `serverCertificateHashes`).
