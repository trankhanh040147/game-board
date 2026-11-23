// B.9 check 1, WASM side: replay the recorded input stream through the WASM
// build (the same sim.wasm the browser loads) and print "<hz> <tick> <hash>",
// the format cmd/simtrace prints natively.
// Usage: node wasm/test/determinism.mjs <sim.wasm> <wasm_exec.js> <inputs.bin>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [wasmPath, execPath, inputsPath] = process.argv.slice(2);
await import(pathToFileURL(execPath).href); // defines globalThis.Go
const go = new globalThis.Go();
const ready = new Promise((r) => (globalThis.onNetcodeSimReady = r));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject);
go.run(instance); // runs until select{}; NetcodeSim is set before that
await ready;
const S = globalThis.NetcodeSim;

const b = readFileSync(inputsPath);
if (b.toString("latin1", 0, 4) !== "NLIN") throw new Error("bad input stream");
const n = b.readUInt32LE(4);
const inputs = [];
for (let i = 0; i < n; i++) {
  const o = 8 + i * 6;
  inputs.push({ buttons: b.readUInt16LE(o), yaw: b.readInt16LE(o + 2), pitch: b.readInt16LE(o + 4) });
}
const map = JSON.parse(S.mapJSON);
const spawn = map.spawns.blue[0].map((v) => Math.round(v * S.FX));
const out = [];
for (const hz of [20, 30, 64, 128]) {
  let s = { x: spawn[0], y: spawn[1], z: spawn[2], vx: 0, vy: 0, vz: 0, onGround: true, yaw: 0, pitch: 0 };
  const dt = S.dtForRate(hz);
  for (let i = 0; i < n; i++) {
    s = S.step(s, inputs[i], dt);
    out.push(`${hz} ${i} ${S.hash(s)}`);
  }
}
process.stdout.write(out.join("\n") + "\n");
process.exit(0);
