#!/bin/sh
# P20 cable-cut drill (A.12): keep beacon traffic flowing (bin/beaconbot), cut the cables to sg, and log what
# Prometheus sees every 10 s: the ISPRouteP95High alert state from /api/v1/alerts and the sg mean / p95 / p99 per
# ISP from the recording rules. Routes are simulated; RTTs are measured by the bots over them.
#
#   NETLAB_ADMIN_TOKEN=lab sh scripts/cable-cut-drill.sh http://127.0.0.1:8091 https://127.0.0.1:8454 http://127.0.0.1:9090
#   env: N (players, 30), BASE_S (60), CUT_S (180), AFTER_S (120), OUT (bin/drill)
# Only the beaconbot this script starts is stopped (by PID). Needs bin/beaconbot (make infra) and python3.
set -e
INFRA="${1:?infra http base}"; WT="${2:-}"; PROM="${3:?prometheus base}"
N="${N:-30}"; BASE_S="${BASE_S:-60}"; CUT_S="${CUT_S:-180}"; AFTER_S="${AFTER_S:-120}"; OUT="${OUT:-bin/drill}"
: "${NETLAB_ADMIN_TOKEN:?NETLAB_ADMIN_TOKEN must match the infra server}"
TOTAL=$((BASE_S + CUT_S + AFTER_S))
mkdir -p "$(dirname "$OUT")"
set -- -base "$INFRA" -n "$N" -d "${TOTAL}s" -cut-at "${BASE_S}s" -cut-for "${CUT_S}s" -ticket=false
[ -n "$WT" ] && set -- "$@" -wt "$WT"
perl -e 'alarm shift; exec @ARGV' $((TOTAL + 60)) bin/beaconbot "$@" > "$OUT.summary.jsonl" 2> "$OUT.bot.log" &
BOT=$!
echo "$BOT" > "$OUT.bot.pid"
trap 'kill "$BOT" 2>/dev/null; rm -f "$OUT.bot.pid"' EXIT INT TERM
START=$(date +%s)
echo "drill: baseline ${BASE_S}s, cut ${CUT_S}s, recovery ${AFTER_S}s, $N players, beaconbot pid $BOT" | tee "$OUT.log"
while kill -0 "$BOT" 2>/dev/null; do
  sleep 10
  T=$(( $(date +%s) - START ))
  python3 - "$PROM" "$INFRA" "$T" <<'PY' | tee -a "$OUT.log"
import json, sys, urllib.request, urllib.parse
prom, infra, t = sys.argv[1], sys.argv[2], sys.argv[3]
get = lambda u: json.load(urllib.request.urlopen(u, timeout=5))
q = lambda e: {r["metric"]["isp"]: float(r["value"][1]) for r in get(prom + "/api/v1/query?query=" + urllib.parse.quote(e))["data"]["result"]}
cut = get(infra + "/api/regions")["cableCut"]
alerts = [f'{a["labels"]["region"]}/{a["labels"]["isp"]} {a["state"].upper()} since {a["activeAt"][11:19]}Z value {float(a["value"]):.0f}'
          for a in get(prom + "/api/v1/alerts")["data"]["alerts"] if a["labels"].get("alertname") == "ISPRouteP95High"]
mean, p95, p99 = (q(f'netlab:rtt_ms:{k}_1m{{region="sg"}}') for k in ("mean", "p95", "p99"))
fmt = lambda d: " ".join(f"{k} {v:.0f}" for k, v in sorted(d.items())) or "no series"
print(f"t={t:>4}s cut={'ON ' if cut else 'off'} | sg mean: {fmt(mean)} | p95: {fmt(p95)} | p99: {fmt(p99)} | alerts: {'; '.join(alerts) or 'none'}")
PY
done
wait "$BOT" || true
echo "per region x ISP x cable-cut state (bot samples):" | tee -a "$OUT.log"
cat "$OUT.summary.jsonl" | tee -a "$OUT.log"
