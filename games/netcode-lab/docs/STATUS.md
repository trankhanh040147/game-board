# Status

Updated 2026-11-23 by scribe, from the lead's board. Read this first after a context compaction.

## Board

| ID | Owner | Task | State | Evidence |
|----|-------|------|-------|----------|
| R1 | researcher (hermes) | LAN transport, WASM, macOS limits | **done** | Verdict: HTTPS + certhash on a single port for LAN WebTransport; plain-HTTP WebSocket fallback with a visible banner; gc-WASM (no TinyGo); in-process conditioner first, because macOS has no `tc netem`. |
| C1 | core (claude) | Go sim, net, server, WASM, bots, tests (M0/M1) | in progress | `131a701`: go.mod, shared/map.json, DECISIONS 1–11 only. The rest was cut by quota. |
| K1 | client (claude) | Browser client M0–M2 | in progress | `1fb0507`: Vite + TS scaffold only. |
| A1 | art (antigravity) | CC0 assets | in progress | — |

### Repo facts at HEAD that the board does not list yet

These commits exist at `371a5a6` and are newer than the board. They are not reviewed or verified by the lead.

- `f169724` assets: CC0 sound effects (A1).
- `23fa0b7` sim: fixed-point movement, swept AABB collision, hitboxes, predictor with reconciliation (C1).
- `3b911b9` client: fixed-timestep loop, pointer-lock input, Courtyard render, net graph, scorecard, Lab panel, interpolation buffer (K1).
- `b4a0ac0` client: interpolation and scorecard unit tests, client decisions 1–5 (K1).
- `371a5a6` net: binary codec with ack header, conditioner, clock sync, WebSocket transport (C1).

## Lead decisions

- Transport: adopt R1 verdict.
- claude quota reset 17:00 Asia/Saigon on 2026-11-23 cut core/client/scribe turns; continuations queued.

## Open risks

- 50-bot 128 Hz test is the top open risk (R1): run it in-process and report the result honestly.
- `tc netem` is Linux-only; netem.sh can run only in CI. The demo uses the in-process conditioner.
