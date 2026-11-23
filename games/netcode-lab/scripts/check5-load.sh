#!/bin/sh
# B.9 check 5 / P19 / P28 load harness: N walker bots from one process against a
# fresh server at tick rate HZ; records the server's 1 Hz tick stats after a warmup.
# Usage: sh scripts/check5-load.sh [hz=64] [bots=40] [duration=70s] [warmup=10s]   (run from games/netcode-lab)
set -eu
HZ=${1:-64}; N=${2:-40}; D=${3:-70s}; W=${4:-10s}
HTTP=127.0.0.1:${HTTP_PORT:-28080}
TOKEN=load-$$
go build -o bin/server ./cmd/server && go build -o bin/bot ./cmd/bot
OUT=$(mktemp -d)
NETLAB_ADMIN_TOKEN=$TOKEN bin/server -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -url "ws://$HTTP/ws" -n "$N" -d "$D" -tick "$HZ" -stats -warmup "$W" -perbot=false
