#!/bin/sh
# Final runs for the lead's quiet window, back to back (about 20 minutes):
#   check 2 (WS + WT at the same time, 5 min, defaults), check 4 (default, then 128 Hz + 144 FPS modelled, 2 min each),
#   check 5 / P19 (50 bots at 128 Hz, zero-alloc then naive), check 6 / P29 (WS then WT at 5% loss, 2 min each).
# Every result file records host load, the server PID and whether it lived to the end.
# Usage: sh scripts/quiet-window.sh [out-dir]   (run from games/netcode-lab, ideally a clean worktree of HEAD)
# Team rule: ports 18600-18699; processes stopped by recorded PID only.
set -eu
ROOT=${1:-$(mktemp -d)}; mkdir -p "$ROOT"
echo "commit $(git rev-parse --short HEAD); start $(date +%T); $(uptime)" | tee "$ROOT/README.txt"
cap() { perl -e 'alarm shift; exec @ARGV' "$@"; }   # hard timeout per step
# Host context per step: load and the top 5 CPU processes (much of the load is outside the team's control).
host() { { echo "== $1 $(date +%T)"; uptime; ps -Ao pcpu,pid,comm -r | head -6 | cut -c1-140; } >>"$ROOT/host.log"; }
host start
OUT=$ROOT/c2-ws HTTP_PORT=18600 HTTPS_PORT=18643 cap 420 sh scripts/check2-reconcile.sh ws 5m >"$ROOT/c2-ws.json" 2>&1 &
P1=$!
OUT=$ROOT/c2-wt HTTP_PORT=18620 HTTPS_PORT=18663 cap 420 sh scripts/check2-reconcile.sh wt 5m >"$ROOT/c2-wt.json" 2>&1 &
P2=$!
wait $P1 $P2 || true
host after-check2
for C in default fast; do OUT=$ROOT/c4-$C HTTP_PORT=18690 cap 240 sh scripts/check4-budget.sh $C 2m >"$ROOT/c4-$C.json" 2>&1 || true; host after-check4-$C; done
for L in zeroalloc naive; do HTTP_PORT=18610 cap 240 sh scripts/check5-load.sh 128 50 100s 10s $L >"$ROOT/c5-$L.txt" 2>&1 || true; host after-check5-$L; done
OUT=$ROOT/p29 HTTP_PORT=18650 HTTPS_PORT=18651 cap 420 sh scripts/p29-transport.sh 2m 5 3 >"$ROOT/p29.txt" 2>&1 || true
host end
echo "end $(date +%T); $(uptime)" | tee -a "$ROOT/README.txt"
echo "results in $ROOT"
