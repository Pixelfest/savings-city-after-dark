#!/usr/bin/env node
// Serves app/ for local development and testing, with the city data from examples/city.json.
//
//   npm run dev                       → http://localhost:8080
//   npm run dev -- --port 9000 --city <file.json>
//
// GET /api/city returns the city file (the app loads its whole city from that one request).
// Other GET /api/... requests get 404. Other methods on /api/... get 204 and are discarded,
// so the app can save without the dev server keeping any state.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = Number(arg('--port', process.env.PORT || 8080));
const cityFile = resolve(root, arg('--city', join('examples', 'city.json')));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    if (path === '/api/city') {
      try { return send(res, 200, await readFile(cityFile), TYPES['.json']); }
      catch { return send(res, 500, `cannot read ${cityFile}`); }
    }
    return send(res, 404, 'not found');
  }

  let file = join(appDir, path === '/' ? 'index.html' : path);
  if (!file.startsWith(appDir + sep)) return send(res, 403, 'forbidden');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    return send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found (did you run `npm run sync -- <app folder>` first?)');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Savings City dev server: http://localhost:${port}  (city: ${cityFile})`);
});
