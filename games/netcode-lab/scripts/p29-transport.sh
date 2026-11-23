#!/bin/sh
# P29 / B.9 check 6: snapshot inter-arrival, WebSocket vs WebTransport datagrams, with LOSS % loss
# each way on the default 20 ms delay. N walker bots per transport, D each, fresh server per run.
# Pass (B.9 #6): WebSocket shows stalls > 3x the send interval; datagram mode does not.
# Lead ruling (DECISIONS): every gap > 3x the interval (150 ms at 20/s) is classified by snapshot ids:
# ids missing in the gap = loss gap (data gone, newer data on time); none missing = stall (head-of-line).
# The check is judged on stalls; loss gaps are listed beside them.
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
  bin/bot -kind probe -hz 64 -d "$D" >"$OUT/probe-$MODE.json" &
  PRB=$!
  NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -url "$URL" -info "http://$HTTP" -n "$N" -d "$D" -cond "$COND" >"$OUT/bot-$MODE.json"
  wait $PRB
  uptime >>"$OUT/uptime-$MODE.log"
  if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server-$MODE.alive"; else echo dead >"$OUT/server-$MODE.alive"; fi
  kill $SRV 2>/dev/null || true
  sleep 1
done
python3 -I - "$OUT" <<'PY'
import json, re, sys
out = sys.argv[1]
def sec(hms):
    h, m, x = hms.split(":"); return int(h) * 3600 + int(m) * 60 + float(x)
for m in ["ws", "wt"]:
    d = json.load(open(f"{out}/bot-{m}.json"))
    # host stall intervals: server late ticks (> 3 periods) and probe late wake-ups (> 3 periods)
    host = []
    for l in open(f"{out}/server-{m}.log"):
        if "tick started late" in l:
            t = sec(re.search(r"T(\d\d:\d\d:\d\d\.\d+)", l).group(1)); x = float(re.search(r"lateMs=([\d.]+)", l).group(1)) / 1000
            host.append((t - x, t))
    for e in json.load(open(f"{out}/probe-{m}.json")).get("over3PeriodEvents") or []:
        t = sec(e["at"]); host.append((t - e["lateMs"] / 1000, t))
    print(m, "server", open(f"{out}/server-{m}.alive").read().strip(), "| uptime:", " / ".join(l.split("load averages:")[1].strip() for l in open(f"{out}/uptime-{m}.log")), "| host stall events:", len(host))
    for b in d["perBot"]:
        ia = b["snapshotInterArrival"]
        kinds = ia.get("gapsOver3xByKind") or {}
        hoststall = {"stall": 0, "loss": 0}
        stalls_not_host = []
        for st in ia.get("stallsAt") or []:
            f = st.split(); hms, ln, kind = f[0], f[1], f[2]
            end = sec(hms); start = end - float(ln) / 1000
            if any(a <= end + 0.05 and start - 0.05 <= z for a, z in host):
                hoststall[kind] += 1
            elif kind == "stall":
                stalls_not_host.append(f"{hms} {ln}")
        print(f'  {b["name"]}: snaps {b["snapshots"]} p50 {ia["p50Ms"]} p95 {ia["p95Ms"]} p99 {ia["p99Ms"]} max {ia["maxMs"]} gaps>3x {ia["stallsOver3xInterval"]}: STALLS {kinds.get("stall")} (overlapping a host stall {hoststall["stall"]}; others {stalls_not_host[:6]}), loss gaps {kinds.get("loss")} (overlapping a host stall {hoststall["loss"]}) hist {json.dumps(ia["histogramByInterval"], sort_keys=True)} errors {b.get("errors")}')
print("raw:", out)
PY
