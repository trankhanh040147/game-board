#!/bin/sh
# M8 measurements: two duelbot peers through bin/duelrelay, per conditioner
# profile, transport, mode and input delay D. One JSON line per peer per run.
# Usage (from games/netcode-lab, relay running): sh scripts/duel-measure.sh [seconds] > out.jsonl
set -e
DUR="${1:-30}"
for T in wt ws; do
  if [ "$T" = wt ]; then URL=https://127.0.0.1:8453/duel/wt; else URL=ws://127.0.0.1:8090/duel/ws; fi
  for P in default bad; do
    for D in 0 1 2; do
      bin/duelbot -pair -url "$URL" -profile "$P" -mode rollback -delay "$D" -d "${DUR}s" 2>/dev/null
    done
    bin/duelbot -pair -url "$URL" -profile "$P" -mode lockstep -delay auto -d "${DUR}s" 2>/dev/null
    bin/duelbot -pair -url "$URL" -profile "$P" -mode lockstep -delay 2 -d "${DUR}s" 2>/dev/null
  done
done
