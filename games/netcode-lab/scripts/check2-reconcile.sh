#!/bin/sh
# B.9 check 2: one walker bot under the default conditioner (40 ms RTT) for D,
# against a fresh server, with the host context next to the result:
#   - load average (uptime) before, every 30 s, and after;
#   - the server's "tick started late" warnings (> 3 periods) with timestamps,
#     the bot's correction timestamps, and the server's whole-window lateness histogram;
#   - a control probe (bin/bot -kind probe): a separate process with no game code
#     that sleeps on the same tick schedule and counts its own late wake-ups;
#   - proof the server lived for the whole run (PID alive at the end, no bot errors).
# Usage: sh scripts/check2-reconcile.sh [ws|wt] [duration] [lab-settings-json]
#   e.g. sh scripts/check2-reconcile.sh ws 5m '{"speedScale":0.8}'   (second half of check 2)
# Run from games/netcode-lab. Team rule: ports 18600-18699 only; processes are
# stopped by their recorded PID only. OUT=<dir> keeps the raw files.
set -eu
MODE=${1:-ws}; D=${2:-5m}; LAB=${3:-}
HTTP=127.0.0.1:${HTTP_PORT:-18600}; HTTPS=127.0.0.1:${HTTPS_PORT:-18643}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=check2-$$
SRVBIN="$OUT/netlab-check2-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"; git status --short server sim net cmd/server >>"$OUT/commit"
if [ "$MODE" = wt ]; then
  NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "$HTTPS" >"$OUT/server.log" 2>&1 &
  URL="https://$HTTPS/wt"
else
  NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
  URL="ws://$HTTP/ws"
fi
SRV=$!; echo $SRV >"$OUT/server.pid"
( while :; do uptime; sleep 30; done ) >"$OUT/uptime.log" 2>&1 &
UPT=$!
trap 'kill $SRV $UPT 2>/dev/null || true' EXIT
sleep 1
if ! kill -0 $SRV 2>/dev/null; then cat "$OUT/server.log"; exit 1; fi
date +%T >"$OUT/start"
bin/bot -kind probe -hz 64 -d "$D" >"$OUT/probe.json" &
PRB=$!
NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -url "$URL" -info "http://$HTTP" -n 1 -d "$D" -stats -warmup 0s ${LAB:+-lab "$LAB"} >"$OUT/bot.json"
wait $PRB
uptime >>"$OUT/uptime.log"
date +%T >"$OUT/end"
if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server.alive"; else echo dead >"$OUT/server.alive"; fi
python3 -I scripts/check2-summary.py "$OUT" "$MODE" "${LAB:-defaults}"
