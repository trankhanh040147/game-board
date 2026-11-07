#!/usr/bin/env node
/**
 * Tiny zero-dependency static file server for local play.
 *
 *   npm run serve
 *   PORT=3000 npm run serve
 *
 * Serves the repository root. No directory listing and no path traversal:
 * unknown paths get a small 404 page.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function notFound(response) {
  response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
      '<style>body{background:#070b14;color:#9fb3c8;font:16px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0}</style>' +
      '<p>404 — not found</p>',
  );
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = resolve(ROOT, `.${pathname}`);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      notFound(response);
      return;
    }

    const info = await stat(filePath);
    if (!info.isFile()) {
      notFound(response);
      return;
    }

    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    notFound(response);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Apex Drift running at http://${HOST}:${PORT}/`);
});
