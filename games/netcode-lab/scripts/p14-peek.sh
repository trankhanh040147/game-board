#!/bin/sh
# P14 peeker's advantage (research R3 item 2): holder bot stationary at its spawn, peeker bot
# moves out past the east edge of the low wall, CROSSINGS times. Prints mean ± sd of
# t_holderSees − t_peekerSees ("our measurement") plus both sides against t_expose.
# Usage: sh scripts/p14-peek.sh [default|bad] [crossings=20]   (run from games/netcode-lab)
#   default = 20 ms each way; bad = "Bad route" 40 ms each way, jitter 15 ms, loss 1% (client Lab profile)
# Team rule: ports 18600-18699; processes stopped by recorded PID only. OUT=<dir> keeps files.
set -eu
PROFILE=${1:-default}; N=${2:-20}
HTTP=127.0.0.1:${HTTP_PORT:-18660}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=p14-$$
SRVBIN="$OUT/netlab-p14-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"; git status --short server sim net cmd/server >>"$OUT/commit"
NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
SRV=$!; echo $SRV >"$OUT/server.pid"
trap 'kill $SRV 2>/dev/null || true' EXIT
i=0; until curl -sf "http://$HTTP/api/info" >/dev/null 2>&1 || [ $i -ge 50 ]; do sleep 0.2; i=$((i+1)); done   # wait until listening (slow start under load)
if ! kill -0 $SRV 2>/dev/null; then cat "$OUT/server.log"; exit 1; fi
COND=""
[ "$PROFILE" = bad ] && COND='{"up":{"delayMs":40,"jitterMs":15,"lossPct":1},"down":{"delayMs":40,"jitterMs":15,"lossPct":1}}'
D=$(( N * 5 + 30 ))s
uptime >"$OUT/uptime.log"
NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -kind peek -url "ws://$HTTP/ws" -d "$D" -crossings "$N" ${COND:+-cond "$COND"} >"$OUT/bot.json"
uptime >>"$OUT/uptime.log"
if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server.alive"; else echo dead >"$OUT/server.alive"; fi
python3 -I - "$OUT" "$PROFILE" <<'PY'
import json, sys
out, prof = sys.argv[1:]
d = json.load(open(f"{out}/bot.json")); p = d["peek"]; p.pop("crossings", None)
late = sum("tick started late" in l for l in open(f"{out}/server.log"))
print(json.dumps({"profile": prof, "commit": open(f"{out}/commit").read().split(), "serverPid": open(f"{out}/server.pid").read().strip(),
  "serverAliveAtEnd": open(f"{out}/server.alive").read().strip() == "alive", "uptime": open(f"{out}/uptime.log").read().splitlines(),
  "serverLateTicksOver3Periods": late, "bots": [{k: b.get(k) for k in ("name", "corrections", "rttMedianMs", "jitterMs", "errors", "condAtWelcome")} for b in d["perBot"]],
  "peek": p, "rawFiles": out}, indent=1))
PY
