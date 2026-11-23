# A.16 honesty audit

Read at `bfce3d7` (2026-11-23) by scribe. Scope: every number or label a player or presenter can see, from
client/src and server/. Rule (HANDOFF A.16, CONCEPTS.md#a16): estimates are labelled `est.`, public figures `ref`,
simulated infrastructure **simulated**; the game's own measurements may be shown unlabelled.

Main finding: the server applies a **simulated 20 ms + 20 ms conditioner to every client by default**
([server/room.go:34-36](../server/room.go), `DefaultCond`, applied at join in room.go:478-479). So every
latency the client measures includes simulated delay. The values are real measurements of the path, but on a LAN
about 40 ms of the 41 ms RTT is simulated, and the HUD labels it only "measured".

## Flagged rows

| # | Where (file:line) | What the viewer sees | Source | Current label | Problem | Owner | Suggested fix |
|---|---|---|---|---|---|---|---|
| F1 | [client/src/main.ts:258](../client/src/main.ts) | Net graph "RTT 41 ms" | measured by client (clock sync pings) over a path with the simulated conditioner | `measured` | Includes 40 ms simulated delay by default; not labelled simulated | client | When `s.cond` delay/jitter/loss ≠ 0, label `measured · incl. simulated <up+down> ms` |
| F2 | [client/src/main.ts:259](../client/src/main.ts) | Net graph "jitter N ms" | measured by client | `measured` | Includes simulated jitter when a profile sets it (Bad route: 15 ms) | client | Same suffix as F1 when `s.cond` jitter ≠ 0 |
| F3 | [client/src/main.ts:260](../client/src/main.ts) | Net graph "loss up/down N / N %" | measured by client (sequence gaps) | `measured` | Losses are produced by the simulated conditioner (Bad route 1%) | client | Same suffix when `s.cond` loss ≠ 0 |
| F4 | [client/src/main.ts:263](../client/src/main.ts) | Net graph "max snapshot gap N ms" | measured by client | `measured` | Gaps under jitter/loss come from the simulated conditioner | client | Same suffix as F1 |
| F5 | [client/src/main.ts:292](../client/src/main.ts) | Mode HUD "input → motion: 103 ms (measured, median of 6)" (P02) | measured by client | `measured` | About 40 ms of it is simulated delay | client | `(measured, incl. simulated 40 ms RTT, median of K)` |
| F6 | [client/src/main.ts:299](../client/src/main.ts) | Mode HUD "truth ghost leads what you see by 120 ms (measured: …)" (P07) | measured by client | `measured` | The 20 ms downlink part is simulated | client | Same suffix as F5 |
| F7 | [client/src/hud/presenter.ts:112](../client/src/hud/presenter.ts) | Presenter legend "(N ms in the past, measured)" | measured by client | `measured` | Same as F6 | client | Same suffix as F5 |
| F8 | [server/settings.go:143](../server/settings.go) | P01 banner "RTT, tick, snapshot and frame: 64 Hz server, 20 snapshots/s, 60 FPS, 40 ms RTT." | constant (A.1 running assumptions) | none | Running assumptions are estimates (A.16: label `est.`), and "40 ms RTT" is the simulated conditioner default | core | e.g. "… defaults: 64 Hz server, 20 snapshots/s, 60 FPS (settings); 40 ms RTT (simulated)." |

## Rows checked and OK

| Where (file:line) | What the viewer sees | Source | Label | Verdict |
|---|---|---|---|---|
| [client/src/main.ts:261](../client/src/main.ts) | "server tick 2069 @ 64 Hz" | server snapshot tick + setting | `server` | OK |
| [client/src/main.ts:262](../client/src/main.ts) | "snapshots 19.7/s (set 20)" | measured, with setting beside it | `measured` | OK (rate is not affected by delay) |
| [client/src/main.ts:264](../client/src/main.ts) | "interp buffer 100 ms (2× interval)" / "off (raw)" | setting | `setting` | OK |
| [client/src/main.ts:265-266](../client/src/main.ts) | "pending inputs", "corrections" | counted by client predictor | `measured` | OK |
| [client/src/main.ts:267](../client/src/main.ts) | "server tick time p99 N ms · N% ok" | reported by server (stats) | `server` | OK |
| [client/src/main.ts:268](../client/src/main.ts) | "server input buffer N (starved N)" | reported by server (own state) | `server` | OK |
| [client/src/main.ts:269](../client/src/main.ts), [:245](../client/src/main.ts) | "FPS 61 (16.7 ms)" | measured by client | `measured` | OK |
| [client/src/main.ts:270](../client/src/main.ts) | "kbps up/down" | measured bytes on the transport | `measured` | OK |
| [client/src/main.ts:279](../client/src/main.ts), [hud/widgets.ts:18-24](../client/src/hud/widgets.ts) | Scorecard cells and reasons | derived from active settings | "from active modes"; Fair notes "lag compensation not built yet" | OK |
| [client/src/main.ts:283](../client/src/main.ts) | "WebSocket fallback — …; game packets go over TCP." | transport state | — | OK (no number) |
| [client/src/main.ts:295](../client/src/main.ts) | "pending: #… · replayed: N · corrections: N (since last Lab change)" | client predictor | — | OK (counts) |
| [client/src/main.ts:298](../client/src/main.ts) | "others: interpolated 100 ms in the past" | setting (buffer) | unlabelled | OK under A.16 (a setting, not an estimate) |
| [client/src/hud/presenter.ts:96](../client/src/hud/presenter.ts), [:107](../client/src/hud/presenter.ts) | "server truth is N cm ahead", "last snapshot of you is N cm behind" | measured positions | unlabelled | OK (own measurement); distances grow with simulated delay but are not latency figures |
| [client/src/hud/presenter.ts:111](../client/src/hud/presenter.ts) | "PAUSED · frame k/n · N ms" | local recording | — | OK |
| [client/src/hud/lab.ts:104-118](../client/src/hud/lab.ts) | Conditioner readout and buttons "LAN", "Default (40 ms)", "Bad route (80 ms, jitter 15, loss 1%)" | setting | heading "My network conditioner (simulated)" | OK |
| [client/src/hud/lab.ts:82-92](../client/src/hud/lab.ts), [:142-166](../client/src/hud/lab.ts) | FPS cap, server settings with values | settings | key names, "not built yet" | OK |
| [server/settings.go:149](../server/settings.go), [:156](../server/settings.go), [:158](../server/settings.go) | P02, P04, P05 banners | constant text | — | OK (no figures) |
| [server/settings.go:61-74](../server/settings.go) | Setting notes (Lab tooltips) | constant | — | OK (no figures) |

## Not visible today (check again when they are rendered)

- [client/src/hud/presets.ts:6-34](../client/src/hud/presets.ts): the `line` texts are not rendered anywhere (`grep '\.line'` finds no use).
  Several carry default-setting figures that would need `est.` if shown: P06 "every 50 ms", P07 "about 100 ms", P02 "about one RTT".
- P11–P15 (budget, `est.` 190 ms column), P14 (Riot `ref`), P16–P18 (regions, ISP, cable cut: **simulated**) are
  not built. Their labels must follow A.16 when built.
