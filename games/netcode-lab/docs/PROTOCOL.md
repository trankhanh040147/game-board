# Wire protocol (protocolVersion 1)

Source of truth: `net/codec/codec.go` (encoders/decoders, used by the server,
the bots and the browser through WASM). Little-endian. Positions and velocities
are Q16.16 fixed-point int32 (65536 = 1 m or 1 m/s). Angles are int16 where the
full uint16 range is one turn (65536 = 2π). Y is up; yaw 0 faces −Z.

## Transports

| Transport | URL | Hot path (binary) | Control (JSON) |
|---|---|---|---|
| WebSocket | `ws://<host>:8080/ws` (also `wss://<host>:8443/ws`) | binary frames | text frames |
| WebTransport | `https://<host>:8443/wt` | QUIC datagrams | the **first bidirectional stream the client opens**, newline-delimited JSON |

WebTransport needs a secure context: open the page at `https://<host>:8443/`
(one certificate click-through) and pin the cert with
`serverCertificateHashes: [{algorithm: "sha-256", value: <bytes of base64>}]`
from `GET /certhash`. Over plain `http://<LAN-IP>:8080/` only WebSocket works;
the client shows a "WebSocket fallback" banner there.

HTTP endpoints (both ports): `GET /certhash` (also `/api/certhash`) →
`{algorithm, base64, hex, notAfter, wtPath, port}`; `GET /api/info` →
`{protocolVersion, ws, wt: {path, port, certHashBase64} | null, secure, serverTimeMs}`;
`GET /shared/map.json`; everything else serves `client/dist`.

## Datagram header (every binary message, 9 bytes)

| Field | Type | Meaning |
|---|---|---|
| type | u8 | 1 Input, 2 Snapshot, 3 SnapshotAck, 4 Ping, 5 Pong, 6 Debug |
| seq | u16 | sender's packet number (wraps) |
| ack | u16 | newest packet seq received from the other side |
| ackBits | u32 | bit i set = packet `ack-1-i` also received |

Each side keeps one `codec.Endpoint` per connection: it numbers packets, builds
ack/ackBits, detects duplicates, and learns RTT and loss from acks (a packet is
lost once it leaves the 33-packet window unacked). In the browser the WASM conn
handle holds this state.

## C→S Input (type 1)

`u8 count` (1..4), then `count` commands **oldest first**: the newest input plus
up to 3 earlier unacknowledged ones (redundancy, B.4 rule 4).

| Field | Type | |
|---|---|---|
| inputSeq | u32 | starts at 1, +1 per client tick |
| clientTick | u32 | server tick this input is meant for (clock sync + pacer) |
| buttons | u16 | bit 0 forward, 1 back, 2 left, 3 right, 4 jump, 5 fire |
| yaw | i16 | |
| pitch | i16 | |
| renderTick, renderFrac, subtickFrac | u32, u16, u16 | **only when fire is set**: server tick + fraction/65536 the client was rendering others at, and the fire time inside the tick |

The server keeps a per-client buffer keyed by inputSeq and applies inputs **in
sequence, one per tick** (two when more than 3 are queued). It starts after 2
are queued. When empty it repeats the last input (without fire/jump) and
counts a starvation. A seq gap that redundancy did not cover is skipped and counted.

## S→C Snapshot (type 2), sent at sendRate

| Field | Type | |
|---|---|---|
| serverTick | u32 | tick the state belongs to |
| serverTimeMs | f64 | server monotonic ms at send |
| lastProcessedInputSeq | u32 | the ack reconciliation uses: own state is "as of this input" |
| own.pos | 3×i32 | **exact** sim state, compare bit for bit |
| own.vel | 3×i32 | |
| own.flags | u8 | bit 0 onGround |
| own.yaw, own.pitch | i16, i16 | |
| own.health | u8 | |
| own.inputBuffer | u8 | inputs queued at the server after this tick |
| own.starved | u16 | cumulative ticks the server repeated an input (wraps) |
| own.inputLead | i8 | newest received clientTick − server tick at arrival |
| baselineId | u8 | 0 = full snapshot (delta encoding is M6) |
| entityCount | u8 | then per other player: `u8 id, u8 team (0 blue, 1 orange), 3×i32 pos, i16 yaw, i16 pitch, u8 health, u8 anim` (anim bit 0 onGround, 1 moving, 2 dead) |
| eventCount | u8 | then per event: `u8 type, u8 len, len bytes` (types defined in M3) |

The send schedule uses an accumulator (`acc += sendRate; send when acc ≥ tickRate`),
so 20/s at 64 Hz alternates 3- and 4-tick gaps (46.9 / 62.5 ms).

## C→S SnapshotAck (type 3)

`u8 baselineId, u32 serverTick`: the newest snapshot the client holds (delta baseline for M6).

## Ping (type 4) / Pong (type 5)

Ping: `f64 clientSendMs` (the client's own clock, e.g. `performance.now()`).
Pong: `f64 clientSendMs` (echo), `f64 serverRecvMs`, `f64 serverSendMs`,
`u32 serverTick`, `u16 tickFrac` (part of the current tick elapsed, /65536),
`u16 tickRate`. Server times are when the packet leaves / enters the
conditioner, so RTT includes the simulated delay. Clock sync (NTP-style, median
offset of the lowest-RTT half of the last 16 samples) is in `net/clock`.

## S→C Debug (type 6), only while `truthGhost` is on

`u32 serverTick, u8 count`, then `u8 id, 3×i32 pos` per player (every player, including you).

## Control JSON

Client → server:

| `t` | Fields | Auth |
|---|---|---|
| `join` | `name` | must be the first message |
| `lab` | `token`, `settings` (partial object, keys from `supportedSettings`) | admin token |
| `preset` | `token`, `id` (`P01`…) | admin token; refused if `built:false` |
| `cond` | `up?`, `down?` (`{delayMs, jitterMs, lossPct, dupPct, reorderPct}`), `target?` (player id, default self), `all?`, `token?` | self: none; other player or `all`: admin token |
| `chat` | `text` | |

Server → client:

| `t` | Fields |
|---|---|
| `welcome` | `protocolVersion, id, name, team, transport, settings, presetId, banner, supportedSettings[{key,kind,allowed,min,max,built,note}], presets[{id,title,section,banner,built}], cond{up,down}, tick, tickRate, serverTimeMs, spawn{x,y,z,vx,vy,vz,onGround,yaw,pitch}, map, adminTokenRequired` |
| `players` | `players[{id,name,team}]` on every join/leave |
| `settings` | `settings, presetId, banner` broadcast on every Lab change |
| `cond` | `cond{up,down}, by` to the affected client |
| `stats` | 1 Hz: `serverTick, serverTimeMs, tickRate, sendRate, tick{samples,budgetMs,p50Ms,p99Ms,maxMs,withinBudgetPct}, players, you{inputBuffer, starved, skippedInputs, redundantInputs, lastProcessedInputSeq, inputLead, ackedSnapshotTick, upLossPct, serverAckRttMs, downSent, downAcked, downLost, cond, condStats{up,down}}` |
| `chat` | `from, id, text` |
| `error` | `msg` |

Settings keys and defaults: `authority "server"`, `predict true`, `reconcile true`,
`interp true`, `interpMs 100`, `interpAuto true`, `interpK 2`, `lagcomp true`,
`historyMs 1000`, `tickRate 64` (20/30/64/128), `sendRate 20` (10/20/30/64/128,
≤ tickRate), `fpsCap 60` (0 = uncapped, 30/60/144), `truthGhost false`, `transport "wt"`.
