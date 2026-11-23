#!/bin/sh
# B.9 check 1: one recorded input stream, state hash per tick, compared across
# native (host arch), amd64 (Rosetta on Apple Silicon) and WASM in Node.
set -e
BIN="$1"
PUBLIC="$2"
IN=sim/testdata/inputs.bin
"$BIN/simtrace" -in "$IN" > "$BIN/trace-native.txt"
HAVE_AMD64=no
if [ "$(go env GOARCH)" = amd64 ]; then
  cp "$BIN/trace-native.txt" "$BIN/trace-amd64.txt"; HAVE_AMD64=yes
elif arch -x86_64 /usr/bin/true 2>/dev/null; then
  arch -x86_64 "$BIN/simtrace-amd64" -in "$IN" > "$BIN/trace-amd64.txt"; HAVE_AMD64=yes
fi
node wasm/test/determinism.mjs "$PUBLIC/sim.wasm" "$PUBLIC/wasm_exec.js" "$IN" > "$BIN/trace-wasm.txt"
sum() { shasum -a 256 "$1" | cut -c1-16; }
echo "go:     $(go version)"
echo "native ($(go env GOARCH)):  $(wc -l < "$BIN/trace-native.txt") lines  sha256 $(sum "$BIN/trace-native.txt")"
[ "$HAVE_AMD64" = yes ] && echo "amd64 (Rosetta): $(wc -l < "$BIN/trace-amd64.txt") lines  sha256 $(sum "$BIN/trace-amd64.txt")"
echo "wasm (node $(node --version)): $(wc -l < "$BIN/trace-wasm.txt") lines  sha256 $(sum "$BIN/trace-wasm.txt")"
echo "last tick: $(tail -1 "$BIN/trace-native.txt")"
FAIL=0
if cmp -s "$BIN/trace-native.txt" "$BIN/trace-wasm.txt"; then echo "PASS native == wasm on every tick (rates 20/30/64/128)"; else echo "FAIL native != wasm"; cmp "$BIN/trace-native.txt" "$BIN/trace-wasm.txt" || true; FAIL=1; fi
if [ "$HAVE_AMD64" = yes ]; then
  if cmp -s "$BIN/trace-native.txt" "$BIN/trace-amd64.txt"; then echo "PASS native == amd64 on every tick"; else echo "FAIL native != amd64"; FAIL=1; fi
else
  echo "SKIP amd64: no amd64 runner on this host"
fi
exit $FAIL
