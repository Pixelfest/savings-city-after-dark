#!/usr/bin/env node
// Version check: every change to a script must come with a version bump. See AGENTS.md → "Releases".
//
//   node tools/check-loader-version.js [BASE]    BASE = the commit to compare with (default origin/main)
//
// When a savings-city-*.user.js file changed since BASE (the loader included), this requires:
//   1. every changed script's own @version to be higher than in BASE (new scripts: just present);
//   2. the loader (savings-city-after-dark.user.js) @version to be higher than in BASE;
//   3. every ?v= on the loader's @require lines, and its console line, to equal the loader's
//      @version (that is what makes Tampermonkey fetch the scripts again).
// Exit code 1 when anything is missing. GitHub Actions runs it on every pull request and on
// pushes to main (.github/workflows/loader-version.yml).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOADER = 'savings-city-after-dark.user.js';
const SCRIPT = /^savings-city-[^/]+\.user\.js$/;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOrNull = (...args) => { try { return git(...args); } catch { return null; } };

const version = (text) => { const m = text && text.match(/^\/\/ @version\s+(\S+)/m); return m ? m[1] : null; };
const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10));
const higher = (a, b) => { // a > b, dotted numbers (1.10 > 1.9)
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
};

let base = process.argv[2] || 'origin/main';
if (/^0+$/.test(base)) base = 'HEAD~1';                          // a push that creates the branch
if (!gitOrNull('rev-parse', '--verify', '-q', `${base}^{commit}`)) {
  console.error(`check-loader-version: cannot find base "${base}" (fetch it, e.g. git fetch origin main)`);
  process.exit(1);
}

const changed = (gitOrNull('diff', '--name-only', `${base}...HEAD`) || '').split('\n').filter((f) => SCRIPT.test(f));
if (!changed.length) {
  console.log('check-loader-version: no script changed since ' + base + ' – nothing to bump.');
  process.exit(0);
}

const problems = [];
const headText = (f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : null);
const baseText = (f) => gitOrNull('show', `${base}:${f}`);

// 1. each changed script (not the loader) has a higher @version
for (const f of changed.filter((f) => f !== LOADER)) {
  const now = version(headText(f));
  if (!now) { if (headText(f) !== null) problems.push(`${f}: no // @version line`); continue; }  // deleted: nothing to bump
  const before = version(baseText(f));
  if (before && !higher(now, before)) problems.push(`${f}: @version ${now} must be higher than ${before} (bump it)`);
}

// 2 + 3. the loader (a script changed, so it must be bumped too)
const loaderNow = headText(LOADER), loaderBefore = baseText(LOADER);
{
  const v = version(loaderNow);
  if (!v) problems.push(`${LOADER}: no // @version line`);
  else {
    const before = version(loaderBefore);
    if (before && !higher(v, before)) problems.push(`${LOADER}: @version ${v} must be higher than ${before} (bump the loader)`);
    const requires = (loaderNow.match(/^\/\/ @require\s+.*$/gm) || []);
    const stale = requires.filter((line) => { const m = line.match(/\?v=(\S+)/); return !m || m[1] !== v; });
    if (!requires.length) problems.push(`${LOADER}: no @require lines`);
    for (const line of stale) problems.push(`${LOADER}: "${line.trim()}" must end with ?v=${v}`);
    const log = loaderNow.match(/console\.info\('\[Savings City After Dark\] loader ([^']+)'\)/);
    if (!log) problems.push(`${LOADER}: the console line that prints "loader x.y" is missing`);
    else if (log[1] !== v) problems.push(`${LOADER}: the console line says loader ${log[1]}, @version is ${v}`);
  }
}

if (problems.length) {
  console.error('check-loader-version: a change to the scripts needs a version bump (AGENTS.md → "Releases"):');
  for (const p of problems) console.error('  - ' + p);
  console.error(`changed since ${base}: ${changed.join(', ')}`);
  process.exit(1);
}
console.log(`check-loader-version: OK – changed ${changed.join(', ')}; loader ${version(loaderNow)}.`);
