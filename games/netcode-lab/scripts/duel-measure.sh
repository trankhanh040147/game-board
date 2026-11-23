#!/bin/sh
# M8 measurements: two duelbot peers through their own bin/duelrelay, per
# conditioner profile, transport, mode and input delay D. One JSON line per peer per run.
# Team rule: the relay runs on this script's ports only (default 18710/18711),
# its PID is recorded, and only that PID is stopped. Every bot run is capped.
# Usage (from games/netcode-lab, after make duel): sh scripts/duel-measure.sh [seconds] > out.jsonl
set -e
DUR="${1:-30}"
HTTP_PORT="${DUEL_HTTP_PORT:-18710}"
HTTPS_PORT="${DUEL_HTTPS_PORT:-18711}"
PIDFILE="${DUEL_PIDFILE:-bin/duel-measure-relay.pid}"
bin/duelrelay -http "127.0.0.1:$HTTP_PORT" -https "127.0.0.1:$HTTPS_PORT" 2> bin/duel-measure-relay.log &
RELAY=$!
echo "$RELAY" > "$PIDFILE"
trap 'kill "$RELAY" 2>/dev/null; rm -f "$PIDFILE"' EXIT INT TERM
sleep 1
kill -0 "$RELAY" || { echo "relay did not start (see bin/duel-measure-relay.log)" >&2; exit 1; }
CAP=$((DUR + 30))
run() {
  # perl alarm = portable timeout (macOS has no timeout(1))
  perl -e 'alarm shift; exec @ARGV' "$CAP" bin/duelbot -pair -info "http://127.0.0.1:$HTTP_PORT/api/duel/info" "$@" -d "${DUR}s" 2>/dev/null
  kill -0 "$RELAY" || { echo "relay died during a run: results after this point are void" >&2; exit 1; }
}
for T in wt ws; do
  if [ "$T" = wt ]; then URL="https://127.0.0.1:$HTTPS_PORT/duel/wt"; else URL="ws://127.0.0.1:$HTTP_PORT/duel/ws"; fi
  for P in default bad; do
    for D in 0 1 2 3; do
      run -url "$URL" -profile "$P" -mode rollback -delay "$D"
    done
    run -url "$URL" -profile "$P" -mode lockstep -delay auto
    run -url "$URL" -profile "$P" -mode lockstep -delay 2
  done
done
echo "relay pid $RELAY alive for the whole matrix" >&2
