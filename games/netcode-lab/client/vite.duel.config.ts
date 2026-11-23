// Duel mini-mode (M8) and regions/matchmaking (M7) pages, built separately from the shooter client so the two never share an entry point.
//   dev:   npx vite --config vite.duel.config.ts        -> http://127.0.0.1:5174/duel.html (proxies to bin/duelrelay :8090)
//   build: npx vite build --config vite.duel.config.ts  -> ../bin/duel-www (bin/duelrelay serves it)
import { defineConfig } from "vite";

const relay = process.env.NETLAB_DUEL_RELAY ?? "http://localhost:18720"; // bin/infra (or bin/duelrelay)

export default defineConfig(({ command }) => ({
  base: "./",
  // Dev serves client/public (duel.wasm, wasm_exec.js); the build copies only those two (Makefile duel-www).
  publicDir: command === "build" ? false : "public",
  build: { outDir: "../bin/duel-www", emptyOutDir: true, rollupOptions: { input: { duel: "duel.html", infra: "infra.html" } } },
  server: {
    host: "127.0.0.1",
    port: 5174,
    fs: { allow: [".."] },
    proxy: {
      "/duel/ws": { target: relay, ws: true, changeOrigin: true },
      "/api/duel": { target: relay, changeOrigin: true },
      "/api/regions": { target: relay, changeOrigin: true },
      "/api/infra": { target: relay, changeOrigin: true },
      "/api/mm": { target: relay, changeOrigin: true },
      "/beacon": { target: relay, ws: true, changeOrigin: true },
    },
  },
}));
