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
