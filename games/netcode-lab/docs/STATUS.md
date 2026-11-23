# Status

Updated 2026-11-23 by scribe, from the lead's board. Read this first after a context compaction.

## Members

core (claude), client (claude), review, research (hermes), art (antigravity), bots (claude), scribe (claude).

## Board

| ID | Member | Task | State | Evidence |
|----|--------|------|-------|----------|
| R1 | research | LAN transport, WASM, macOS limits | **done** | Verdict: HTTPS + certhash on a single port for LAN WebTransport; plain-HTTP WebSocket fallback with a visible banner; gc-WASM (no TinyGo); in-process conditioner first, because macOS has no `tc netem`. |
| C1 | core | Go sim, net, server, WASM (M0/M1) | in progress | Done so far: `23fa0b7` sim, `371a5a6` net, `46b3c52` server + WS/WT + walker bot, `0062678` WASM API + determinism check + Makefile, `be08946` WT dial with cert-hash pin for bots. |
| K1 | client | Browser client | wiring networking now | Done: `3b911b9` loop/input/render/HUD/Lab, `b4a0ac0` unit tests. |
| V1 | review | Review the commits above and run the tests | in progress | — |
| R2 | research | Tick-health / zero-alloc proposal (P19, B.9 check 5) | in progress | — |
| A2 | art | CC0 player and rifle models, map textures | in progress | A1 done earlier: `f169724` CC0 sound effects. |
| B1 | bots | cmd/bot, load/peek/check harnesses: run B.9 check 2, build the load harness | in progress | — |

### Unreviewed commits

Not yet reviewed or verified by the lead. Keep listed until the lead says otherwise.

`f169724`, `23fa0b7`, `3b911b9`, `b4a0ac0`, `371a5a6`, `46b3c52`, `0062678`, `be08946`.

## Lead decisions

- Transport: adopt R1 verdict.
- claude quota reset 17:00 Asia/Saigon on 2026-11-23 cut core/client/scribe turns; continuations queued.
- Whenever a member goes idle, give it the next useful task.

## Open risks

- 50-bot 128 Hz test is the top open risk (R1): run it in-process and report the result honestly.
- `tc netem` is Linux-only; netem.sh can run only in CI. The demo uses the in-process conditioner.
