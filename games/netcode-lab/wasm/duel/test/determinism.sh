#!/bin/sh
# B.9 check 1 for the duel: one recorded two-player input stream, a hash per
# frame for a plain run and for both peers of rollback and lockstep sessions,
# compared across native (host arch), amd64 (Rosetta on Apple Silicon) and WASM in Node.
set -e
BIN="$1"
PUBLIC="$2"
IN=sim/duel/testdata/inputs.bin
"$BIN/dueltrace" -in "$IN" > "$BIN/duel-trace-native.txt"
HAVE_AMD64=no
if [ "$(go env GOARCH)" = amd64 ]; then
  cp "$BIN/duel-trace-native.txt" "$BIN/duel-trace-amd64.txt"; HAVE_AMD64=yes
elif arch -x86_64 /usr/bin/true 2>/dev/null; then
  arch -x86_64 "$BIN/dueltrace-amd64" -in "$IN" > "$BIN/duel-trace-amd64.txt"; HAVE_AMD64=yes
fi
node wasm/duel/test/determinism.mjs "$PUBLIC/duel.wasm" "$PUBLIC/wasm_exec.js" "$IN" > "$BIN/duel-trace-wasm.txt"
sum() { shasum -a 256 "$1" | cut -c1-16; }
echo "duel native ($(go env GOARCH)): $(wc -l < "$BIN/duel-trace-native.txt") lines  sha256 $(sum "$BIN/duel-trace-native.txt")"
[ "$HAVE_AMD64" = yes ] && echo "duel amd64 (Rosetta): $(wc -l < "$BIN/duel-trace-amd64.txt") lines  sha256 $(sum "$BIN/duel-trace-amd64.txt")"
echo "duel wasm (node $(node --version)): $(wc -l < "$BIN/duel-trace-wasm.txt") lines  sha256 $(sum "$BIN/duel-trace-wasm.txt")"
echo "duel last plain frame: $(grep '^plain ' "$BIN/duel-trace-native.txt" | tail -1)"
echo "duel $(tail -1 "$BIN/duel-trace-native.txt")"
FAIL=0
tail -1 "$BIN/duel-trace-native.txt" | grep -q 'mismatches 0$' || { echo "FAIL duel sessions != plain run"; FAIL=1; }
if cmp -s "$BIN/duel-trace-native.txt" "$BIN/duel-trace-wasm.txt"; then echo "PASS duel native == wasm on every frame (plain, rollback D0/D2, lockstep D2, both peers)"; else echo "FAIL duel native != wasm"; cmp "$BIN/duel-trace-native.txt" "$BIN/duel-trace-wasm.txt" || true; FAIL=1; fi
if [ "$HAVE_AMD64" = yes ]; then
  if cmp -s "$BIN/duel-trace-native.txt" "$BIN/duel-trace-amd64.txt"; then echo "PASS duel native == amd64 on every frame"; else echo "FAIL duel native != amd64"; FAIL=1; fi
else
  echo "SKIP duel amd64: no amd64 runner on this host"
fi
exit $FAIL
