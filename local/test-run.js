#!/usr/bin/env node
// One repeatable test in the test city (/test, see local/test-scene.js): open it with the chosen
// scripts, optionally start walking and stand somewhere, run an action at a known random state, and
// take screenshots at set game times after it. Prints a JSON report (sc:kill / sc:blast / sc:shot
// events, deaths, what the action returned) and writes it to <out>/report.json. Start
// local/server.js first.
//
//   node local/test-run.js --plugins core,walk-mode,residents,rocket-launcher \
//     --walk 7,1.6 --look 9,0.05,0.2 --do "scResidents.blast(5, 0.2, 0.6, 2.5, 8, 0.3)" \
//     --at 0,1,3 --out /tmp/run [--seed 1] [--query "people=40&cops=0"] [--before "js"]
//
// --walk x,z      start walk mode and stand at (x, z) (world tiles; the ring road is x 0…16, y 0…8,
//                 people stand in rows at z ±0.205 and 8 ±0.205, officers at x 15.8, cars on z 8)
// --look x,y,z    look at that point (with --walk)
// --before "js"   runs in the page first (set things up; may return a promise)
// --do "js"       the action: runs right after scTest.reseed(), in a fresh frame (may return a promise)
// --at 0,1,3      screenshots at these game seconds after the action (shot-<s>.png)
// Game time, not wall-clock time: headless Chromium runs the fixed 1/60 s step in slow motion.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const nums = (s) => (s ? s.split(',').map(Number) : null);
const plugins = opt('plugins', 'core,walk-mode,residents,cops');
const outDir = path.resolve(opt('out', path.join(__dirname, '..', 'incoming', 'test-run')));
const base = process.env.TEST_URL || 'http://localhost:8123/';
const query = [`plugins=${plugins}`, opt('seed') ? `seed=${opt('seed')}` : '', opt('query', '')].filter(Boolean).join('&');
const walk = nums(opt('walk')), look = nums(opt('look'));
const before = opt('before'), action = opt('do');
const times = nums(opt('at', '0,1,3'));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  page.on('console', (m) => { if (/\[test\]|error|warn/i.test(m.type() + m.text()) && !/GL Driver|willReadFrequently/.test(m.text())) console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    window.__events = [];
    for (const t of ['sc:shot', 'sc:kill', 'sc:blast', 'sc:car-exploded']) window.addEventListener(t, (e) => window.__events.push({ type: t, frame: window.scTest && window.scTest.frame(), detail: e.detail }));
  });
  await page.goto(new URL('test?' + query, base).href);
  await page.waitForFunction(() => window.scTest && window.scTest.ready, null, { timeout: 120000 });
  if (walk) {
    await page.waitForSelector('#sc-walk-toggle', { timeout: 60000 });
    await page.evaluate(() => document.querySelector('#sc-walk-toggle').click());
    await page.evaluate(() => scTest.whenCops);
    await page.evaluate(([w, l]) => { scWalk.moveTo(w[0], w[1]); if (l) scWalk.lookAt(l[0], l[1], l[2]); }, [walk, look]);
  }
  if (before) console.log('before →', await page.evaluate(before));
  await page.evaluate(() => scTest.frames(2));
  const result = action ? await page.evaluate(async (js) => {
    await scTest.frames(1);
    scTest.reseed();
    window.__t0 = scTest.time(); window.__events.length = 0;
    try { const r = await (0, eval)(js); return r === undefined ? null : JSON.parse(JSON.stringify(r)); } catch (e) { return { error: String(e) }; }
  }, action) : null;
  if (!action) await page.evaluate(() => { window.__t0 = scTest.time(); });
  for (const s of times) {
    await page.evaluate((s) => scTest.wait(window.__t0 + s - scTest.time()), s);
    const file = path.join(outDir, `shot-${s}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
  }
  const report = await page.evaluate((result) => ({
    url: location.href, seed: scTest.seed, result, frame: scTest.frame(),
    deaths: window.scResidents ? window.scResidents.deaths : undefined,
    events: window.__events,
  }), result);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, events: report.events.length + ' events (see report.json)' }));
  await browser.close();
})();
