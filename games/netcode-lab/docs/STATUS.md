# Status

Updated 2026-11-23 (after aa01c11) by scribe, from the lead's board. Read this first after a context compaction.

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
| C2 | core | M3/M4 server, protocol v2 | `a8a83a5`, `f5f6d6f`, `a2afd2d`, `45e5986`, `6c49cde`, `cd2b3d2` |
| D1 | duel | Duel mini-mode M8 | `f4828bf` |
| K3/K4 | client | A.16 and review fixes, combat HUD, predicted shot cosmetics | `c250ab0`, `de633e5`, `6db531d`, `082b412`, `1ba7af5`, `7cbb3fd`, `e747422` |
| A4–A6 | art | Duel sprites; region map, logo, UI icons; key/mouse prompts | `fc2893a`, `2a993fd`, `ad6bda4` |
| V3–V10 | review | Reviews; V10: M3 checklist 10/14 pass | Reports delivered to lead. |
| S6–S9 | scribe | STATUS, B.9 table, PLAYTEST.md, README refresh | `d638d67`, `bbee2c5`, `56196a5` + `bd04544` (PLAYTEST), `8225bba` (README) |

### In progress

| ID | Member | Task | Notes |
|----|--------|------|-------|
| C3 | core | M5 + M6 | Committed since: `e398ce1`, `c0b9b6d`, `a9160d0`, `be6f729`, `a308c2b`, `8819ee7` (protocol v3), `7b1b19c` (not yet checked by scribe). |
| K5 | client | Wire the client to the current protocol | **Blocking:** at `aa01c11` the client expects WASM API v2 while `sim.wasm` is v3 (since `8819ee7`); browsers cannot join and the smoke fails (1 passed, 1 failed). |
| B3 | bots | Checks 2, 3, 5 and the peek test | — |
| D2 | duel | Then M7 | M7 infra/deploy already committed: `f4dd649`, `838102e`, `aa01c11` (not yet checked by scribe beyond `make infra` and `docker compose config -q`). |

The team is at its 8-member cap. The claude worker stall around 10:55 lost one round of turns.

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
- Ports and processes: each member uses only its own port range (scribe: 18500–18599). 8080/8443 are reserved for the
  human demo. Record the PID of every server, bot or relay you start and stop only those PIDs with `kill <pid>`;
  never `pkill`/`killall` by name. Before trusting a run, confirm your server lived for the whole run.

## Open risks

- 50-bot 128 Hz test is the top open risk (R1): run it in-process and report the result honestly.
- `tc netem` is Linux-only; netem.sh can run only in CI. The demo uses the in-process conditioner.
