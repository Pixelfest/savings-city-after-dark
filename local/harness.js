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

  const report = [];
  for (const shot of layout.shots) {
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
    await page.waitForTimeout(shot.wait || 1500);
    const events = await page.evaluate(() => window.__events);
    const file = path.join(outDir, shot.name + '.png');
    await page.screenshot({ path: file });
    const line = { name: shot.name, weapon, expectedWeapon: shot.weapon, events, screenshot: file };
    report.push(line);
    console.log(JSON.stringify({ name: shot.name, weapon, kills: events.filter((e) => e.type === 'sc:kill').map((e) => e.detail.cause) }));
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('report:', path.join(outDir, 'report.json'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
