# Wire protocol (protocolVersion 2)

v2 (2026-11-23, M3/M4): snapshot own state gains `ownFlags` and `life`; typed snapshot events; C→S `Claim` (type 7); new control messages for rounds, kills, scoreboard, history, spectators and reports. `/api/info` and `/certhash` `port` is a number.

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
| type | u8 | 1 Input, 2 Snapshot, 3 SnapshotAck, 4 Ping, 5 Pong, 6 Debug, 7 Claim |
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
are queued. When empty on an on-time tick it repeats the last input (without
fire/jump) and counts a starvation (`own.starved`). During a host stall's
catch-up ticks, and for uplink delay + jitter + 2 ticks after, an empty buffer
holds the player instead and counts `heldOnStall` (stats); see DECISIONS 22. A seq gap that redundancy did not cover is skipped and counted.

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
| own.ownFlags | u8 | bit 0 dead (v2) |
| own.life | u8 | +1 on every respawn (v2). A changed life = teleport, not a misprediction |
| baselineId | u8 | 0 = full snapshot (delta encoding is M6) |
| entityCount | u8 | then per other player: `u8 id, u8 team (0 blue, 1 orange), 3×i32 pos, i16 yaw, i16 pitch, u8 health, u8 anim` (anim bit 0 onGround, 1 moving, 2 dead) |
| eventCount | u8 | then per event: `u8 type, u8 len, len bytes` (see Events) |

The send schedule uses an accumulator (`acc += sendRate; send when acc ≥ tickRate`),
so 20/s at 64 Hz alternates 3- and 4-tick gaps (46.9 / 62.5 ms).

### Events (v2, `net/codec/events.go`)

An event rides **every** snapshot to its client until the client acks
(SnapshotAck) a snapshot tick at or after the first one that carried it, or
for at most 3 s. Clients dedupe: shot/damage by `shotSeq` + shooter, death by `life`.

**1 ShotResult** (to the shooter, one per accepted fire input; 73 bytes):
`u32 shotSeq` (= the fire input's seq, the shot id), `u32 resolveTick` (tick
whose simulate consumed the input), `u32 renderTick, u16 renderFrac` (as sent),
`u32 rewoundTick, u16 rewoundFrac` (time the other players were placed at;
= resolveTick when not rewound), `u8 flags` (bit 0 lagcomp used, 1 clamped to
the history cap, 2 favoured victim (no rewind, shooter RTT too high), 3 killed,
4 trust-mode claim), `u8 hitId` (0 = miss), `u8 hitbox` (1 body, 2 head),
`u8 damage`, `u8 victimHp`, `u8 seenId, u8 seenHitbox` (who the ray hits at the
shooter's render time, i.e. what the shooter saw), `u16 movedCm` (how far that
player moved between render time and the time used: the P08 "target moved N cm"),
`3×i32 seenPos` (red box: that player at render time), `3×i32 usedPos` (blue
box: at the time used), `u32 wallDistCm` (tracer end), `f64 recvMs` (server
time the fire input left the uplink conditioner: P11 S2), `f64 tickStartMs`
(start of the resolving tick: P11 S3). The first snapshot carrying it has
`serverTimeMs` = P11 S4.

**2 Damage** (to the victim): `u32 shotSeq, u8 shooterId, u8 hitbox, u8 damage,
u8 health (after), u32 resolveTick, u8 flags`.

**3 Death** (to the victim, P24 replay): `u8 life` (the life that ended),
`u8 shooterId, u8 hitbox, u8 flags, u32 shotSeq, u32 resolveTick, u32 rewoundTick,
u16 rewoundFrac, 3×i32 hitPos` (where the server placed you for the hit, rewound),
`3×i32 nowPos` (where you really were at resolveTick), `3×i32 shooterPos, i16
shooterYaw, i16 shooterPitch, u32 respawnTick`.

### Shots (server rules)

- Fire = input with button bit 5. Accepted at most every `ceil(tickRate/10)`
  inputs (600 rpm); `fireCooldownTicks` is in welcome/settings.
- Ray: from the shooter's state **after** applying that input, at eye height
  1.6 m, direction `aimDir(yaw, pitch)` = `(−sin y·cos p, sin p, −cos y·cos p)`.
  No spread. First map box ends it.
- Render time `renderTick + renderFrac/65536` (0 = not sent → resolve tick) is
  clamped to `[resolveTick − historyMs·rate/1000, resolveTick]`.
- `lagcomp` on: other players are placed at the render time, interpolated between
  recorded ticks. Off, or when the shooter's RTT > `favorVictimRttMs` (> 0): placed
  at the resolve tick. Only players are rewound, never the map.
- Teammates are not hit (the ray passes). Body 25, head 100; 0 health → death,
  respawn after 3 s at a team spawn, `life`+1.

## C→S Claim (type 7, v2)

`u32 inputSeq, u32 clientTick, 3×i32 pos, u8 victimId, u8 hitbox`. A client
stating a result. With `authority:"trust"` (P03) the server sets the player to
`pos` and applies the claimed hit without checks. With `authority:"server"` the
claim is rejected, counted (`rejectedClaims` in the scoreboard), logged
"rejected claim" and broadcast as `claimRejected`. A modded client sends the
same packet in both modes.

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
| `join` | `name`, `spectate?` (true = presenter/spectator: no player, receives all players as entities) | must be the first message |
| `lab` | `token`, `settings` (partial object, keys from `supportedSettings`) | admin token |
| `preset` | `token`, `id` (`P01`…) | admin token; refused if `built:false` |
| `cond` | `up?`, `down?` (`{delayMs, jitterMs, lossPct, dupPct, reorderPct}`), `target?` (player id, default self), `all?`, `token?` | self: none; other player or `all`: admin token |
| `chat` | `text` | |
| `report` | `rttMs, jitterMs, lossPct, fps` (1 Hz, client-measured) | – (scoreboard ping/loss/FPS, favour-victim RTT) |
| `history` | – | – → reply `history` |
| `statsReset` | `token` | admin token (resets the whole-window histograms) |
| `debugpos` | any JSON (own predicted pos, interpolated others, tick) | relayed to spectators while `truthGhost` is on |

Server → client:

| `t` | Fields |
|---|---|
| `welcome` | `protocolVersion, id, name, team, transport, settings, presetId, banner, supportedSettings[{key,kind,allowed,min,max,built,note}], presets[{id,title,section,banner,built}], cond{up,down}, tick, tickRate, serverTimeMs, spawn{x,y,z,vx,vy,vz,onGround,yaw,pitch}, map, adminTokenRequired`; v2 adds `spectator, scorecard{instant,smooth,fair,cheatProof}, round, life, fireCooldownTicks, rules{damageBody,damageHead,respawnMs,roundMs,intermissionMs,rpm,historyKeepMs}` |
| `players` | `players[{id,name,team}]` on every join/leave |
| `settings` | `settings, presetId, banner, scorecard, fireCooldownTicks` broadcast on every Lab change |
| `round` | `no, state ("playing"\|"ended"), endsAtServerMs, scores{blue,orange}` on every change (2 min rounds, 5 s intermission) |
| `kill` | `killerId, killer, victimId, victim, headshot, tick, trust, lagcomp` (kill feed) |
| `claimRejected` | `id, name, victimId, hitbox, tick, reason` |
| `scoreboard` | 1 Hz: round fields + `players[{id,name,team,kills,deaths,alive,pingMs,pingSource,lossPct,fps,shots,hits,rejectedClaims}]` |
| `history` | `tickRate, ticks[{tick, serverTimeMs, players[{id,team,x,y,z,yaw,pitch,alive}]}]` (last 2 s, Q16.16) |
| `debugpos` | `from, data` (relayed) |
| `cond` | `cond{up,down}, by` to the affected client |
| `stats` | 1 Hz: `serverTick, serverTimeMs, tickRate, sendRate, tick{samples,budgetMs,p50Ms,p99Ms,maxMs,withinBudgetPct}, players, tickStartLate{p50Ms,p99Ms,maxMs,maxSinceStartMs,catchUpTicks,scheduleResets}, window{tickMs, startLateMs: {samples,meanMs,p50Ms,p95Ms,p99Ms (null < 100 samples),p999Ms (null < 1000),maxMs,overBudget,withinBudgetPct}, gc{cycles,pauseP50Ms,pauseP99Ms,pauseMaxMs,pauseCount,heapBytes,allocBytesTotal,goMemLimitBytes,goroutines}}, you{inputBuffer, starved, heldOnStall, skippedInputs, redundantInputs, lastProcessedInputSeq, inputLead, ackedSnapshotTick, upLossPct, serverAckRttMs, downSent, downAcked, downLost, cond, condStats{up,down}}` |
| `chat` | `from, id, text` |
| `error` | `msg` |

Settings keys and defaults: `authority "server"`, `predict true`, `reconcile true`,
`interp true`, `interpMs 100`, `interpAuto true`, `interpK 2`, `lagcomp true`,
`historyMs 1000`, `favorVictimRttMs 0` (off), `speedScale 1` (server-only, 0.25–2), `tickRate 64` (20/30/64/128), `sendRate 20` (10/20/30/64/128,
≤ tickRate), `fpsCap 60` (0 = uncapped, 30/60/144), `truthGhost false`, `transport "wt"`.
