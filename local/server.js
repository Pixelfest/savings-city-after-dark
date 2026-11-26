#!/usr/bin/env node
// Local Savings City: serves the saved app copy (../app), answers the /api calls from a city JSON
// file (in memory: edits in the app work until you restart) and injects the chosen userscripts
// before the app starts, like Tampermonkey at document-start.
//
//   node local/server.js [--city local/city.json] [--port 8080] [--plugins walk-mode,residents]
//
// Open http://localhost:8080/ (plugins from --plugins, default: all) or pick them per page load:
// http://localhost:8080/?plugins=graphics,nuke   (?plugins= for none). /plugins lists them.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app', 'Savings City_files');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(opt('port', process.env.PORT || 8080));
const CITY_FILE = path.resolve(opt('city', path.join(__dirname, 'city.json')));

// --- plugins -------------------------------------------------------------------------------
const PLUGINS = fs.readdirSync(ROOT)
  // Every savings-city-*.user.js except the Tampermonkey loader (it only @requires the others).
  .filter((f) => /^savings-city-.+\.user\.js$/.test(f) && f !== 'savings-city-after-dark.user.js')
  .map((f) => ({ id: f.replace(/^savings-city-|\.user\.js$/g, ''), file: f,
    name: (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/@name\s+(.+)/) || [])[1] || f }));
// Load order matters a little: walk mode before the scripts that register weapons with it.
const ORDER = ['core', 'buildings', 'bodycount', 'car-tyres', 'auto-layout', 'graphics', 'walk-mode', 'residents', 'rocket-launcher', 'flamethrower', 'cops', 'heli-crane', 'billboard', 'drive', 'nuke', 'monster'];
PLUGINS.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));
const DEFAULT_PLUGINS = opt('plugins', PLUGINS.map((p) => p.id).join(','));

function pickPlugins(query) {
  const list = query.has('plugins') ? query.get('plugins') : DEFAULT_PLUGINS;
  const want = new Set(list.split(',').map((s) => s.trim()).filter(Boolean));
  for (const w of want) if (!PLUGINS.some((p) => p.id === w)) console.warn(`unknown plugin "${w}"`);
  return PLUGINS.filter((p) => want.has(p.id));
}

// --- city state (in memory) ----------------------------------------------------------------
const loaded = JSON.parse(fs.readFileSync(CITY_FILE, 'utf8'));
const city = { projects: loaded.projects || [], roads: new Set(loaded.roads || []), revision: loaded.revision || 1 };
const cityJson = () => ({ projects: city.projects, roads: [...city.roads], revision: city.revision,
  server_time: new Date().toISOString() });
const bump = () => { city.revision++; };

function api(method, p, body) {
  const now = new Date().toISOString();
  let m;
  if (method === 'GET' && p === '/city') return [200, cityJson()];
  if (method === 'GET' && p === '/city/revision') return [200, city.revision];
  if (p === '/roads') {
    for (const k of body.keys || []) method === 'POST' ? city.roads.add(k) : city.roads.delete(k);
    bump(); return [204];
  }
  if (method === 'POST' && p === '/projects') {
    const pr = { id: require('crypto').randomUUID(), gx: null, gy: null, facing: 0, link: null, authors: [],
      construction_started_at: null, completed_at: null, open_for_placement: false, ...body, created_at: now, updated_at: now };
    city.projects.push(pr); bump(); return [201, pr];
  }
  if ((m = p.match(/^\/projects\/([^/]+)(\/placement)?$/))) {
    const id = decodeURIComponent(m[1]);
    const i = city.projects.findIndex((x) => x.id === id);
    if (method === 'PUT' && !m[2]) { // restore
      const pr = { ...body, updated_at: now };
      if (i >= 0) city.projects[i] = pr; else city.projects.push(pr);
      bump(); return [200, pr];
    }
    if (i < 0) return [404, { detail: 'Project niet gevonden.' }];
    const pr = city.projects[i];
    if (method === 'DELETE') { city.projects.splice(i, 1); bump(); return [204]; }
    if (method === 'PATCH') { Object.assign(pr, body, { updated_at: now }); bump(); return [200, pr]; }
    if (method === 'PUT' && m[2]) {
      const pl = body.placement;
      Object.assign(pr, pl ? { gx: pl.gx, gy: pl.gy, facing: pl.facing ?? pr.facing } : { gx: null, gy: null },
        body.patch || {}, { updated_at: now });
      if (pl) pr.open_for_placement = false;
      for (const k of (body.roads && body.roads.remove) || []) city.roads.delete(k);
      for (const k of (body.roads && body.roads.add) || []) city.roads.add(k);
      bump(); return [200, pr];
    }
  }
  return [404, { detail: `Onbekende API-call ${method} ${p}` }];
}

// --- page ----------------------------------------------------------------------------------
// The app's main bundle (its name changes with every app build): the index-*.js in the saved copy.
const INDEX_JS = fs.readdirSync(APP).find((f) => /^index-.*\.js$/.test(f));
const INDEX_CSS = fs.readdirSync(APP).find((f) => /^index-.*\.css$/.test(f));

const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function page(plugins) {
  const tags = plugins.map((p) => `<script src="/plugins/${p.file}"></script>`).join('\n    ');
  return `<!DOCTYPE html>
<html lang="nl"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="/assets/css2" rel="stylesheet">
    <title>Savings City (lokaal)</title>
    <!-- userscripts (document-start): ${plugins.map((p) => p.id).join(', ') || 'none'} -->
    ${tags}
    <script type="module" src="/assets/${INDEX_JS}"></script>
    <link rel="stylesheet" href="/assets/${INDEX_CSS}">
  </head>
  <body data-skin="cartoon"><div id="root"></div></body></html>`;
}

function pluginIndex() {
  const rows = PLUGINS.map((p) => `<label><input type="checkbox" value="${p.id}"
    ${DEFAULT_PLUGINS.split(',').includes(p.id) ? 'checked' : ''}> <b>${p.id}</b> – ${p.name}</label>`).join('<br>');
  return `<!DOCTYPE html><meta charset="UTF-8"><title>Plugins</title>
<body style="font:15px system-ui;margin:2em;line-height:1.8"><h2>Savings City lokaal – plugins</h2>${rows}
<p><button onclick="location.href='/?plugins='+[...document.querySelectorAll('input:checked')].map(i=>i.value).join(',')">Open stad</button></p>
<p>City: ${CITY_FILE} (${city.projects.length} projecten, ${city.roads.size} wegvakken)</p>`;
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.html': 'text/html' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const [status, body] = api(req.method, p.slice(4), raw ? JSON.parse(raw) : {});
        if (req.method !== 'GET') console.log(req.method, p, '→', status, '(revision', city.revision + ')');
        send(res, status, body);
      } catch (e) { send(res, 500, { detail: String(e) }); }
    });
    return;
  }
  if (p === '/' || p === '/index.html') return send(res, 200, page(pickPlugins(url.searchParams)), 'text/html; charset=utf-8');
  if (p === '/plugins' || p === '/plugins/') return send(res, 200, pluginIndex(), 'text/html; charset=utf-8');
  let file = null;
  if (p.startsWith('/plugins/')) file = PLUGINS.find((x) => '/plugins/' + x.file === p) && path.join(ROOT, p.slice(9));
  // The bundles import each other and the logo relative to themselves (./CityCanvas-*.js, ./logo.webp).
  else if (p.startsWith('/assets/')) file = path.join(APP, path.basename(p));
  else if (p === '/logo.webp') file = path.join(APP, 'logo.webp');
  if (file && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || (p.endsWith('css2') ? 'text/css' : 'application/octet-stream'));
  // Loading-screen images (logo/*.png) and the favicon aren't in the saved copy.
  if (/\.(png|ico)$/.test(p)) return send(res, 200, TRANSPARENT_PNG, 'image/png');
  send(res, 404, 'not found', 'text/plain');
}).listen(PORT, () => {
  console.log(`Savings City lokaal: http://localhost:${PORT}/  (plugins kiezen: http://localhost:${PORT}/plugins)`);
  console.log(`city: ${CITY_FILE} – ${city.projects.length} projects, ${city.roads.size} roads`);
  console.log(`default plugins: ${DEFAULT_PLUGINS || '(none)'}`);
});
