#!/bin/sh
# B.9 check 3 integration (DECISIONS 39): a shooter bot and a runner bot crossing the gap,
# default conditioner (40 ms RTT), 64 Hz, 20/s, interp 100 ms. The shooter aims at the
# runner's rendered body centre; per shot, its own verdict (sim.RayPlayer + TraceMap on the
# rendered position) is compared with the server's hitId. Pass (lagcomp on): >= 300 shots
# and >= 97 % agreement; clamped shots count as disagreements. Lagcomp off: reported only.
# Usage: sh scripts/check3-lagcomp.sh [on|off] [duration]   (run from games/netcode-lab)
# Team rule: ports 18600-18699; processes stopped by recorded PID only. OUT=<dir> keeps files.
set -eu
LC=${1:-on}; D=${2:-6m}
HTTP=127.0.0.1:${HTTP_PORT:-18630}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"
TOKEN=check3-$$
SRVBIN="$OUT/netlab-check3-server"
go build -o "$SRVBIN" ./cmd/server && go build -o bin/bot ./cmd/bot
git rev-parse --short HEAD >"$OUT/commit"; git status --short server sim net cmd/server >>"$OUT/commit"
NETLAB_ADMIN_TOKEN=$TOKEN "$SRVBIN" -http "$HTTP" -https "" >"$OUT/server.log" 2>&1 &
SRV=$!; echo $SRV >"$OUT/server.pid"
trap 'kill $SRV 2>/dev/null || true' EXIT
i=0; until curl -sf "http://$HTTP/api/info" >/dev/null 2>&1 || [ $i -ge 50 ]; do sleep 0.2; i=$((i+1)); done   # wait until listening (slow start under load)
if ! kill -0 $SRV 2>/dev/null; then cat "$OUT/server.log"; exit 1; fi
[ "$LC" = on ] && LAB='{"lagcomp":true}' || LAB='{"lagcomp":false}'
uptime >"$OUT/uptime.log"; date +%T >"$OUT/start"
NETLAB_ADMIN_TOKEN=$TOKEN bin/bot -kind shootrun -url "ws://$HTTP/ws" -d "$D" -lab "$LAB" >"$OUT/bot.json"
uptime >>"$OUT/uptime.log"; date +%T >"$OUT/end"
if kill -0 $SRV 2>/dev/null; then echo alive >"$OUT/server.alive"; else echo dead >"$OUT/server.alive"; fi
python3 -I - "$OUT" "$LC" <<'PY'
import json, sys
out, lc = sys.argv[1:]
rd = lambda f: open(f"{out}/{f}").read().strip()
d = json.load(open(f"{out}/bot.json"))
sh, rn = d["perBot"][0], d["perBot"][1]
s = sh.get("shots") or {}
late = [l for l in rd("server.log").splitlines() if "tick started late" in l]
ok = lc == "on" and s.get("serverResults", 0) >= 300 and s.get("agreementPct", 0) >= 97
print(json.dumps({"lagcomp": lc, "commit": rd("commit").splitlines(), "start": rd("start"), "end": rd("end"),
  "serverPid": rd("server.pid"), "serverAliveAtEnd": rd("server.alive") == "alive",
  "botErrors": {"shooter": sh.get("errors"), "runner": rn.get("errors")},
  "uptime": rd("uptime.log").splitlines(), "serverLateTicksOver3Periods": len(late),
  "shooterRttMs": sh["rttMedianMs"], "runnerRttMs": rn["rttMedianMs"],
  "verdict": ("PASS" if ok else "FAIL") if lc == "on" else "reported only (no pass bar)",
  "shots": s, "rawFiles": out}, indent=1))
PY
