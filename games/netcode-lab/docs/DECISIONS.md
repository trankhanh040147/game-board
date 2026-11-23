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
