#!/bin/sh
# Linux only (tc netem; needs root or CAP_NET_ADMIN). On macOS use the in-process conditioner instead.
# A.12: simulate a Vietnam -> Singapore route in CI, normally and during a cable cut.
#
#   sudo sh scripts/netem.sh <iface> vn-sg            # 40 ms RTT, jitter 4, loss 0.2%   (simulated)
#   sudo sh scripts/netem.sh <iface> vn-sg-cable-cut  # 120 ms RTT, jitter 25, loss 3%   (simulated)
#   sudo sh scripts/netem.sh <iface> clear
# netem applies on egress only, so the delay below is the whole round trip added on this host.
set -e
[ "$(uname -s)" = Linux ] || { echo "netem.sh: Linux only (tc netem). This host is $(uname -s)." >&2; exit 2; }
IF="${1:?usage: netem.sh <iface> vn-sg|vn-sg-cable-cut|clear}"
case "${2:?profile}" in
  vn-sg)           tc qdisc replace dev "$IF" root netem delay 40ms 4ms distribution normal loss 0.2% ;;
  vn-sg-cable-cut) tc qdisc replace dev "$IF" root netem delay 120ms 25ms distribution normal loss 3% ;;
  clear)           tc qdisc del dev "$IF" root 2>/dev/null || true ;;
  *) echo "unknown profile $2" >&2; exit 2 ;;
esac
tc qdisc show dev "$IF"
