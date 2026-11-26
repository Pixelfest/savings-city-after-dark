#!/usr/bin/env node
// Test harness: fire at known locations, so a test doesn't have to search for a target or aim
// by eye. Start local/server.js first.
//
//   node local/harness.js [layout.json] [--out dir] [--plugins core,walk-mode,...]
//
// The layout file (default local/harness-layout.json) lists shots:
//   { "name": "...", "weapon": "5", "from": { "x", "z" }, "eye": 0.155,
//     "at": { "x", "y", "z" } }        // the point to aim at, in world coordinates
// For each shot the harness: opens the local city (once), locks the pointer, selects the weapon by
// its key, stands at `from`, looks exactly at `at` (scWalk.lookAt), fires once, waits, then writes a
// JSON report line (the sc:shot and sc:kill events, what the walker hit) and a screenshot.
// The report is printed and written to <out>/report.json.
//
// Known locations: `at` can come from the city data (a project's grid cell: gx, gy in
// local/city.json) or from a fixed point you choose. Residents and officers are placed by the
// game, so a shot at a person needs them frozen at a known place first (not done yet: see
// the `freeze` note in local/harness-layout.json).
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const plugins = opt('plugins', 'core,walk-mode,residents,cops,skinner');
const outDir = path.resolve(opt('out', path.join(__dirname, '..', 'incoming', 'harness')));
const layoutFile = path.resolve(args[0] || path.join(__dirname, 'harness-layout.json'));
const base = process.env.HARNESS_URL || 'http://localhost:8123/';

const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem('citysaver:welcome-seen', '1'); } catch {}
    window.__events = [];
    for (const t of ['sc:shot', 'sc:kill', 'sc:blast', 'sc:car-exploded']) window.addEventListener(t, (e) => window.__events.push({ type: t, detail: e.detail }));
  });
  await page.goto(`${base}?plugins=${plugins}`);
  await page.waitForFunction(() => window.scWalk && window.scWalk.weapon !== undefined, null, { timeout: 60000 });
  await page.waitForTimeout(9000);
  await page.evaluate(() => document.querySelector('#sc-walk-toggle') && document.querySelector('#sc-walk-toggle').click());
  await page.mouse.move(600, 375);
  await page.mouse.down(); await page.mouse.up();          // the first click takes the pointer lock
  await page.waitForTimeout(300);

  // place the test subjects first: { name, kind: "resident" | "officer", x, z }
  const placed = {};
  for (const sub of layout.place || []) {
    let r = -1;
    for (let tries = 0; tries < 15 && r < 0; tries++) {        // the scene may still be building
      r = await page.evaluate(({ kind, x, z }) => {
        try { return kind === 'officer' ? window.scCops.placeAt(x, z, 0) : window.scResidents.freeze(x, z, 0); } catch (e) { return -1; }
      }, sub);
      if (r < 0) await page.waitForTimeout(1000);
    }
    placed[sub.name] = { ...sub, index: r };
    console.log('placed', sub.name, sub.kind, 'index', r);
  }
  await page.waitForTimeout(300);

  const report = [];
  for (const shot of layout.shots) {
    // a shot may name a placed subject: stand `distance` (default 0.12) tiles west of it, look at its chest
    if (shot.target) {
      const t = placed[shot.target];
      const dist = shot.distance || 0.12;                  // tiles from the subject
      shot.from = { x: t.x - dist, z: t.z };
      shot.at = { x: t.x, y: 0.1, z: t.z };
    }
    await page.evaluate(({ from, eye, at, key }) => {
      const w = window.scWalk;
      w.moveTo(from.x, from.z);
      w.lookAt(at.x, at.y, at.z);
      window.__events.length = 0;
      window.__key = key;
    }, { from: shot.from, eye: shot.eye, at: shot.at, key: shot.weapon });
    await page.keyboard.press('Digit' + shot.weapon);
    await page.waitForTimeout(900);                        // the weapon swap
    await page.evaluate(({ from, at }) => { const w = window.scWalk; w.moveTo(from.x, from.z); w.lookAt(at.x, at.y, at.z); }, { from: shot.from, at: shot.at });
    await page.waitForTimeout(150);
    const weapon = await page.evaluate(() => window.scWalk.weapon);
    await page.mouse.down(); await page.mouse.up();        // the shot
    // headless: the click re-takes the pointer lock and the view jumps; the shot already went
    // off along the aim, so aim again for the pictures
    await page.evaluate(({ from, at }) => { const w = window.scWalk; w.moveTo(from.x, from.z); w.lookAt(at.x, at.y, at.z); }, { from: shot.from, at: shot.at });
    // one frame per time in `frames` (ms after the shot), else one frame after `wait`
    const times = shot.frames || [shot.wait || 1500];
    const files = [];
    let last = 0;
    for (const t of times) {
      await page.waitForTimeout(t - last); last = t;
      const f = path.join(outDir, `${shot.name}-${t}ms.png`);
      await page.screenshot({ path: f });
      files.push(f);
    }
    const events = await page.evaluate(() => window.__events);
    const file = files[files.length - 1];
    const line = { name: shot.name, weapon, expectedWeapon: shot.weapon, events, screenshots: files };
    report.push(line);
    console.log(JSON.stringify({ name: shot.name, weapon, kills: events.filter((e) => e.type === 'sc:kill').map((e) => e.detail.cause) }));
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('report:', path.join(outDir, 'report.json'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
