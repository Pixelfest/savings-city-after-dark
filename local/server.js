#!/usr/bin/env node
// Local Savings City: serves the saved app copy (../app), answers the /api calls from a city JSON
// file (in memory: edits in the app work until you restart) and injects the chosen userscripts
// before the app starts, like Tampermonkey at document-start.
//
//   node local/server.js [--city local/city.json] [--test-city local/test-city.json] [--port 8080]
//                        [--plugins walk-mode,residents]
//
// Open http://localhost:8080/ (plugins from --plugins, default: all) or pick them per page load:
// http://localhost:8080/?plugins=graphics,nuke   (?plugins= for none). /plugins lists them.
//
// Test mode: http://localhost:8080/test (same ?plugins=) opens the small test city (3 buildings)
// with local/test-scene.js injected before the plugins: seeded Math.random, a fixed frame step,
// a fixed clock, ~100 people standing still, officers and cars lined up. The test city has its
// own state, reset from its file on every load of /test; API calls are routed to it by the page
// they come from (Referer /test…). Options: see local/test-scene.js.
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
const TEST_CITY_FILE = path.resolve(opt('test-city', path.join(__dirname, 'test-city.json')));
const TEST_SCENE = path.join(__dirname, 'test-scene.js');

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
function loadCity(file) {
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { file, projects: loaded.projects || [], roads: new Set(loaded.roads || []), water: new Set(loaded.water || []),
    revision: loaded.revision || 1 };
}
const mainCity = loadCity(CITY_FILE);
let testCity = loadCity(TEST_CITY_FILE);
const cityJson = (city) => ({ projects: city.projects, roads: [...city.roads], water: [...city.water], revision: city.revision,
  server_time: new Date().toISOString() });

function api(city, method, p, body) {
  const now = new Date().toISOString();
  const bump = () => { city.revision++; };
  let m;
  if (method === 'GET' && p === '/city') return [200, cityJson(city)];
  if (method === 'GET' && p === '/city/revision') return [200, city.revision];
  if (method === 'GET' && p === '/city/changes') return [204];   // the page reloads to see changes
  if (p === '/roads') {
    for (const k of body.keys || []) method === 'POST' ? city.roads.add(k) : city.roads.delete(k);
    bump(); return [204];
  }
  if (p === '/water') {
    for (const k of body.keys || []) method === 'POST' ? city.water.add(k) : city.water.delete(k);
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

function page(plugins, test) {
  const tags = (test ? ['<script src="/local/test-scene.js"></script>'] : [])
    .concat(plugins.map((p) => `<script src="/plugins/${p.file}"></script>`)).join('\n    ');
  return `<!DOCTYPE html>
<html lang="nl"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="/assets/css2" rel="stylesheet">
    <title>Savings City (${test ? 'teststad' : 'lokaal'})</title>
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
<p><button onclick="location.href='/?plugins='+[...document.querySelectorAll('input:checked')].map(i=>i.value).join(',')">Open stad</button>
<button onclick="location.href='/test?plugins='+[...document.querySelectorAll('input:checked')].map(i=>i.value).join(',')">Open teststad</button></p>
<p>City: ${CITY_FILE} (${mainCity.projects.length} projecten, ${mainCity.roads.size} wegvakken)<br>
Teststad: ${TEST_CITY_FILE} (${testCity.projects.length} projecten, ${testCity.roads.size} wegvakken)</p>`;
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
    // Calls from the test page (/test…) go to the test city.
    let from = '';
    try { from = new URL(req.headers.referer || '').pathname; } catch {}
    const city = /^\/test(\/|$)/.test(from) ? testCity : mainCity;
    req.on('end', () => {
      try {
        const [status, body] = api(city, req.method, p.slice(4), raw ? JSON.parse(raw) : {});
        if (req.method !== 'GET') console.log(req.method, p, '→', status, `(${city === testCity ? 'test city, ' : ''}revision`, city.revision + ')');
        send(res, status, body);
      } catch (e) { send(res, 500, { detail: String(e) }); }
    });
    return;
  }
  if (p === '/' || p === '/index.html') return send(res, 200, page(pickPlugins(url.searchParams)), 'text/html; charset=utf-8');
  if (p === '/test' || p === '/test/') {
    testCity = loadCity(TEST_CITY_FILE);   // every test run starts from the same city
    return send(res, 200, page(pickPlugins(url.searchParams), true), 'text/html; charset=utf-8');
  }
  if (p === '/local/test-scene.js') return send(res, 200, fs.readFileSync(TEST_SCENE), 'text/javascript');
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
  console.log(`city: ${CITY_FILE} – ${mainCity.projects.length} projects, ${mainCity.roads.size} roads`);
  console.log(`test city: http://localhost:${PORT}/test – ${TEST_CITY_FILE}, ${testCity.projects.length} projects`);
  console.log(`default plugins: ${DEFAULT_PLUGINS || '(none)'}`);
});
