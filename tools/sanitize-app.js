#!/usr/bin/env node
// Brings a new copy of the original Savings City app into `app/`, without anything that points to
// where it came from. Use it every time you get newer HTML/JS/CSS from the real app.
//
//   node tools/sanitize-app.js <file-or-folder>...
//
// Accepts a browser "Save page as" result (`Savings City.html` + `Savings City_files/`), files
// downloaded from DevTools → Network (index-*.js, CityCanvas-*.js, index-*.css, logo.webp, the
// Google Fonts `css2`), or a mix. Folders are read recursively.
//
// - HTML → app/index.html: drops the browser's saved-from-URL comment, the rendered page (everything
//   inside <body>, which holds real project names and totals) and styles injected by userscripts;
//   absolute URLs to non-public hosts become root-relative (/logo/…, /favicon.ico); `./X_files/`
//   becomes `/assets/`. References to a bundle that isn't there are pointed at the bundle with the
//   same name prefix that is.
// - JS/CSS/images/fonts → app/assets/. A hashed bundle (`name-HASH8.js|css`) replaces older
//   bundles with the same name prefix, so app/assets always holds exactly one app build.
// - Then runs tools/check-privacy.js on the result. Bundles are never edited: if one contains a
//   private URL, the check fails and you have to decide what to do (tell the user).
'use strict';
const fs = require('fs');
const path = require('path');
const { check, privateTerms, allowedHost } = require('./check-privacy');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const ASSETS = path.join(APP, 'assets');
const ASSET_EXT = /\.(js|mjs|css|webp|png|jpe?g|svg|gif|ico|woff2?|ttf)$/i;
const HASHED = /^(.+)-([A-Za-z0-9_-]{8})\.(js|css)$/;

function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) collect(path.join(p, e), out);
  else out.push(p);
  return out;
}

function isCss(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 300);
  return /@font-face|^\s*\/\*/.test(head);
}

function sanitizeHtml(html, assetNames) {
  const notes = [];
  html = html.replace(/<!--\s*saved\s+from\s+url=[^>]*-->\s*/gi, '');
  // Rendered page content (real data) and userscript styles go; the app renders into #root itself.
  html = html.replace(/<body([^>]*)>[\s\S]*<\/body>/i, (_, attrs) =>
    `<body${attrs.replace(/\s+style="[^"]*"/i, '')}>\n    <div id="root"></div>\n  </body>`);
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>\s*/gi, (s) => (/[#.]sc-/.test(s) ? '' : s));
  html = html.replace(/(["'(])\.?\/?[^"'()]*?_files\//g, '$1/assets/');
  html = html.replace(/\b(https?:)?\/\/([a-z0-9.-]+)(:\d+)?(\/[^"'\s)]*)?/gi, (m, scheme, host, port, rest) => {
    if (allowedHost(host)) return m;
    notes.push(`removed host from ${m.slice(0, 12)}… → ${rest || '/'}`);
    return rest || '/';
  });
  // Point bundle references at the build that is actually in app/assets.
  html = html.replace(/\/assets\/([^"'?#\s]+)/g, (m, name) => {
    if (assetNames.includes(name)) return m;
    const h = name.match(HASHED);
    const alt = h && assetNames.find((a) => { const x = a.match(HASHED); return x && x[1] === h[1] && x[3] === h[3]; });
    if (alt) { notes.push(`${name} → ${alt} (bundle in app/assets)`); return `/assets/${alt}`; }
    notes.push(`warning: /assets/${name} is referenced but not in app/assets`);
    return m;
  });
  html = html.replace(/\n\s*\n(\s*\n)+/g, '\n\n');
  return { html, notes };
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error('usage: node tools/sanitize-app.js <file-or-folder>...');
    process.exit(2);
  }
  const all = inputs.flatMap((p) => collect(path.resolve(p), []));
  const htmls = all.filter((f) => /\.html?$/i.test(f));
  if (htmls.length > 1) { console.error('More than one HTML file given:\n  ' + htmls.join('\n  ')); process.exit(2); }
  fs.mkdirSync(ASSETS, { recursive: true });

  const written = [];
  for (const f of all) {
    const base = path.basename(f);
    if (/\.html?$/i.test(f)) continue;
    if (!ASSET_EXT.test(base) && !isCss(f)) { console.log(`skipped ${base} (not an app asset)`); continue; }
    const h = base.match(HASHED);
    if (h) {
      for (const old of fs.readdirSync(ASSETS)) {
        const o = old.match(HASHED);
        if (o && o[1] === h[1] && o[3] === h[3] && old !== base) {
          fs.unlinkSync(path.join(ASSETS, old));
          console.log(`removed old app/assets/${old}`);
        }
      }
    }
    fs.copyFileSync(f, path.join(ASSETS, base));
    written.push(path.join('app', 'assets', base));
    console.log(`app/assets/${base}`);
  }

  if (htmls.length) {
    const { html, notes } = sanitizeHtml(fs.readFileSync(htmls[0], 'utf8'), fs.readdirSync(ASSETS));
    fs.writeFileSync(path.join(APP, 'index.html'), html);
    written.push(path.join('app', 'index.html'));
    console.log('app/index.html');
    for (const n of notes) console.log('  ' + n);
  }

  const terms = privateTerms();
  const problems = written.flatMap((f) => check(f, terms));
  if (problems.length) {
    console.error('\nPrivacy check FAILED on the new app files – do not commit them like this:');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`\nPrivacy check passed on ${written.length} files${terms.length ? '' : ' (no .private-terms file: generic checks only)'}.`);
  console.log('Next: update CONTEXT.md (bundle names, dates, what changed) and test with local/server.js.');
}

if (require.main === module) main();
module.exports = { sanitizeHtml };
