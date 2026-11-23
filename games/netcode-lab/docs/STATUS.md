# Status

Updated 2026-11-23 by scribe, from the lead's board. Read this first after a context compaction.

## Members

core (claude), client (claude), review (hermes), research (hermes), art (antigravity), bots (claude), duel (claude), scribe (claude).

## Board

### Done

| ID | Member | Task | Evidence |
|----|--------|------|----------|
| R1 | research | LAN transport, WASM, macOS limits | Verdict: HTTPS + certhash on a single port for LAN WebTransport; plain-HTTP WebSocket fallback with a visible banner; gc-WASM (no TinyGo); in-process conditioner first, because macOS has no `tc netem`. |
| C1 docs | core | ARCHITECTURE, PROTOCOL, check 1 | `edf1e65`: ARCHITECTURE/PROTOCOL; B.9 check 1 (determinism) pass. |
| K1 | client | Client loop/HUD/Lab + networking | `3b911b9`, `b4a0ac0`, `dfaeacb` (WebTransport + WebSocket fallback, WASM prediction/reconciliation, interpolation, Lab wired). |
| K2 | client | Assets, presenter view, Playwright smoke (B.9 check 7) | `9901c9c` assets, `275a14d` + `98b129d` presenter view, `498abeb` smoke; `9bde9f2` pointer-lock fix (drag-to-look fallback). |
| A1 | art | CC0 sound effects | `f169724` |
| A2 | art | CC0 player/rifle models, map textures | `31b586b` |
| A3 | art | VFX, sky, sfx | `bfce3d7` |
| B1 | bots | B.9 check 2 run + load harness | `5c4a0fd`: check 2 **fails** (WT 15 / WS 45 corrections, cause: host stalls); check 5 preliminary 99.92% / 99.93%. |
| V1 | review | Review of sim/net/server/bot/client/docs commits | Report delivered to lead. |
| V2 | review | Review of K2, `5c4a0fd`, A3 | Report delivered to lead. |
| R2 | research | Tick-health / zero-alloc proposal (P19, B.9 check 5) | Proposal routed to core. |
| R3 | research | Budget / peek measurement design | Report delivered to lead. |
| R4 | research | (see lead) | Report delivered to lead. |
| S1–S3 | scribe | STATUS, DEMO skeleton, CONCEPTS, README, presets.json | `bdaa72b`, `fc23a53`, `dc74641`, `e1d1883` (README), `56de3a9` (presets.json) |
| S4 | scribe | DEMO.md walk of P01, P02, P04–P07 in Chromium | `5af19ac`: P01, P02 verified; P07 verified through settings (ghost lead 120 ms); P04 partly (input → motion 44 ms); P05 partly (corrections 4, not 0); P06 partly (stepping not checked visually). |
| S5 | scribe | A.16 honesty audit | `a63ea17` (F1–F7 to client, F8 to core) |

### In progress

| ID | Member | Task | Notes |
|----|--------|------|-------|
| C2 | core | In order: tick-late root cause → P06/P07 built → M3 + M4 → stats and toggles | Resent at 10:17; the previous core turn was killed by the 15-minute idle watchdog during a Bash call. |
| K3 | client | Audit (F1–F7) and V2 fixes, P04 latency, P06 loss counter, preset banners | Committed so far, not yet checked by scribe: `c250ab0`, `de633e5`, `6db531d`, `082b412`, `1ba7af5`. |
| D1 | duel | Duel mini-mode (M8) | — |
| A4 | art | Duel sprites | — |
| B2 | bots | B.9 check 2 with host load recorded | — |
| V3 | review | Next review round | — |
| R5 | research | Measure P02, P07, P06 against Part A | — |

### Unreviewed commits

Not yet cleared by the lead. Keep listed until the lead says otherwise. Member review (V1, V2) is noted where it happened.

| Commits | Member review |
|---|---|
| `23fa0b7`, `371a5a6`, `46b3c52`, `0062678`, `be08946`, `dfaeacb`, `edf1e65` | V1 |
| `9901c9c`, `275a14d`, `98b129d`, `498abeb`, `5c4a0fd`, `bfce3d7` | V2 |
| `f169724`, `3b911b9`, `b4a0ac0`, `31b586b`, `9bde9f2`, `c250ab0`, `de633e5`, `6db531d`, `082b412`, `1ba7af5` | none recorded |

## Lead decisions

- Transport: adopt R1 verdict.
- claude quota reset 17:00 Asia/Saigon on 2026-11-23 cut core/client/scribe turns; continuations queued.
- Whenever a member goes idle, give it the next useful task.
- Members must cap long commands with a timeout.

## Open risks

- 50-bot 128 Hz test is the top open risk (R1): run it in-process and report the result honestly.
- `tc netem` is Linux-only; netem.sh can run only in CI. The demo uses the in-process conditioner.
