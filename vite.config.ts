import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
