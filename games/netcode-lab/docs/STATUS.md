# Status

Updated 2026-11-23 by scribe, from the lead's board. Read this first after a context compaction.

## Members

core (claude), client (claude), review, research (hermes), art (antigravity), bots (claude), scribe (claude).

## Board

### Done

| ID | Member | Task | Evidence |
|----|--------|------|----------|
| R1 | research | LAN transport, WASM, macOS limits | Verdict: HTTPS + certhash on a single port for LAN WebTransport; plain-HTTP WebSocket fallback with a visible banner; gc-WASM (no TinyGo); in-process conditioner first, because macOS has no `tc netem`. |
| C1 docs | core | ARCHITECTURE, PROTOCOL, check 1 | `edf1e65`: ARCHITECTURE/PROTOCOL; B.9 check 1 (determinism) pass. |
| K1 | client | Client loop/HUD/Lab + networking | `3b911b9`, `b4a0ac0`, `dfaeacb` (WebTransport + WebSocket fallback, WASM prediction/reconciliation, interpolation, Lab wired). |
| A1 | art | CC0 sound effects | `f169724` |
| A2 | art | CC0 player/rifle models, map textures | `31b586b` |
| R2 | research | Tick-health / zero-alloc proposal (P19, B.9 check 5) | Proposal routed to core. |
| S1–S3 | scribe | STATUS, DEMO skeleton, CONCEPTS, README, presets.json | `bdaa72b`, `fc23a53`, `dc74641`, `e1d1883` (README), `56de3a9` (presets.json) |
| S4 | scribe | DEMO.md walk of P01, P02, P04–P07 in Chromium | `5af19ac`: P01, P02 verified; P07 verified through settings (ghost lead 120 ms); P04 partly (input → motion 44 ms); P05 partly (corrections 4, not 0); P06 partly (stepping not checked visually). |

### In progress

| ID | Member | Task | Notes |
|----|--------|------|-------|
| C1 | core | Go sim, net, server, WASM (M0/M1) | Turn still running. Committed so far: `23fa0b7` sim, `371a5a6` net, `46b3c52` server + WS/WT + walker bot, `0062678` WASM API + determinism check + Makefile, `be08946` WT dial for bots. |
| K2 | client | Assets, presenter view, Playwright | — |
| V1 | review | Root cause of corrections in B.9 check 2 | — |
| R3 | research | Budget / peek measurement design | — |
| A3 | art | VFX, sky, 2 sfx | — |
| B1 | bots | B.9 check 2 run + load harness | Uncommitted files in `cmd/bot` and `scripts/`. |

### Unreviewed commits

Not yet reviewed or verified by the lead. Keep listed until the lead says otherwise.

`f169724`, `23fa0b7`, `3b911b9`, `b4a0ac0`, `371a5a6`, `46b3c52`, `0062678`, `be08946`, `dfaeacb`, `31b586b`, `edf1e65`.

## Lead decisions

- Transport: adopt R1 verdict.
- claude quota reset 17:00 Asia/Saigon on 2026-11-23 cut core/client/scribe turns; continuations queued.
- Whenever a member goes idle, give it the next useful task.

## Open risks

- 50-bot 128 Hz test is the top open risk (R1): run it in-process and report the result honestly.
- `tc netem` is Linux-only; netem.sh can run only in CI. The demo uses the in-process conditioner.
