// Duel mini-mode page (M8), built separately from the shooter client so the two never share an entry point.
//   dev:   npx vite --config vite.duel.config.ts        -> http://127.0.0.1:5174/duel.html (proxies to bin/duelrelay :8090)
//   build: npx vite build --config vite.duel.config.ts  -> ../bin/duel-www (bin/duelrelay serves it)
import { defineConfig } from "vite";

const relay = process.env.NETLAB_DUEL_RELAY ?? "http://localhost:8090";

export default defineConfig(({ command }) => ({
  base: "./",
  // Dev serves client/public (duel.wasm, wasm_exec.js); the build copies only those two (Makefile duel-www).
  publicDir: command === "build" ? false : "public",
  build: { outDir: "../bin/duel-www", emptyOutDir: true, rollupOptions: { input: { duel: "duel.html" } } },
  server: {
    host: "127.0.0.1",
    port: 5174,
    fs: { allow: [".."] },
    proxy: {
      "/duel/ws": { target: relay, ws: true, changeOrigin: true },
      "/api/duel": { target: relay, changeOrigin: true },
    },
  },
}));
