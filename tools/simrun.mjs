#!/usr/bin/env node
/**
 * Thin wrapper so `npm run sim -- --seed demo --days 300 --autoplay` works.
 * The real harness is tools/simrun.ts (run through vite-node for TS + aliases).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const viteNode = join(root, 'node_modules', '.bin', 'vite-node');
const script = join(here, 'simrun.ts');

const child = spawn(viteNode, [script, '--', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
