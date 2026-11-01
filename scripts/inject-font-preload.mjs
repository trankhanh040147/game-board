#!/usr/bin/env node
// Post-build step: preload the two fonts used above the fold so the swap does not
// shift layout (the exhibit/home hero sets a headline in Newsreader and every
// figure in IBM Plex Mono). Font file names are content-hashed by Vite, so this
// reads the emitted directory instead of hard-coding them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const assets = join(dist, 'assets');
const wanted = [/^newsreader-latin-wght-normal-.*\.woff2$/, /^ibm-plex-mono-latin-400-normal-.*\.woff2$/];

const files = readdirSync(assets).filter((f) => wanted.some((re) => re.test(f)));
if (!files.length) {
  console.error('inject-font-preload: no matching font files found in dist/assets');
  process.exit(1);
}

const indexPath = join(dist, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const links = files
  .filter((f) => !html.includes(f))
  .map((f) => `<link rel="preload" href="/assets/${f}" as="font" type="font/woff2" crossorigin />`)
  .join('\n    ');

if (!links) {
  console.log('inject-font-preload: already injected');
  process.exit(0);
}
html = html.replace('</head>', `    ${links}\n  </head>`);
writeFileSync(indexPath, html);
console.log(`inject-font-preload: preloaded ${files.length} font(s): ${files.join(', ')}`);
