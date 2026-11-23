# Preset status (HANDOFF B.6), updated 2026-11-23 (C5 flips)

"Built" is the flag the server sends in `welcome.presets` (`server/settings.go`). A preset is flipped to built only
when its effect works **and** something on screen shows it. Page = where the preset lives when it is not this
room's Lab; the link carries `?preset=Pxx` so the page can apply that preset's state (duel's pages must read it).

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
| P11 Shot budget | ✓ (58367a2) | done | duel's perf panel, mounted by client (0feb23a) | – |
| P12 Send and tick rate | ✓ | done | rates + cost meters in the perf panel, verified | – |
| P13 Client FPS | ✓ | done (fpsCap broadcast to every client; 128 Hz + 144 FPS) | `game/loop.ts` applies `fpsCap` | – |
| P14 Peeker's advantage | ✓ (58367a2) | done (d41e342) | perf panel P14 section with run buttons (84b5ebe) | – |
| P15 Budget table | ✓ (58367a2) | done | perf panel table, formula labelled est., tick wait = playout buffer | – |
| P16 Regions and fragile cables | ✗ (page; verified, flip waits) | regions mounted on the main server | `/infra.html?preset=P16` puts the page in state (verified) | client: Lab must open the page link for built page presets (server answers `presetPage`), and smoke must expect that; then flip |
| P17 Beacons and matchmaking | ✗ (page; verified, flip waits) | as P16 | `/infra.html?preset=P17` verified | client, as P16 |
| P18 Relay / backbone | ✗ (page; verified, flip waits) | regions mounted on the main server | scribe S14 (f05bcb6) at d2c12c6: `infra.html?preset=P18` per-route est. budget bars, to sg viettel/good public vs backbone jitter 9.5 vs 0.5 ms, bar 208 vs 191 ms; with the cut jitter 16.0 vs 1.5 ms, loss 1/10 vs 0/10, bar 308 vs 233 ms; core's `pages-core.mjs` (C5) confirms the link state | client: commit the Lab fix (below), then flip |
| P19 Tick health | ✓ (58367a2; preset turns the naive loop on) | done | perf panel tick health + loop switch | live 50-bot comparison owed in the quiet window (bots) |
| P20 Percentiles | ✗ (page; verified, flip waits) | `/metrics` mounted | scribe S14 (f05bcb6) at d2c12c6: compose drill (30 players, cut held 150 s): ISPRouteP95High FIRING for sg/vnpt (t=103 s, 194), sg/fpt (124 s, 184), sg/viettel (137 s, 191) from /api/v1/alerts; Grafana mean-vs-p99 panel 18 series, no "No data" | client: commit the Lab fix, then flip |
| P21 Rollback | ✗ (page; verified, flip waits) | duel relay mounted | `/duel.html?preset=P21`: mode rollback, D 0, banner, match running (verified) | client, as P16 |
| P22 Input delay | ✗ (page; verified, flip waits) | as P21 | `?preset=P22`: rollback, D auto (verified) | client, as P16 |
| P23 Lockstep | ✗ (page; verified, flip waits) | as P21 | `?preset=P23`: lockstep, D auto (verified) | client, as P16 |
| P24 Died behind the wall | ✓ | done (Death event, 50 ms each way) | death replay; smoke covers a real kill | – |
| P25 Glitch lab | ✓ (58367a2) | done; WS loss burst now stalls for the whole outage (b66f098, DECISIONS 56) | glitch buttons + names (118cbcf); duel page desync | – |
| P26 Sub-tick | ✓ (C6) | done | F4 panel: own-shot timing histogram on vs quantised + server percentiles (2a83a4b) | – |
| P27 Compression | ✓ (C6) | done | F4 panel: raw/quant/bitpack/delta kbps now, at rest, moving (2a83a4b) | – |
| P28 Interest management | ✓ (C6) | done | F4 panel: entities and kbps with interest off vs on (2a83a4b) | – |
| P29 Transport | ✓ (58367a2; preset sets 5 % down loss, simulated) | done | perf panel inter-arrival histogram | – |

Resolved (DECISIONS 54): **P04 scorecard.** A.6 says prediction alone gives "Instant ✓, Cheat-proof ✓". The
A.10 table says "Instant | prediction + reconciliation", and B.6 P10 says "all green only with predict, reconcile,
interp, lagcomp and authority on". The server follows A.10/P10, so P04 (reconcile off) shows Instant ✗.

P26–P28 went back to ✗ (DECISIONS 55) until their meter panels landed; flipped again in C6 after verification below.
P04 scorecard ruling: DECISIONS 54.


## C5 verification evidence (2026-11-23, core)

Clean worktree builds (client, sim.wasm, duel-www, server, bot) at 118cbcf, then b66f098 and 58367a2; my server on
127.0.0.1:18113 (PID-recorded, alive at the end of every run); host load average 21–38.

| Check | Command | Result |
|---|---|---|
| P11, P12 meters, P15, P19, P29 | `NETLAB_ADMIN_TOKEN=… node smoke/perf.mjs http://127.0.0.1:18113 12` (duel's) | two runs (118cbcf client + server, then b66f098): every check PASS, 12/12 shots traced with the target half, no console errors. Run 2: measured total 230.2 ms vs est. 189.5 (tick wait 63.1 ms = playout buffer, loaded host) |
| P14 | `docs/evidence/p14-core.mjs` (presenter page, F3, "run peek test (3 crossings)") | "our measurement: advantage 177.4 ± 10.3 ms, 3/3 crossings", conditioner "(simulated)", Riot figures labelled ref, no console errors |
| P25 | client's `smoke/smoke.mjs` | rubber-band: named, 19 corrections while moving; loss burst: named, max snapshot gap 688 ms (> 100 ms buffer; was 199 ms before DECISIONS 56) |
| all built presets after the flips | client's `smoke/smoke.mjs` at 58367a2 | 43 passed, 0 failed, 1 skipped (HTTPS join: server ran without HTTPS); 19 presets applied and broadcast |
| P16, P17, P18, P21, P22, P23 links | `docs/evidence/pages-core.mjs` | every `?preset=` puts the page in the preset's state (route/region/cut, mode/D), banner names it, "simulated" on infra, no console errors |
| flipping page presets now | client's smoke with P16/P17/P21–P23 built | 43 passed, **5 failed**: the Lab enables "apply" for built page presets and the smoke expects a settings broadcast; the server answers `presetPage` (it has no room state to apply). Flips reverted until the Lab opens the link |


## C6 verification (2026-11-23, core)

Clean worktree build at 2c9ba63 (client, sim.wasm, duel-www, server, bot); server on 127.0.0.1:18116 (HTTPS + WebTransport
on 18117), PID-recorded, alive for every run and stopped by PID; host load average 22–31.

| Check | Command | Result |
|---|---|---|
| P26, P27, P28 panels (F4) | client's `smoke/smoke.mjs` | P26: own shots 3 with sub-tick on (p50 0.0 ms), 1 quantised (14.7 ms); P27: raw 3.5 / quant 2.2 / bitpack 1.9 / delta 0.5 kbps at rest, delta 1.6 moving; P28: 1 entity with interest off, 0 on |
| whole client smoke with HTTPS | client's `smoke/smoke.mjs` | **50 passed, 0 failed, 0 skipped** (WebTransport join, region rooms over ws and wt). A run without HTTPS had one expected failure: the region-over-wt leg fell back to ws |
| fill bots (bots' 4ebe927 + core hook 2c9ba63) | bots' `smoke/fill.mjs` | 5 bots balanced the teams, a full round (blue 23 : orange 21, kills both ways, 29 bot-vs-bot), removal left 1 player, no console errors, no bot process left over |

Page presets P16, P17, P21, P22, P23 stay ✗: client's Lab at 2c9ba63 still offers "apply" for built page presets
(lab.ts 180-186), so flipping them still fails the smoke's apply loop (C5 evidence). They flip when the Lab opens the page.


## Page presets: why the flip waits (2026-11-23, core)

All seven page presets (P16, P17, P18, P20, P21, P22, P23) are verified: their `?preset=` links (core C5) and, for P18
and P20, scribe's S14 walk and compose drill. They flip together when client commits its Lab fix. At HEAD 539aee6
the committed `client/src/hud/lab.ts` (line 180) still enables "apply" for a built page preset. The smoke's apply
loop (`smoke.mjs` 165-169) then fails for each one (measured in C5: 5 failures for 5 flipped presets), because
the server answers `presetPage`. Client's uncommitted working copy (`lab.ts` 201: built page presets disabled
with "opens its own page"; `session.ts` 158 handles `presetPage`) fixes that.
