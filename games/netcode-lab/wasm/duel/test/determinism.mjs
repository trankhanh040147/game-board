// B.9 check 1 for the duel, WASM side: run the recorded duel input stream
// through duel.wasm and print the trace lines cmd/dueltrace prints natively.
// Usage: node wasm/duel/test/determinism.mjs <duel.wasm> <wasm_exec.js> <inputs.bin>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [wasmPath, execPath, inputsPath] = process.argv.slice(2);
await import(pathToFileURL(execPath).href);
const go = new globalThis.Go();
const ready = new Promise((r) => (globalThis.onNetcodeDuelReady = r));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject);
go.run(instance);
await ready;
process.stdout.write(globalThis.NetcodeDuel.traceLines(new Uint8Array(readFileSync(inputsPath))));
process.exit(0);
