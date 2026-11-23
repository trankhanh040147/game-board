import { defineConfig } from "vite";

const server = process.env.NETLAB_SERVER ?? "http://localhost:8080";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { main: "index.html", concepts: "concepts.html" } },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/ws": { target: server, ws: true, changeOrigin: true },
      "/api": { target: server, changeOrigin: true },
    },
  },
});
