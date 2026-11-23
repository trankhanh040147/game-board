#!/bin/sh
# B.9 check 4 / P11 / P15: measured shot budget (click -> target sees it) split into the A.11
# segments, with the shooter/runner bots (only hits count: the target must get a Damage event).
# Usage: sh scripts/check4-budget.sh [default|fast] [duration=2m]   (run from games/netcode-lab)
#   default: 64 Hz, 20 snapshots/s, 60 FPS, buffer 100 ms   (A.11 est. ≈ 190 ms)
#   fast:    128 Hz, 128 snapshots/s, 144 FPS, buffer 15.6 ms (2 x 7.8)   (A.11 est. ≈ 71 ms)
# Frames are modelled in the bot (no display), so "144 FPS" is a model, not a measured display rate.
# Team rule: ports 18600-18699; processes stopped by recorded PID only. OUT=<dir> keeps files.
set -eu
CFG=${1:-default}; D=${2:-2m}
HTTP=127.0.0.1:${HTTP_PORT:-18690}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=c4-$$
SRVBIN="$OUT/netlab-check4-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"; git status --short server sim net cmd/server >>"$OUT/commit"
NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
SRV=$!; echo $SRV >"$OUT/server.pid"
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
if ! kill -0 $SRV 2>/dev/null; then cat "$OUT/server.log"; exit 1; fi
if [ "$CFG" = fast ]; then ARGS='-tick 128 -lab {"sendRate":128,"fpsCap":144} -fps 144 -buf 15.625'
else ARGS='-fps 60 -buf 100'; fi
uptime >"$OUT/uptime.log"
# shellcheck disable=SC2086
NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -kind shootrun -url "ws://$HTTP/ws" -d "$D" $ARGS >"$OUT/bot.json"
uptime >>"$OUT/uptime.log"
if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server.alive"; else echo dead >"$OUT/server.alive"; fi
python3 -I - "$OUT" "$CFG" <<'PY'
import json, sys
out, cfg = sys.argv[1:]
d = json.load(open(f"{out}/bot.json"))
print(json.dumps({"config": cfg, "commit": open(f"{out}/commit").read().split(), "serverPid": open(f"{out}/server.pid").read().strip(),
  "serverAliveAtEnd": open(f"{out}/server.alive").read().strip() == "alive", "uptime": open(f"{out}/uptime.log").read().splitlines(),
  "serverLateTicksOver3Periods": sum("tick started late" in l for l in open(f"{out}/server.log")),
  "bots": [{k: b.get(k) for k in ("name", "tickRate", "rttMedianMs", "corrections", "errors")} for b in d["perBot"]],
  "budget": d.get("budget"), "rawFiles": out}, indent=1))
PY
