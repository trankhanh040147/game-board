#!/bin/sh
# Measured effect of presets P12 (send rate cost), P27 (compression), P28 (interest management),
# one fresh server per configuration, walker bots from one process, server stats after a warmup.
# Usage: sh scripts/presets-effect.sh [p12|p27|p28|all] [duration=45s]   (run from games/netcode-lab)
# Team rule: ports 18600-18699; processes stopped by recorded PID only. OUT=<dir> keeps files.
set -eu
WHICH=${1:-all}; D=${2:-45s}
HTTP=127.0.0.1:${HTTP_PORT:-18640}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=pe-$$
SRVBIN="$OUT/netlab-presets-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"
one() { # name bots extra-bot-args...
  NAME=$1; N=$2; shift 2
  NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "" >"$OUT/$NAME.server.log" 2>&1 &
  SRV=$!
  i=0; until curl -sf "http://$HTTP/api/info" >/dev/null 2>&1 || [ $i -ge 50 ]; do sleep 0.2; i=$((i+1)); done
  L0=$(uptime | sed 's/.*load averages*: //')
  NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -url "ws://$HTTP/ws" -n "$N" -d "$D" -stats -warmup 10s -statsreset -perbot=false "$@" >"$OUT/$NAME.json"
  L1=$(uptime | sed 's/.*load averages*: //')
  if kill -0 $SRV 2>/dev/null; then A=alive; else A=DEAD; fi
  kill $SRV 2>/dev/null || true; sleep 1
  python3 -I - "$OUT/$NAME.json" "$NAME" "$N" "$SRV" "$A" "$L0" "$L1" <<'PY'
import json, sys
f, name, n, pid, alive, l0, l1 = sys.argv[1:]
d = json.load(open(f)); st = d["serverTick"]; ww = st.get("wholeWindow") or {}
print(json.dumps({"run": name, "bots": int(n), "serverPid": pid, "server": alive, "load": f"{l0} -> {l1}",
  "tickRates": st.get("tickRates"), "sendRate": st.get("sendRate"), "withinBudgetPct": st.get("withinBudgetPct"),
  "tickMs": {k: ww.get("tickMs", {}).get(k) for k in ("p50Ms", "p99Ms", "withinBudgetPct")},
  "costMeans": st.get("costMeans"), "botErrors": d["totals"]["botsWithErrors"], "corrections": d["totals"]["corrections"]}))
PY
}
case $WHICH in p12|all)
  for SR in 20 64 128; do one p12-send$SR 20 -tick 128 -lab "{\"sendRate\":$SR}"; done;;
esac
case $WHICH in p27|all)
  one p27-moving-off 20
  one p27-moving-on 20 -lab '{"compQuant":true,"compBitpack":true,"compDelta":true}'
  one p27-rest-on 20 -idle -lab '{"compQuant":true,"compBitpack":true,"compDelta":true}'
  one p27-rest-off 20 -idle;;
esac
case $WHICH in p28|all)
  one p28-interest-off 60
  one p28-interest-on 60 -lab '{"interest":true}';;
esac
echo "raw: $OUT"
