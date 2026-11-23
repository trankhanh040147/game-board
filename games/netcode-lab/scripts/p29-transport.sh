#!/bin/sh
# P29 / B.9 check 6: snapshot inter-arrival, WebSocket vs WebTransport datagrams, with LOSS % loss
# each way on the default 20 ms delay. N walker bots per transport, D each, fresh server per run.
# Pass (B.9 #6): WebSocket shows stalls > 3x the send interval; datagram mode does not.
# Usage: sh scripts/p29-transport.sh [duration=2m] [loss=5] [bots=3]   (run from games/netcode-lab)
# Team rule: ports 18600-18699; processes stopped by recorded PID only. OUT=<dir> keeps files.
set -eu
D=${1:-2m}; LOSS=${2:-5}; N=${3:-3}
HTTP=127.0.0.1:${HTTP_PORT:-18650}; HTTPS=127.0.0.1:${HTTPS_PORT:-18651}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=p29-$$
SRVBIN="$OUT/netlab-p29-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"; git status --short server sim net cmd/server >>"$OUT/commit"
COND="{\"up\":{\"delayMs\":20,\"lossPct\":$LOSS},\"down\":{\"delayMs\":20,\"lossPct\":$LOSS}}"
for MODE in ws wt; do
  NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "$HTTPS" >"$OUT/server-$MODE.log" 2>&1 &
  SRV=$!; echo $SRV >"$OUT/server-$MODE.pid"
  sleep 1
  if ! kill -0 $SRV 2>/dev/null; then cat "$OUT/server-$MODE.log"; exit 1; fi
  [ "$MODE" = wt ] && URL="https://$HTTPS/wt" || URL="ws://$HTTP/ws"
  uptime >"$OUT/uptime-$MODE.log"
  NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -url "$URL" -info "http://$HTTP" -n "$N" -d "$D" -cond "$COND" >"$OUT/bot-$MODE.json"
  uptime >>"$OUT/uptime-$MODE.log"
  if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server-$MODE.alive"; else echo dead >"$OUT/server-$MODE.alive"; fi
  kill $SRV 2>/dev/null || true
  sleep 1
done
python3 -I - "$OUT" <<'PY'
import json, sys
out = sys.argv[1]
for m in ["ws", "wt"]:
    d = json.load(open(f"{out}/bot-{m}.json"))
    print(m, "server", open(f"{out}/server-{m}.alive").read().strip(), "| uptime:", " / ".join(l.split("load averages:")[1].strip() for l in open(f"{out}/uptime-{m}.log")))
    for b in d["perBot"]:
        ia = b["snapshotInterArrival"]
        print(f'  {b["name"]}: cond {json.dumps(b.get("condAtWelcome"))[:0]}snaps {b["snapshots"]} p50 {ia["p50Ms"]} p95 {ia["p95Ms"]} p99 {ia["p99Ms"]} max {ia["maxMs"]} stalls>3x {ia["stallsOver3xInterval"]} hist {json.dumps(ia["histogramByInterval"], sort_keys=True)} errors {b.get("errors")}')
print("raw:", out)
PY
