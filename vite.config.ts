import { defineConfig } from 'vite'

// The board is a single-page app served with a catch-all rewrite (see vercel.json),
// so assets are referenced from the site root. `base: './'` would resolve
// `/making-of/<slug>` to `/making-of/assets/...` and break every deep link.
export default defineConfig({
  base: '/',
  build: {
    target: 'es2020',
    cssMinify: true,
    reportCompressedSize: true,
    assetsInlineLimit: 4096,
  },
  server: { host: '127.0.0.1', port: 5199 },
  preview: { host: '127.0.0.1', port: 5200 },
})
