# Decisions (append-only)

## 2026-11-23 — core: M0/M1 Go design (not yet implemented, turn cut by usage limit)

1. **Fixed-point sim instead of float64 (B.4 rule 2).** Positions/velocities are int32 Q16.16 metres, int64 intermediates,
   integer sqrt, sin/cos from a table built with integer math. Reason: no FMA drift between arm64 and wasm, and the
   snapshot can carry the exact own state, so reconciliation can reach 0 corrections (B.9 check 2) without quantisation error.
2. **Sim dt = 1/tickRate** (Q16.16: 64 Hz = 1024 exactly). Client prediction steps at the server tick rate.
3. **Y-up coordinates, yaw 0 faces -Z**, matching Three.js, so the client needs no axis conversion.
4. **Courtyard "low wall" is 2.0 m high** (lower than the 4 m blocks). B.3 has no crouch, so the wall must fully cover a
   standing 1.8 m player for the A.10 "reached cover" demo.
5. **`net/` is split into subpackages** (`net/codec`, `net/cond`, `net/clock`, `net/transport`) so no package is named
   `net` and clashes with the stdlib; WASM imports only codec/clock.
6. **Input redundancy = current input + up to 3 previous unacked** (≤ 4 commands per packet).
7. **Server consumes inputs sequentially, one per tick** (two when the buffer exceeds target+2), never by clientTick
   match; empty buffer repeats the last input and counts it (A.14). Reason: dropping late inputs would cause corrections.
8. **Conditioner "ordered" mode for WebSocket**: in-process loss in WS mode is emulated as a retransmit delay that
   blocks later packets (TCP head-of-line, labelled simulated), not a drop. Datagram mode drops.
9. **Control JSON bypasses the conditioner.** Server stats (tick ms, % within budget, starvation) go in a 1 s control
   `stats` message, not the binary hot path.
10. **Presets live server-side** (`{"t":"preset","id":"P02"}`, admin token). P04 = predict on + reconcile off (shows the
    A.7 snap-back), P05 = reconcile on. Players may edit their own conditioner without the token.
11. **Prediction/reconciliation logic in Go** (`sim/predict`), exposed via WASM, so the bot and the browser share it.

## 2026-11-23 — client: M0–M2 client choices

1. **Interpolation timeline = arrival clock, not the synced server clock.** Render time = (server time of the newest
   snapshot as it arrives with no jitter: max of serverMs − localRecvMs over 2 s) − buffer. This is Source's
   `cl_interp` model, so what you see is buffer + downlink old (A.9: ≈ 120 ms). The ghost lead in P07 is then measured
   as synced server now − render time. Interpolation is rendering only; movement rules stay in the WASM sim (A.6).
2. **Offline spectator camera.** Without a server the page still renders the Courtyard from shared/map.json with a
   labelled free camera ("not the game's movement rules"). Every network row in the net graph shows "—", the scorecard
   shows "?", and every Lab preset is disabled with its reason. No value is invented.
3. **Lab panel renders server settings generically.** It shows exactly the keys the server broadcasts and only the
   presets the server lists as built. Anything else is disabled with "not built yet" or "server not connected".
4. **FPS cap above the display refresh runs on a MessageChannel/setTimeout loop**, because requestAnimationFrame is
   vsync-bound. The net graph shows the measured FPS, so a cap the display cannot present is visible as such.
5. **Client unit tests use `node --test`** (Node ≥ 23 strips TS types natively), so the client has no test-framework dependency.

## 2026-11-23 — lead: transport (adopts R1)

1. **LAN WebTransport over HTTPS with certificate-hash pinning, one port.** The server mints an ECDSA P-256 cert at
   start (≤ 14 days, SANs = host LAN IPs) and serves the page over HTTPS (TCP) and WebTransport (UDP) on the same port
   number; the client pins it with `serverCertificateHashes`. Reason: plain `http://<LAN IP>` is not a secure context,
   so `new WebTransport()` throws there. Cost: one certificate click per teammate.
2. **Plain-HTTP WebSocket fallback with a visible banner** when WebTransport is not available.
3. **gc-WASM, not TinyGo**, plus a native-vs-WASM sim hash test.
4. **In-process conditioner first.** `tc netem` is Linux-only and the host is macOS; netem.sh stays CI-only.

## 2026-11-23 — core: M0/M1 implemented; transport ruling and changes found while building

12. **Transport (lead ruling, from research R1).** Plain `http://<LAN-IP>` is not a secure context, so browsers
    refuse WebTransport there. The server mints an ECDSA P-256 self-signed cert at start (10-day validity, under the
    14-day limit; SANs = localhost, 127.0.0.1, ::1 and every non-loopback interface IP). It serves the page over HTTPS
    on TCP 8443 and WebTransport/HTTP3 on UDP 8443, and publishes the cert hash at `GET /certhash` (also
    `/api/certhash`) for `serverCertificateHashes`. Plain HTTP on 8080 serves the same page with WebSocket only;
    the client shows a "WebSocket fallback" banner there. Teammates click through one cert warning on 8443.
13. **Origin check.** WebSocket accepts any origin (the page can come from :8080, :8443, a LAN IP or the Vite dev
    server on :5173), and WebTransport `CheckOrigin` returns true. Reason: a LAN demo with no accounts. Lab changes
    still need the admin token.
14. **FMA (lead note).** The lead asked for `float64(a*b)+c` in `sim/`. `sim/` has no floats in `Step` at all
    (decision 1, fixed point), so fusion cannot happen. Float is used only to load the map and to convert for
    display. The sine table is generated source (`sim/sintab.go`), not computed at runtime.
    `make determinism` is the gate: arm64, amd64 and WASM produce identical hashes.
15. **Input pacing (B.4 rule 3) uses server feedback.** The client sends inputs on the synced clock
    (`net/clock.Pacer`): one per server tick, ahead by RTT/2 plus a margin. The margin grows by one tick whenever
    the snapshot's `own.starved` counter moves, and shrinks by 0.25 tick after each 10 s calm period. Reason:
    measured, a fixed one-tick margin still starved the server about once per 20 s on localhost, and every
    starvation caused one correction.
16. **Playout buffer primed at 2 inputs** (TargetInputBuffer 1 + 1) before the server starts consuming a new
    client's inputs. Reason: priming at 1 starved at once (measured 2–3 corrections per bot in 20 s).
17. **Snapshot carries `serverTimeMs` (f64) and the own input-buffer health** (`inputBuffer`, `starved`,
    `inputLead`). These are additions to B.5. Reason: the client maps tick ↔ time across tick-rate changes, and
    the pacer and the A.14 HUD need the starvation count.
18. **Server stats go on control JSON at 1 Hz**: tick time p50/p99/max, % within budget, tick start lateness,
    and per-client loss/RTT/buffer. Reason: JSON stays off the per-tick path (B.2).
19. **Ports: 8080 (HTTP + WS) and 8443 (HTTPS + WS + WebTransport).** The Vite dev proxy already points at :8080.
20. **The `dumb` mode is not a separate server mode.** P02 = `predict:false, reconcile:false, interp:false` with
    server authority. The server does the same work in every authoritative mode; only the client draws differently.
21. **Generated WASM files are not committed.** `make wasm` writes `client/public/sim.wasm` and `wasm_exec.js`
    (3.5 MB). `make dev` and `make client` build them first.

## 2026-11-23 — client: networking wiring (M0–M2)

1. **Inputs are sampled once per pacer tick inside the render frame.** Each frame asks the WASM pacer which ticks are
   due and samples input for each one. The sim still steps only in fixed ticks; the input is sampled at the next client
   frame, which is the "frame wait" segment of A.11.
2. **Dumb mode (predict off) keeps mouse look local.** Position comes only from the server (A.4), but the camera turns
   at once. A server-driven camera makes aiming unusable, and P02 measures movement ("input → motion"), not looking.
3. **HUD corrections and the input → motion median restart at every Lab change.** The predictor's counter is cumulative.
   P04's hard snaps would otherwise stay on screen when P05 should show 0.
4. **`?transport=ws` forces WebSocket** with the visible fallback banner, so the TCP path (P29) and the fallback can be
   shown and tested on a WebTransport-capable page.
5. **Scorecard Fair reads lagcomp together with its `built` flag.** The setting defaults to true but the server has no
   lag compensation yet, so Fair shows ✗ with "not built yet".

## 2026-11-23 — client: K2 (assets, presenter view, smoke test)

1. **Character models are scaled to the sim's player height at load** (the CC0 model is about 2.7 units tall).
   Hitboxes stay the sim's boxes, and the truth ghost draws those boxes as wireframes, so the model never stands in
   for a hitbox. Animations (idle/walk) advance on real frame time and are cosmetic only.
2. **Presenter view is an F2 overlay inside the normal client**, not a separate spectator. The server has no
   spectator join and does not relay other players' predicted positions. The view shows server truth (debug feed),
   what this client draws, and this client's own prediction, and labels the rest "needs server". Pause/step uses
   the last 2 s recorded by this browser until the server-side ring buffer (B.7) exists.
3. **The smoke test uses `playwright-core` with an explicit browser path** (`PW_CHROMIUM`, else Playwright's own,
   else the newest Chromium in the Playwright cache). This avoids a browser download and a version lock to one
   Playwright release. Headless Chromium refuses pointer lock, so the test sets the lock flag directly and sends real
   key events; the refusal is shown on the start screen instead of throwing.

## 2026-11-23 — client: own-view latency fix (P04 "reacts in the current frame")

Before: input → motion with prediction measured 17–44 ms (P05 18–33). A trace showed key → predicted step took 2–15 ms
(wait for the next fixed tick), then one more frame was lost: `ownView` interpolated between the last two predicted
ticks with alpha = (now − time of the frame that ran the tick) / tick, so that frame always drew alpha 0, the old state.
After: when the tick interval is ≤ the measured frame interval (64 Hz at 60 FPS) the newest predicted state is drawn;
slower ticks interpolate with alpha = how far the pacer clock is past the tick's due time (net/clock
TargetClientTick). Measured key → drawn: P05 1.4–16.4 ms, P04 1.6–16.4 ms, P02 (dumb) 81–115 ms; 20 Hz tick
2.9–48 ms (the tick wait itself). The HUD probe also checked "standing still" against the frame that already moved; it
now uses the previous frame and agrees with an independent trace to within 0.7 ms. The metric is unchanged.

## 2026-11-23 — duel: M8 duel mini-mode (P21–P23, duel half of P25)

1. **Own sim, own WASM binary.** `sim/duel` is integer-only (1 px = 256 units, 60 Hz, 53-byte state, FNV-1a 64 over
   the encoded state as the per-frame checksum). It builds to a separate `duel.wasm` (`wasm/duel`, global
   `NetcodeDuel`), so core's `wasm/main.go` and the shooter's `sim.wasm` are unchanged.
2. **Rollback, input delay and lockstep live in Go** (`duel.Session`), shared by the browser (WASM) and `bin/duelbot`.
   Save ring 600 frames, rollback cap 8 predicted frames (the peer waits at the cap and the HUD counts it),
   prediction = repeat the opponent's last confirmed input. GGPO-style time sync: every 60 frames a peer that runs
   ahead waits half the frame-advantage difference (≤ 4 frames), counted as "time-sync waits", not as stalls.
3. **"Ping" for auto D is the peer-to-peer RTT through the relay**, measured from echoed timestamps in every input
   packet during a 1 s ping-only warm-up and fixed at frame 0 (A.13: D is not lowered mid-match; it changes only on
   restart). The conditioner profiles apply per client and direction, like the shooter, so "Default (40 ms)" gives
   a peer RTT of about 80 ms (D = 0) and "Bad route" about 160 ms (D = 1).
4. **Lockstep uses D as its playout buffer.** Auto = ceil((RTT/2)/16.67 ms) + 1 frame, not A.13's rollback table,
   because lockstep must cover the whole one-way trip or it stalls every frame. Manual D overrides both modes.
5. **P25 duel inject is a seeded one-bit flip inside this peer's step** (bit 8–14 of one fighter's x, a few frames
   ahead), applied every time that frame is simulated here, including re-simulation, and never on the peer. A flip
   of the current state would be undone by the next rollback and would not model a nondeterministic sim.
6. **Relay = new package `server/duelrelay` plus its own binary `cmd/duelrelay`** (HTTP :8090 page + `/duel/ws`,
   HTTPS/WebTransport :8453 `/duel/wt`). No file in `server/*.go` changed and the shooter's Room and tick loop are not
   involved. Datagrams are forwarded through the sender's uplink and the receiver's downlink conditioner, with no
   playout buffer. Control JSON (join, start, restart, cond) bypasses the conditioner, so both peers start a match
   together. Core can mount the same handler on the game server with two lines; until then the duel runs on its own ports.
7. **Duel page has its own Vite config** (`client/vite.duel.config.ts`, `duel.html`, `src/duel/`), built to
   `bin/duel-www` and served by `bin/duelrelay`. The client's `vite.config.ts` and `main.ts` are unchanged; the
   page reuses `src/net/transport.ts` read-only.
8. **The sim pump runs from a worker timer** (4 ms), because a hidden tab's timers are throttled to 1 Hz and its peer
   would then wait at the rollback cap. Rendering stays on requestAnimationFrame. Demo with two windows side by side.

## 2026-11-23 — core: late ticks, root cause and fix (check 2)

22. **Late tick starts are host stalls, but the code turned them into corrections.**
    - Environment: an idle 64 Hz `time.Sleep` probe, with no server code in it, wakes up to 23 ms late at default
      QoS and 65 ms late at background QoS. This was measured at load average about 13 on 8 cores. The Go sleep is
      fine at p50 (0.9 ms). So the 47–206 ms stalls come from a saturated host, and no code removes them.
    - Code fault 1: `Run` dropped the missed ticks when it was more than 5 periods late. The server tick count then
      fell behind time, the clients' tick estimate jumped back, and their pacers stopped sending until the count
      caught up. The input buffer emptied and the server repeated inputs, which caused corrections. Fix: a
      fixed-timestep catch-up. Missed ticks run back to back, and the schedule resets only after a stall longer
      than 1 s (counted as `scheduleResets`).
    - Code fault 2: a tick with an empty buffer during or just after a stall repeated the last input. Inputs the
      client sent during the stall are still in the socket and the uplink conditioner. Fix: in a catch-up tick,
      or within uplink delay + jitter + 2 ticks after one, an empty buffer **holds** the player for that tick. It
      does not repeat the input and is counted as `heldOnStall` in the 1 Hz stats. Inputs stay strictly
      sequential, so holding cannot cause a misprediction. On-time ticks still repeat the last input and count
      `starved` (A.14). Starvation stays visible, and a genuinely late client still gets corrected.
    - Code fault 3: the pacer margin rose on every starvation and fell 0.25 tick per 10 s. One stall raised it
      by up to 5 ticks for about 3 minutes. Fix: at most one raise per second, and the margin falls 0.25 tick
      per 3 s calm.
    - Evidence (2 walker bots, default conditioner, server paused with SIGSTOP for 120 ms every 5 s, host load
      10–16): before the fixes 15 + 14 corrections in 40 s; with catch-up only 8 + 7; with catch-up and hold 0 + 1.
      The remaining starvation was 4 s after the last injected stall, when the bot process itself was late.
      Stats also report `tickStartLate.catchUpTicks`.

## 2026-11-23 — core: M3/M4 server (shooting, lag comp, trust mode, rounds)

23. **One ShotResult event per shot carries everything about it**: hit confirm, miss reason (P08), red and blue
    boxes (P09) and the P11 timestamps (`recvMs`, `tickStartMs`). The shot id is the fire input's seq (research
    R3). Reason: one shot needs one record, and the client can join the timestamps on the shot id.
24. **The server computes both "what the shooter saw" and "what was used" for every shot**, even with lagcomp off.
    It traces at the render time and at the time used. Reason: P08 needs the reason "target moved N cm", and that
    is only measurable if the server knows what the shooter was rendering.
25. **Events are resent in every snapshot until a SnapshotAck covers them, for at most 3 s.** Reason: snapshots are
    unreliable datagrams, and a lost hit confirm or death would break the HUD. JSON would put them off the game
    path, against review's guard (P11 timing must stay on the conditioned path).
26. **Kill feed, round state, scoreboard and claim rejections are control JSON.** They are reliable, not
    time-critical, and broadcast to everyone.
27. **Shot origin = shooter state after applying the fire input, at eye height.** The client draws its predicted
    state after the same input, so the ray starts where the camera is.
28. **No friendly fire**: the ray passes through teammates. Reason: team deathmatch for 2–10 colleagues; friendly
    fire would punish people learning the controls.
29. **Trust mode keeps inputs flowing** (acks, pacing) but takes the position from type-7 claims and applies claimed
    hits unchecked. The modded client is just a client sending claims. Reason: A.5 says the two packets "look
    identical", so the server must not tell honest from modded claims apart.
30. **Dead players' inputs are consumed but do not move them. `own.life` increments on respawn.**
    `Predictor.ReconcileLife` does not count corrections while dead or across a life change. Reason: a respawn
    teleport is intended, so B.9 check 2 must not count it.
31. **Round and respawn timers use server milliseconds, not ticks.** Reason: they survive a live tick-rate change.
32. **History ring: 512 ticks**, covering the 1 s lag-comp cap even at 128 Hz (and the presenter's 2 s at
    ≤ 128 Hz with 512 entries ≥ 256). Only player positions are kept, never the map (A.10).
33. **Presets apply the conditioner too.** P24 sets 50 ms each way (RTT 100 ms, labelled simulated in its banner)
    so "died behind the wall" is visible. Every other preset restores 20 ms each way.
34. **`speedScale` is a server-only Lab setting** (0.25–2). It serves the second half of B.9 check 2 and P25.

## 2026-11-23 — core: M3 rulings (lead rulings a–e) and pacer drain

35. **(a) Rewind target** = the client-sent `renderTick + renderFrac/65536`, clamped to
    `[resolveTick − historyMs·rate/1000, resolveTick]`. A clamped shot is resolved and flagged, never rejected.
    `renderTick = 0` means "not sent" and resolves at the current tick. (HANDOFF B.4 rule 5.)
36. **(b) Favour the victim**: setting `favorVictimRttMs`, 0 = off (default). When it is > 0 and the shooter's
    RTT is above it, that shot is not rewound (flag `favoured`). The RTT is the shooter's own clock-sync RTT from
    `{t:"report"}`, or the server's ack RTT if none was reported. Reason: A.10 names this mitigation but gives no
    number. An off-by-default threshold the presenter can raise in P24 shows the trade-off without changing the
    other presets.
37. **(d) Hitbox priority and self-exclusion.** The ray takes the **nearest** box hit, head or body, and stops
    at the first map box. Head wins only when its entry point is nearer, as when a shot comes from above. The
    shooter's own boxes and teammates are never tested. Reason: nearest-first is what a ray does. "Head over body"
    would let a shot through the chest count as a headshot.
38. **(e) P08 "target moved N cm"** = the distance between the target's position at the shooter's render time and
    its position at the time the server used: the resolve tick when lagcomp is off, the render time when it is on.
    It is computed for the player the ray hits at render time (`seenId`). Both positions come from the server's own
    history; the client's numbers are not used. Reason: it is exactly the "two moments" of A.10, and both are
    server-measured.
39. **(c) B.9 check 3 integration tolerance, fixed before the run.** Two bots, default conditioner (RTT 40 ms
    simulated), 64 Hz, 20/s, interp 100 ms. The target crosses the gap; the shooter aims at the target's
    **rendered** (interpolated) body centre and fires. For each shot the bot computes "what I saw" with
    `sim.RayPlayer` against the rendered position and compares it with the server's `hitId`.
    - Pass: **at least 300 shots** with lagcomp on, and **≥ 97 % agreement** between the shooter's verdict and the
      server's.
    - Also report the same agreement with lagcomp off, with no pass bar. It is expected to be much lower; that is
      the P08 demonstration.
    - Allowed disagreement sources: the client interpolates between snapshots 3–4 ticks apart, while the server
      interpolates between consecutive ticks, so positions differ while the target accelerates. That matters only
      for grazing shots within a few cm of a box edge. Shots the server flags `clamped` count as disagreements.
    Reason: 3 % covers the edge cases; a larger gap would mean the rewind is wrong.
40. **Pacer drain**: after 2 s without a starvation the margin falls by one tick per second to the 1-tick minimum.
    The first starvation of a session raises it too (no first-second blind spot). One stall still raises at most
    once per second. Unit test: 6 → 1 within 8 s on a calm feed
    (`TestPacerMarginRaisesAndDrains`). Reason: research R5 measured 183 ms dumb-mode input → motion against the
    A.4 estimate of 40–72 ms; a margin stuck at 6 ticks adds about 94 ms at 64 Hz.

## 2026-11-23 — duel: review V5/V8 fixes

1. **Facing reads start-of-frame positions** for both fighters (`sim/duel/duel.go`), so the step no longer depends on
   which fighter is processed first. The recorded determinism trace hash did not change (a49b4b920738736c): that
   stream never hit the order-dependent case; `TestFacingOrderIndependent` covers it.
2. **Long stalls cannot overwrite the input ring.** D is capped at `MaxDelay` = 60, local inputs are at most D+1
   frames ahead, and remote inputs more than RingN/2 frames ahead of the current frame are ignored.
   `TestLongLockstepStall` silences one peer for 1000 slots and resumes in sync.
3. **The seed travels as a decimal string** (relay `start.seed`, WASM `newSession`, bot), never as a JSON float,
   and the desync banner, the HUD and `duelbot` output show it, so a P25 flip is reproducible.
4. **No code was copied from the feat/netcode-lab-dsh worktree** (commits 5f895f4, b83cb85); `sim/duel` here was
   written in this branch.
5. **`duelrelay.Mount`** registers `/duel/ws`, `/duel/wt` and the page under `/duel/` on another mux, for core to
   call from the game server. Until then the duel stays on the relay's own ports.

## 2026-11-23 — core: C3 (M5/M6 server side)

41. **WebSocket loss model (P29), simulated, replaces decision 8's "200 ms + 2 × delay".** Ordered links are a FIFO
    with head-of-line blocking. A lost segment is retransmitted on the earlier of two events:
    - fast retransmit: 3 duplicate ACKs, so delivery = send time of the 3rd later segment + RTT + one-way delay;
    - Linux-style RTO = RTT + max(4·jitter, 200 ms); delivery = loss time + RTO + one-way delay.
    RTT is the sum of both directions' conditioner delays. Everything behind the lost segment waits. Duplication
    and reordering are ignored on a stream. Reason: snapshots at 20/s give 3 dup ACKs in about 150 ms, so most
    losses recover by fast retransmit (about 210 ms at 40 ms RTT), not RTO. A flat 200 ms + 2 × delay
    overstated some stalls and understated others. Stats per link: `retransmitted`, `fastRetransmits`, `rtos`,
    `maxStallMs`. Unit test `TestOrderedFastRetransmitBeatsRTO`.
42. **Cost meters count payload bytes** (snapshot, pong and debug datagrams after the downlink conditioner, plus
    control JSON). WebSocket/QUIC framing is not counted and is labelled so. Reason: framing differs per transport
    and is not something the server can see.
43. **The P15 formula column is computed by the server** for each client (`budgetEst` in stats). It uses the room's
    settings and that client's simulated conditioner delays, with each "wait for next X" = half its period, as
    in A.11. Labelled `est.`. The measured column comes from the P11 traces on the client.
44. **P11 target half travels as control JSON** (`shotSeen` from the target → `shotTrace` to the shooter). Reason:
    these are measurements after the fact, not game state. The timings themselves were taken on the
    conditioned game path (event in snapshot, receive time on the target's synced clock).
45. **P19 loop toggle**: `loop: zeroalloc | naive`, same bytes on the wire. The zero-alloc buffer pool is a mutex
    stack, not `sync.Pool`, because putting a slice into `sync.Pool` boxes it and allocates. Entities are sorted
    by id so the bytes do not depend on Go map order (also needed for P27 delta).
46. **P26 default is sub-tick on.** The client stamps the render time at the click, so the default game resolves
    the shot at the click. The P26 preset turns it off to show the cost of tick quantisation: the shot is timed
    at the tick end, `(1 − subtickFrac)` ticks after the click, up to 15.6 ms at 64 Hz. The timing error is
    reported per shot and as whole-window histograms per mode. Banner: sub-tick is not 128 Hz (A.15).
47. **P28 interest grid**: square cells (default 8 m, `interestCellM`), window = own cell + 8 neighbours, floor
    division so cells around 0 are not double width. Spectators always get every player. Lag compensation is
    unaffected (server history).
48. **P27 compression**: one bit-stream codec with per-mode widths. Quantised: 1/256 m in ±32 m, y as y + 1 m in
    0..8 m, 8-bit angles. Delta: per-entity change mask (pos / angles / misc), only against the client's acked
    `snapId`, fewer than 200 snapshots old, sent in the same encoding. A missing baseline is an error, never a
    guess. Own state stays exact (review guard: reconciliation compares it bit for bit). The meters measure all
    four encodings for every snapshot, whatever is active, so the presenter compares without switching.
    Measured in `TestEntityEncodings`, 10 entities, whole packet: raw 266 B, quantised 186 B, quantised +
    bit-packed 161 B, delta at rest 67 B, delta moving 127 B.
49. **Presets marked built in C3**: P12, P13 (rates and FPS change, formula ~103 / ~71 ms est.), P26, P27, P28.
    P11, P15, P19 and P29 stay `built:false`: their server data exists, but nothing shows it on screen yet.

## 2026-11-23 — duel: M7 infrastructure (P16–P18, P20)

1. **Regions are three game Rooms in one process** (`server/regions`), at `/r/{hcm,hn,sg}/ws|wt`. The route of a
   player (region × ISP × last mile × direct/relayed) is applied by a wrapping `transport.Conn` that injects a
   self `cond` control right after the join, so the Room's own per-client conditioner carries it and `room.go`
   needs no region hook. A cable cut re-injects the route on every live connection to sg. All route values are
   simulated settings (A.16), illustrative and taken from A.12's anecdotal ranges; RTTs shown or exported are what
   clients measure over them.
2. **Beacon** = `/beacon/{region}/wt` (QUIC datagrams; `/ws` fallback where loss becomes a TCP stall) that echoes
   each datagram through the route's conditioner both ways. The client sends one control message first: a
   WebTransport control stream reaches the server only once something is written on it. 10 pings, median.
3. **Matchmaker** (`server/matchmaker`) is in-process in `cmd/infra` and standalone in `cmd/matchmaker`, same JSON.
   Default 60 ms relaxing to 100 ms after 10 s (A.12 says 20–30 s is "sensible, not benchmarked"; 10 s keeps the
   demo short, `-relax-after` changes it). Regions in the RTT map without a fleet are ignored and named in the
   ticket (A.12's pitfall). One ticket matches alone: there is no team-size wait.
4. **P18 relayed routes** are route options (`relay-public`, `relay-backbone`) on the same conditioner; `cmd/relay` is
   also a real UDP relay with the same two simulated profiles for B.8.
5. **Metrics** (`server/promx`, client_golang v1.23.2, the newest that adds no upgrade to existing deps): RTT and
   jitter histograms and probe/loss counters by region × ISP × platform, from beacon reports and from the game
   clients' own `report` messages in region rooms; cable-cut gauge; matchmaker counters; Go runtime. Exposed at
   `/metrics` on `cmd/infra`. The shooter Room's tick histograms are not exported yet (needs a hook in core's code).
6. **Alert** `ISPRouteP95High`: p95 RTT of one region × ISP > 150 ms for 1 min (Prometheus rule, shown on the
   Grafana dashboard). 150 ms sits above the worst p95 without a cut in our runs (with 15% Wi-Fi and 5% bad-line
   players) and below sg's p95 during the simulated cut.
7. **`cmd/infra` runs next to the game server** (ports 18720/18721) until core mounts `regions.Manager.Mount`,
   `matchmaker.MM.Mount`, `promx.Handler` and `duelrelay` in `server/http.go`. docker compose runs both processes.
50. **Pacer probe floor** (amends 40). If a starvation comes within 4 s of the margin being lowered to L, the
    pacer does not lower it to L again for 30 s. Reason: bots measured a WebTransport bot correcting every
    ~3.1 s after a stall burst (MEASUREMENTS "Check 2 at HEAD"): drain to 1, starve, raise, drain. On a host that
    needs 2 ticks this oscillates forever, and each cycle is a correction. `TestPacerDoesNotOscillate`: the old
    rule gave 44 raises in 110 s, the new one 3. A single stall on a calm host still drains to 1 tick within
    8 s (`TestPacerMarginRaisesAndDrains`).
51. **Inputs play at their stamped tick; the pacer targets measured lead** (amends 7, 15, 40, 50; research R6).
    - Cause of the margin at the ceiling: the server consumed inputs in sequence and ignored `clientTick`. It also
      consumed two per tick whenever more than 3 were queued. A margin above about 3 ticks therefore added no
      buffer: the server drained it back to 3. Every late input (frame-bunched sends, client stalls) raised the
      margin again, so it ratcheted to 6. The inputs queued by the high margin are the hold research measured.
    - The host's late wakeups did not count as starvation (decision 22 holds those ticks). The client's own late
      frames do count: an input that really arrives late is a starvation (A.14).
    - Server: an input stamped for a later tick waits in the buffer (`waitedEarly` in stats). An overdue one is
      played, plus one more in the same tick to catch up. A missing input whose tick has not come yet is not a
      starvation. A missing input whose tick has come is: repeat the last input and count it. Stamps far off
      (no clock yet, more than 8 ticks late or 16 early, e.g. after a rate change) fall back to sequential play.
    - Snapshot `own.inputLead` is now the **smallest** arrival lead since the previous snapshot (stamped tick −
      server tick at arrival; 1 = just in time), not the newest one's.
    - Pacer lead mode (`OnServerLead`, WASM `pacerFeedback(pacer, starved, now, own.inputLead)`): raise on
      starvation as before. Lower one tick when every lead in the last 2 s was ≥ 2. The margin may go down to −4,
      because RTT/2 and the clock offset are estimates. It settles at the smallest margin that still leaves one
      tick of slack. Tests: from 6 on a clean link it reaches lead 1 in 12 s with 0 starvations; on a host
      needing 3 ticks of slack it settles at lead 3 with 3 raises in 90 s, not at the ceiling.
    - The old `OnServerFeedback` path (calm drain) stays for clients that do not pass the lead.
    - Live 60 s runs on this Mac at load average 26–47 (2026-11-23 20:08–20:14) are **inconclusive**. Both rules
      climbed to 5–6 because inputs arrived up to 13 ticks after their stamp (lead −13), which no margin rule
      absorbs. The quiet-host before/after run is still owed (MEASUREMENTS).

## 2026-11-23 — duel: D3 presenter panel for P11, P12, P15, P19, P29

1. **One panel, one mount call.** `client/src/hud/perf.ts` exports `mountPerf(session, hud)`. It wraps only public
   hooks (transport `onBinary`/`onControl`/`sendBinary`, `session.onSnapEvent`) and always calls the previous
   handler, so it needs one line in `main.ts` (client's file) after the page sets its handlers. F3 toggles it; it
   also opens on P11, P12, P15, P19 and P29.
2. **P11 segments are cut at measured instants on the server clock**: click → first input packet carrying the fire
   (shooter clock) → `recvMs` → `tickStartMs` → first snapshot carrying the ShotResult → target receives the Damage
   event → the target frame whose render time reached the shot's tick. The target splits its part into interpolation
   and frame wait (how long the shot had been renderable when the frame drew it) and sends `shotSeen`. Each client
   maps its clock to the server's from pongs (median offset of the lowest-RTT half of 16), independently of the WASM
   clock. Only hits get the target half; misses show the shooter half and stay out of the average of 20.
3. **The downlink segment starts at the shooter's snapshot send time.** The target's snapshot send time is not in
   `shotSeen`; all clients get a snapshot on the same tick, so the two differ by the send schedule only.
4. **P15 tolerance**: the total within ±15% (B.9 check 4); a segment is flagged beyond max(15% of the formula, 3 ms)
   and shows why the formula and the measurement differ (for example the server's input buffer in "tick wait").
5. **P19 shows tick-time percentiles, not buckets**: the server sends p50/p95/p99/p999/max for the whole window.
   The panel keeps the last numbers seen per loop mode so the two loops can be compared after a switch.

## 2026-11-23 — scribe (lead-approved): P22 "Observe" reads what is measured

52. **P22 shows depth and frames rolled back, not "fewer rollbacks", as the effect of input delay below the one-way
    trip** (deviates from the HANDOFF B.6 P22 Observe text "Higher D gives fewer rollbacks"). Measured: the rollback
    count stays near the opponent's input-change rate (≈ 9/s) until D covers the one-way trip (≈ 2.5 frames at 82 ms
    peer RTT), then collapses; frames rolled back and depth fall with every frame of D. Evidence: MEASUREMENTS "Duel
    (P21–P23, P25)", Default route: "rollback D2: 9.07 / 8.33 rb/s, 11.0 / 9.1 fr/s", "rollback D3: 0.70 / 2.20 rb/s,
    0.7 / 2.2 fr/s"; scribe's duel-page walk at `4b5a2e6` (DEMO.md P22): D 0→4 gave 7.4, 8.9, 8.9, 0.7, 0.3 rollbacks/s
    and 23.7, 18.4, 11.7, 1.3, 0.4 frames rolled back/s. Reason: A.13 says input delay hides the first part of the
    trip and rollback corrects the rest; the count only drops once nothing is left to correct. DEMO.md P22 tells the
    presenter to point at frames rolled back and depth, and at the count's drop once D ≥ 3 on the default route.
53. **Zero-alloc loop covers the receive path too** (P19; bots measured 1117 MB allocated in ~100 s with 50 bots
    at 128 Hz in zeroalloc mode). Live profile, 20 bots, 12 s window (`bin/server -pprof`, `/debug/pprof/allocs`
    diff): 29.6 MB before, 7.2 MB after.
    - WebSocket binary messages are read into pooled buffers (`transport.PutBuf` from the uplink conditioner's
      Release). The connection loop reads with a non-cancellable context, because coder/websocket otherwise sets
      up a per-read timeout (`context.AfterFunc`) on every message. Together these were about half of all bytes.
    - The ordered conditioner shifts its short FIFO down instead of re-slicing (re-slicing forced reallocations).
    - Input packets decode into a per-client scratch.
    - Left on purpose: 1 Hz stats JSON (control path), first fill of the delta-baseline slots and buffer pools
      (warm-up), and quic-go's own copy per WebTransport datagram.
54. **P04 scorecard: Instant needs prediction and reconciliation** (lead ruling, 2026-11-23). The sources
    disagree:
    - HANDOFF A.6, prediction alone: "Scorecard: Instant ✓, Cheat-proof ✓."
    - The A.10 summary table: "Instant | prediction + reconciliation".
    - B.6 P10: "All green only with predict, reconcile, interp, lagcomp and authority on".

    The rule stays `instant = predict && reconcile` (with authority server; trust mode is instant by itself).
    Instant = predict alone would turn all four cells green with reconcile off, which contradicts P10. A.7 gives
    the reason: without reconciliation the client "jerk[s] the character back" on every answer, so the input is
    not felt as instant. The P04 banner says so: "Instant also needs reconciliation (A.7): with it off, every
    snapshot snaps you back". Test: `TestScorecardAllCombinations`.
55. **P26, P27 and P28 back to built:false** (lead ruling). B.6's Observe for each is a meter on screen
    (timing-error histogram, kbps meters, entities/bytes per client). The server data exists, but client's
    panels do not yet. They flip after each panel is verified end to end.

## 2026-11-23 — bots (lead ruling): B.9 check 6 counts stalls, not loss gaps

1. **Threshold stays literal; every gap over it is classified by snapshot ids.** B.9 #6: "with 5% loss, WebSocket
   mode shows inter-arrival stalls longer than 3× the send interval; datagram mode does not." The threshold stays
   3 × 50 ms = 150 ms at 20 snapshots/s. Each snapshot inter-arrival gap above it is classified by the per-client
   snapshot id (`snapId`, 1..255, +1 per snapshot sent to that client, server/room.go):
   - **Loss gap:** ids are missing in the gap. The data is gone and newer data arrives on time.
   - **Stall:** no id is missing. The data was delayed and held back.
   The check is judged on **stalls**; loss gaps are reported beside them, per transport.
   Reason, A.15:
   - "TCP delivers in order. If packet 2 is lost, packets 3, 4 and 5 wait for its retransmission (head-of-line
     blocking)."
   - "A stale snapshot is worthless once a newer one exists, so snapshots do not go over TCP. UDP delivers whatever
     arrives."
   A loss gap is that datagram behaviour; a stall is head-of-line blocking. At 64 Hz and 20/s the send schedule
   alternates 46.9 and 62.5 ms gaps, so two consecutive datagram losses already exceed 150 ms. Without the
   classification, loss gaps would be counted as stalls.
   Code: `snapIDsMissing` in cmd/bot/main.go (test cmd/bot/gap_test.go); `scripts/p29-transport.sh` prints both counts.
56. **TCP model: a lost retransmission backs off** (amends 41; found verifying P25). Each retransmission crosses
    the same simulated path, so it is lost again with the current loss rate, and the RTO then doubles (capped at
    2 s; counted as `backoffs`). Reason: with "the retransmission always arrives", a 400 ms 100 %-loss burst on a
    WebSocket client let snapshots through after about one RTO. Review measured a 199 ms gap where a real TCP
    stream stalls for the whole outage and then for the backoff. Datagram (WebTransport) links are unchanged:
    a burst simply drops everything. Test: `TestOrderedOutageBacksOff`.
57. **One tick of grace for a late input** (B.9 check 2; bots' quiet-window run at dad056d: exactly 1 correction
    per bot, about 6 s after join, on WS and WT).
    - Why the probe starved: the server reports lead in whole ticks, and lead 1 means anywhere from 0 to 1 tick
      of real slack. The lead pacer (decision 51) lowers its margin while every lead in the window is ≥ 2, so it
      settles at lead 1, which the measurement allows. A rare jitter spike that the 2 s window never saw (bots'
      probe saw host lateness up to 20 ms ≈ 1.3 ticks) then pushed one input past its tick. The server repeated
      the last input, and that was one correction. No pacer rule based only on what it has seen can rule out an
      unseen spike without keeping about two ticks of margin for ever.
    - Rule: when the input a tick needs is missing, the server first **holds** that player for one tick
      (`LateGraceTicks` = 1, counted as `heldLate`). Inputs stay strictly sequential, so the client's prediction
      still matches and nothing is corrected. When the late input arrives it plays, together with the next due
      input, which puts the schedule back. Only if the input is still missing on the next tick does the server
      repeat the last input, count `starved` and cause a correction (A.14). The grace is once per gap: in a long
      outage every further tick repeats.
    - The pacer still sees a late hold: snapshot `own.starved` = repeats + late holds, so it raises its margin
      and sets the 30 s floor as before. Stats report `starved` and `heldLate` separately.
    - Cost: a held player stands still for one tick (15.6 ms at 64 Hz) on other screens. That is smaller than
      interpolation can show and far smaller than a correction on the owner's screen.
    - Tests: `TestLateInputHeldNotRepeated` (held, then the late input plays and the state equals the client's
      sequential prediction; a long gap repeats), plus the updated `TestScheduledPlay` and
      `TestCatchUpHoldsOnTimeStarves`.
