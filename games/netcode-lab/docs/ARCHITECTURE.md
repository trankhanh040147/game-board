# Architecture (M0 + M1, Go side)

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
| `sim/` | Deterministic movement: Q16.16 fixed point, no floats in `Step`. Swept AABB collision per axis against `shared/map.json`. Hitboxes. `Predictor` = prediction + reconciliation (A.6, A.7). |
| `shared/` | `map.json` (Courtyard), embedded into native and WASM builds. |
| `net/codec` | Binary messages and the ack header `Endpoint` (see PROTOCOL.md). |
| `net/cond` | In-process network conditioner, one `Link` per client per direction. |
| `net/clock` | `Sync` (NTP-style clock and tick estimate) and `Pacer` (when to send inputs). |
| `net/transport` | One `Conn` interface; WebSocket (`coder/websocket`) and WebTransport (`quic-go/webtransport-go` v0.13). |
| `server/` | Room, tick loop, settings, presets, control JSON, HTTP/HTTPS/HTTP3 serving, startup cert. |
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

## WASM JS API (`globalThis.NetcodeSim`, apiVersion 1)

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

Constants: `S.FX`, `S.BTN {forward:1, back:2, left:4, right:8, jump:16, fire:32}`,
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
| `reconcile(pred, serverState, lastProcessedInputSeq, dt, replay)` | `{state, corrected, replayed, delta:[dx,dy,dz]}` | `replay = settings.reconcile`; false = hard snap (P04). `delta` = old − new predicted position, for visual smoothing |
| `predictorInfo(pred)` | `{state, corrections, replayed, pending:[seq]}` | HUD "pending: #41 #42, replayed, corrections" |
| `pendingCmds(pred)` | Cmd[] | |
| `newConn()` | handle | ack state of one connection |
| `encodeInputFromPredictor(conn, pred, nowMs)` | Uint8Array | newest pending cmd + up to 3 earlier unacked |
| `encodeInput(conn, cmds, nowMs)` | Uint8Array | explicit list, keeps the newest 4 |
| `encodePing(conn, nowMs)` | Uint8Array | `nowMs = performance.now()` |
| `encodeSnapshotAck(conn, baselineId, serverTick, nowMs)` | Uint8Array | send for each snapshot |
| `decode(conn, bytes, nowMs)` | object | updates acks; see below |
| `connStats(conn)` | `{sent, acked, lost, rttMs, received, duplicates, old, remoteGaps}` | `rttMs` is ack-based (includes the wait for the next packet back) |
| `newClock()` | handle | |
| `clockPong(clock, pongMsg, recvNowMs)` | – | pass the decoded pong |
| `clockEstimate(clock, nowMs)` | `{ready, offsetMs, rttMs, minRttMs, lastRttMs, jitterMs, samples, serverTimeMs, serverTick, tickRate}` | `serverTick` is fractional; render time for interpolation = `serverTick − interpMs·tickRate/1000` |
| `newPacer()` | handle | |
| `pacerDue(pacer, clock, nowMs)` | number[] | clientTicks to send an input for **now** (0–4); call every frame/2 ms |
| `pacerFeedback(pacer, snapshot.own.starved, nowMs)` | – | on every snapshot |
| `pacerInfo(pacer)` | `{marginTicks, raises}` | |
| `angleFromRadians(rad)`, `angleToRadians(a)` | number | |

`decode` result: always `{type, dup, seq, ack, ackBits}`; ignore when `dup`. Plus:

- `type:"snapshot"`: `serverTick, serverTimeMs, lastProcessedInputSeq, own:{state, health, inputBuffer, starved, inputLead}, baselineId, entities:[{id, team (0 blue,1 orange), x, y, z, yaw, pitch, health, anim}], events:[{type, data:Uint8Array}]`
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

## Known limits (this milestone)

- One room; trust mode, hitscan, lag compensation, delta compression and interest
  management are later milestones (settings with `built:false`).
- WebTransport is verified with the Go bot over QUIC (localhost). No browser
  has connected to it yet.
