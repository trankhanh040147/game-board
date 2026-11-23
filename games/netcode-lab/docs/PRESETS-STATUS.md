# Preset status (HANDOFF B.6), at 4b5a2e6, 2026-11-23

"Built" is the flag the server sends in `welcome.presets` (`server/settings.go`). A preset is flipped to built only
when its effect works **and** something on screen shows it. Page = where the preset lives when it is not this
room's Lab.

| Preset | Built | Server side | Client / page side | Owner of what is missing |
|---|---|---|---|---|
| P01 Vocabulary | ✓ | done (rates; banner labelled est./simulated) | net graph | – |
| P02 Dumb client | ✓ | done | own player drawn from snapshots | – |
| P03 Trust the client | ✓ | done: claims (type 7) relayed in trust mode, rejected and broadcast otherwise | modded-client button, smoke covers both paths | – |
| P04 Prediction | ✓ | done | WASM predictor | – (scorecard question below) |
| P05 Reconciliation | ✓ | done | HUD pending/replayed/corrections | – |
| P06 Raw snapshots | ✓ | done (+15 ms down jitter) | interp off | – |
| P07 Interpolation | ✓ | done (truth ghost feed) | ghost | – |
| P08 Three truths | ✓ | done (miss reason: seenId, movedCm) | reason text, presenter view | – |
| P09 Lag compensation | ✓ | done (red/blue boxes in ShotResult) | overlay | – |
| P10 Scorecard | ✓ | done; all 32 toggle combinations tested | scorecard widget | – (see blocker on P04) |
| P11 Shot budget | ✗ | done: recvMs/tickStartMs, shotSeen → shotTrace | panel built by duel (`hud/perf.ts`, d8ffe39) but **not mounted in main.ts**, so `client/smoke/perf.mjs` cannot run | client/duel: mount `window.__perf = mountPerf(session, hud)` |
| P12 Send and tick rate | ✓ | done (64/s; cost meters in stats) | rates apply; cost meters are in the same unmounted panel | client/duel: mount the panel |
| P13 Client FPS | ✓ | done (fpsCap broadcast to every client; 128 Hz + 144 FPS) | `game/loop.ts` applies `fpsCap` | – |
| P14 Peeker's advantage | ✗ | no server hook needed (ShotResult + history exist) | peek test not built | bots |
| P15 Budget table | ✗ | done (`stats.budgetEst`, est.) | panel unmounted (as P11) | client/duel: mount the panel |
| P16 Regions and fragile cables | ✗ (page) | region rooms, ISP routes, cable cut: duel's `server/regions`, now mounted by the game server (4b5a2e6) | `/infra.html` (duel) | duel: confirm the page works from the main URL, then flip |
| P17 Beacons and matchmaking | ✗ (page) | beacons + matchmaker mounted (4b5a2e6) | `/infra.html` | duel: as P16 |
| P18 Relay / backbone | ✗ (page) | routes relay-public / relay-backbone (regions) | `/infra.html` | duel: as P16 |
| P19 Tick health | ✗ | done: `loop` toggle (0.0 vs 273 allocs/tick), whole-window tick histograms, GC, goMemLimitMB | panel unmounted (as P11); live 50-bot run owed | client/duel (mount), bots (run) |
| P20 Percentiles | ✗ (page) | `/metrics` mounted; Prometheus/Grafana in `deploy/` (duel) | Grafana + `/infra.html` report | duel |
| P21 Rollback | ✗ (page) | duel relay at `/duel/ws|wt` | `/duel.html` | duel |
| P22 Input delay | ✗ (page) | as P21 | `/duel.html` | duel |
| P23 Lockstep | ✗ (page) | as P21 | `/duel.html` | duel |
| P24 Died behind the wall | ✓ | done (Death event, 50 ms each way) | death replay; smoke covers a real kill | – |
| P25 Glitch lab | ✗ | done (1a91d01): `{t:"glitch", kind:"rubberband", on}` and `{t:"glitch", kind:"lossBurst", ms, target/all}`, each broadcast as `{t:"glitch", name, explain}`; preset turns rubber-band on | buttons + showing the glitch name; desync inject is on `/duel.html` | client (buttons, name), duel (desync) |
| P26 Sub-tick | ✓ | done (timing error per shot + histograms per mode) | client sends subtickFrac; histogram panel not built | client (panel) |
| P27 Compression | ✓ | done (quant/bitpack/delta, raw/quant/bitpack/delta meters) | client decodes deltas; meter panel not built | client (panel) |
| P28 Interest management | ✓ | done (3×3 grid, entitiesPerSnapshot) | effect visible (players outside vanish); meter panel not built | client (panel) |
| P29 Transport | ✗ | done (WS: simulated TCP head-of-line, fast retransmit vs RTO; WT: datagram loss) | inter-arrival histogram in the unmounted panel | client/duel (mount), bots (run) |

Open question for the lead: **P04 scorecard.** A.6 says prediction alone gives "Instant ✓, Cheat-proof ✓". The
A.10 table says "Instant | prediction + reconciliation", and B.6 P10 says "all green only with predict, reconcile,
interp, lagcomp and authority on". The server follows A.10/P10, so P04 (reconcile off) shows Instant ✗.

Note: P26–P28 were marked built in C3 because their effect works and is visible in play, but their meters
have no panel yet. If "built" must also mean "meter on screen", they should go back to ✗ until client's panels land.
