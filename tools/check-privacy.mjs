#!/usr/bin/env node
// Fails when a file in the repo (tracked, or new and not ignored) contains something that must not be
// published: a web address, an email address, a local file path, or a term from the local denylist.
// The rules are in AGENTS.md ("Privacy rules"). Run it with: npm run check
//
// Local denylist (optional, never committed): a file named .privacy-denylist in the repo root with one
// term per line (your name, your hosting account, the original app's name ...). Matching ignores case.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tools/check-privacy.mjs'; // this file names the patterns it looks for

// Public references that are not about this project.
const ALLOWED_URL_PREFIXES = [
  'http://www.w3.org/', // SVG and XML namespace strings
  'https://www.w3.org/',
  'https://threejs.org/', // three.js
  'https://github.com/mrdoob/three.js',
  'https://www.tampermonkey.net/', // Tampermonkey documentation
];
// Placeholders and loopback addresses: the app's address is always a placeholder in the repo.
const ALLOWED_HOST = /^(localhost|127\.0\.0\.1)$|\.example$/;

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}\\]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PATH_RE = /\/home\/[A-Za-z0-9_.-]+|\/Users\/[A-Za-z0-9_.-]+|\/root\/|\/misc-projects\b|[A-Za-z]:\\Users\\/g;
const IP_RE = /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;

const denylist = existsSync(join(root, '.privacy-denylist'))
  ? readFileSync(join(root, '.privacy-denylist'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];

function files() {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root });
  return out.toString('utf8').split('\0').filter((f) => f && f !== SELF);
}

function urlProblem(url) {
  if (ALLOWED_URL_PREFIXES.some((p) => url.toLowerCase().startsWith(p.toLowerCase()))) return null;
  const host = url.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0];
  if (ALLOWED_HOST.test(host)) return null;
  return 'web address';
}

const problems = [];
for (const f of files()) {
  const buf = readFileSync(join(root, f));
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    const hit = (kind, m) => problems.push(`${f}:${i + 1}: ${kind}: ${m}`);
    for (const m of line.matchAll(URL_RE)) { const kind = urlProblem(m[0]); if (kind) hit(kind, m[0]); }
    for (const m of line.matchAll(EMAIL_RE)) hit('email address', m[0]);
    for (const m of line.matchAll(PATH_RE)) hit('local file path', m[0]);
    for (const m of line.matchAll(IP_RE)) hit('IP address', m[0]);
    for (const term of denylist) {
      if (line.toLowerCase().includes(term.toLowerCase())) hit('denylisted term', term);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nprivacy check failed: ${problems.length} problem(s). See "Privacy rules" in AGENTS.md.`);
  process.exit(1);
}
console.log('privacy check passed');
