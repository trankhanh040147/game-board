"""Summarise one check2-reconcile.sh output dir: bot result next to host context.
Usage: python3 -I scripts/check2-summary.py <out-dir> <ws|wt> <lab-settings or 'defaults'>"""
import json, re, sys

out, mode, lab = sys.argv[1:]
rd = lambda f: open(f"{out}/{f}").read().strip()
bot = json.load(open(f"{out}/bot.json"))
b = bot["perBot"][0]
st = bot.get("serverTick", {})
probe = json.load(open(f"{out}/probe.json"))
log = rd("server.log").splitlines()
join = next((i for i, l in enumerate(log) if "msg=join" in l and "harness-admin" not in l), 0)
leave = next((i for i, l in enumerate(log) if "msg=leave" in l and i > join and "harness-admin" not in l), len(log))
late = []
for l in log[join:leave]:
    if "tick started late" in l:
        late.append((re.search(r"time=\S+T(\d\d:\d\d:\d\d\.\d+)", l).group(1)[:12], float(re.search(r"lateMs=([\d.]+)", l).group(1))))
loads = [float(m.group(1)) for m in (re.search(r"load averages?: ([\d.]+)", l) for l in open(f"{out}/uptime.log")) if m]
ww = st.get("wholeWindow") or {}
print(json.dumps({
    "commit": rd("commit").splitlines(), "start": rd("start"), "end": rd("end"),
    "serverPid": rd("server.pid"), "serverAliveAtEnd": rd("server.alive") == "alive", "botErrors": b.get("errors"),
    "transport": mode, "lab": lab, "tickRate": b["tickRate"], "seconds": b["seconds"],
    "corrections": b["corrections"], "serverStarvedTicks": b["serverStarvedTicks"],
    "serverInputBuffer (stats: starved = repeated, heldLate = held one tick, heldOnStall)": st.get("youInputBuffer"),
    "pacerRaises": b["pacerRaises"], "pacerMarginTicksAtEnd": b["pacerMarginTicks"],
    "rttMedianMs": b["rttMedianMs"], "jitterMs": b["jitterMs"], "maxSnapshotGapMs": b["maxSnapshotGapMs"],
    "cond": b.get("condAtWelcome"),
    "serverLateTicksOver3Periods": {"count": len(late), "maxMs": max((x[1] for x in late), default=0), "at": [f"{t} {ms}" for t, ms in late][:60]},
    "correctionTimes": (b.get("correctionTimes") or [])[:60],
    "serverWholeWindowStartLateMs": ww.get("startLateMs"), "serverWholeWindowTickMs": ww.get("tickMs"),
    "catchUpTicks": st.get("catchUpTicks"), "scheduleResets": st.get("scheduleResets"),
    "probe": {"over1Period": probe["lateOver1PeriodTicks"], "over3Periods": probe["lateOver3PeriodTicks"], "lateMs": probe["lateMs"]},
    "loadAvg1m": {"first": loads[0] if loads else None, "min": min(loads, default=None), "max": max(loads, default=None),
                  "mean": round(sum(loads) / len(loads), 2) if loads else None, "last": loads[-1] if loads else None, "samples": len(loads)},
    "rawFiles": out}, indent=1))
