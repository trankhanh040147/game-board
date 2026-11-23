# Playtest (HANDOFF B.9 check 8)

Host checklist for the team playtest: 4+ people on the LAN, conditioner at default, play one round, then walk
through presets P02 → P10 → P11–P15. This file holds no result yet. Fill the notes during the session and copy a
summary into [DEMO.md](DEMO.md#playtest-notes).

Preset build state read from `server/settings.go` at `e7d4272` (2026-11-23). Built: P01, P02, P03, P04, P05, P06, P07, P08, P09, P10, P12, P13, P24, P26, P27, P28.

## Before the session (host)

1. **Build** (from `games/netcode-lab`, fresh clone included):

   ```
   make            # sim.wasm, wasm_exec.js, bin/server, bin/bot
   make client     # npm install + client/dist; needed on a fresh clone, the server serves this folder
   ```

2. **Admin token** for the presenter's Lab panel: pick one and export it, e.g. `export NETLAB_ADMIN_TOKEN=lab-2311`.
   If you skip this, the server prints a generated `adminToken=` in its log.
3. **Run** on the demo ports (8080 and 8443 are reserved for the human demo):

   ```
   make run        # bin/server -http 0.0.0.0:8080 -https 0.0.0.0:8443
   ```

   Keep the terminal open. The log line `https (page + WebSocket) and WebTransport (UDP)` lists the cert's IPs; the
   LAN IP must be in it.
4. **Host LAN IP** (macOS): `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`. Linux: `hostname -I`.
5. **Firewall**: allow inbound **8080/TCP**, **8443/TCP** and **8443/UDP** (WebTransport runs over UDP/QUIC).
   macOS: System Settings → Network → Firewall → allow `server` when asked.

## What each player opens

| Path | URL | Notes |
|---|---|---|
| Main (WebTransport) | `https://<host-ip>:8443` | Accept the **one** certificate warning (self-signed, valid 10 days, minted at server start). Start card must say "✓ Game server connected over WebTransport". |
| Fallback (WebSocket) | `http://<host-ip>:8080` | For anyone whose browser fails on the main URL. Banner says "WebSocket fallback …; game packets go over TCP." |
| Presenter | `https://<host-ip>:8443/?admin=<token>` | Lab panel F1, presenter view F2. `?spectate=1` joins as a spectator. |

Browsers: Chromium-based or Firefox. Click **Play**; if pointer lock is refused, the game falls back to drag-to-look.

## Conditioner at default

Every client gets the default conditioner at join: 20 ms each way, so 40 ms RTT (simulated). The net graph shows
"RTT … measured, incl. simulated 40 ms". If anyone changed theirs, they open the Lab (F1, no token needed) and
click **Default (40 ms)** under "My network conditioner (simulated)".

## Checked on this machine

2026-11-23 @ `e7d4272`, Apple M1 Pro, headless Chrome for Testing 156 (Playwright, `ignoreHTTPSErrors`), server on scribe's
ports `bin/server -http 0.0.0.0:18500 -https 0.0.0.0:18543` (PID recorded, alive for the whole check, stopped by PID).

| Check | Result |
|---|---|
| `https://192.168.1.4:18543` from the LAN IP | Start card "✓ Game server connected over WebTransport"; session transport `wt`; connected; net graph "RTT 43 ms measured, incl. simulated 40 ms"; no console errors |
| `http://192.168.1.4:18500` from the LAN IP | Start card "✓ Game server connected over WebSocket"; banner "WebSocket fallback — page is plain HTTP, not a secure context; game packets go over TCP. …"; no console errors |
| Cert SANs | Server log lists 192.168.1.4 among the cert IPs |

Not checked: a second machine, the certificate warning click in a visible browser, the firewall prompt, and the
real ports 8080/8443 (reserved for the demo; same code path).

## Walkthrough and notes

Player count at start:          Host:          Presenter:          Date / commit:

### Step 1 — One round (team deathmatch)

Play one full round before opening the Lab. Presenter: conditioner at default, no preset changes.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 2 — P02 Dumb client

Preset **P02** (Dumb client, A.4). Lab (F1) → click P02. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 3 — P03 Trust the client

Preset **P03** (Trust the client, A.5). Lab (F1) → click P03. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 4 — P04 Prediction

Preset **P04** (Prediction, A.6). Lab (F1) → click P04. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 5 — P05 Reconciliation

Preset **P05** (Reconciliation, A.7). Lab (F1) → click P05. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 6 — P06 Raw snapshots

Preset **P06** (Raw snapshots, A.8). Lab (F1) → click P06. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 7 — P07 Interpolation

Preset **P07** (Interpolation, A.9). Lab (F1) → click P07. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 8 — P08 Three truths

Preset **P08** (Three truths, A.10). Lab (F1) → click P08. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 9 — P09 Lag compensation

Preset **P09** (Lag compensation, A.10). Lab (F1) → click P09. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 10 — P10 Scorecard

Preset **P10** (Scorecard, A.2). Lab (F1) → click P10. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 11 — P11 Shot budget

**skip: not built (2026-11-23, server/settings.go @ e7d4272)**

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 12 — P12 Send and tick rate

Preset **P12** (Send and tick rate, A.11). Lab (F1) → click P12. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 13 — P13 Client FPS

Preset **P13** (Client FPS, A.11). Lab (F1) → click P13. See DEMO.md for what to point at.

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 14 — P14 Peeker's advantage

**skip: not built (2026-11-23, server/settings.go @ e7d4272)**

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

### Step 15 — P15 Budget table

**skip: not built (2026-11-23, server/settings.go @ e7d4272)**

- Players connected:
- What the presenter showed:
- What players saw / said:
- Numbers on screen (copy them, with their labels):
- Issues (bug, confusing text, lag, crash):

## After the session

- Copy a short summary (player count, what worked, top issues) into [DEMO.md](DEMO.md#playtest-notes).
- Stop the server with Ctrl-C in its terminal.
