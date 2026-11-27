#!/usr/bin/env node
// Screenshot of the local city in headless Chromium (SwiftShader WebGL), for checking script
// changes without a browser. Start local/server.js first.
//
//   node local/shot.js [url] [out.png] [--wait 12000] [--eval "js run in the page before the shot"]
//   e.g. node local/shot.js 'http://localhost:8080/?plugins=nuke' nuke.png --eval "document.querySelector('[title*=Nuke]')?.click()" --wait 20000
//   The test city: node local/shot.js 'http://localhost:8080/test?plugins=core,cops' test.png --wait 3000
//   (waits for window.scTest.ready first, then --wait ms).
//
// Playwright is resolved from the global install (NODE_PATH=$(npm root -g) if require fails).
'use strict';
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const wait = Number(opt('wait', 12000));
const evalJs = opt('eval', null);
const [url = 'http://localhost:8080/', out = 'city.png'] = args;

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  page.on('console', (m) => { if (!/GL Driver|Canvas2D|willReadFrequently/.test(m.text())) console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => { try { localStorage.setItem('citysaver:welcome-seen', '1'); } catch {} });
  await page.goto(url);
  // On the test page (/test) wait until the test scene is set up, so the waits below start there.
  if (new URL(url).pathname.replace(/\/$/, '') === '/test') {
    await page.waitForFunction(() => window.scTest && window.scTest.ready, null, { timeout: 120000 });
  }
  if (evalJs) { await page.waitForTimeout(Math.min(wait, 8000)); console.log('eval →', await page.evaluate(evalJs)); }
  await page.waitForTimeout(wait);
  await page.screenshot({ path: out });
  console.log('saved', out);
  await browser.close();
})();
