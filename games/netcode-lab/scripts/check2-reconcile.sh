#!/bin/sh
# B.9 check 2: one walker bot under the default conditioner (40 ms RTT) for D,
# against a fresh server. Prints the bot summary (corrections must be 0).
# Usage: sh scripts/check2-reconcile.sh [ws|wt] [duration]   (run from games/netcode-lab)
set -eu
MODE=${1:-ws}; D=${2:-5m}
HTTP=127.0.0.1:${HTTP_PORT:-28080}; HTTPS=127.0.0.1:${HTTPS_PORT:-28443}
go build -o bin/server ./cmd/server && go build -o bin/bot ./cmd/bot
OUT=$(mktemp -d)
if [ "$MODE" = wt ]; then
  bin/server -http "$HTTP" -https "$HTTPS" >"$OUT/server.log" 2>&1 &
  URL="https://$HTTPS/wt"
else
  bin/server -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
  URL="ws://$HTTP/ws"
fi
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
bin/bot -url "$URL" -info "http://$HTTP" -n 1 -d "$D"
