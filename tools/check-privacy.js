#!/usr/bin/env node
// Privacy check: this repository is public. Nothing in it may point to the real Savings City
// host (or any other private address) or contain personal data. See AGENTS.md → "Privacy rules".
// It guards pushes and pull requests: GitHub Actions (.github/workflows/privacy.yml) and the
// pre-push hook in .githooks/ run it.
//
//   node tools/check-privacy.js            check every tracked + new (not ignored) file
//   node tools/check-privacy.js FILE...    check only these files
//
// Checks:
//   1. URLs (with a scheme) and bare host names whose host is not on ALLOWED_HOSTS below.
//   2. E-mail addresses (only example.com / example.org are allowed).
//   3. City JSON files (anything with a "projects" array): authors must be "Bouwer X",
//      links null or https://example.com/…, descriptions the anonymised placeholder.
//   4. Terms listed in `.private-terms` (git-ignored, one per line, case-insensitive): put the
//      real host, company and people's names there on your own machine. CI can't see this file,
//      so checks 1–3 are what protect the repo there.
// Exit code 1 when anything is found.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Public hosts that may appear (libraries, standards, placeholders, this public repo).
// Add a host here only if it is public and has nothing to do with the real app's owner.
const ALLOWED_HOSTS = [
  'example.com', 'example.org', 'example.net', 'your-savings-city-host.example', 'voorbeeld.nl',
  'localhost', '127.0.0.1',
  'www.w3.org', 'w3.org', 'react.dev', 'reactjs.org', 'threejs.org', 'jcgt.org',
  'github.com', 'raw.githubusercontent.com', 'www.tampermonkey.net', 'tampermonkey.net',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'nodejs.org', 'playwright.dev',
  'unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'www.npmjs.com', 'npmjs.com',
  'code.claude.com', 'claude.ai',
];
// Top-level domains checked for bare host names (no scheme). Minified bundles are full of
// `a.b` property chains, so only these TLDs count as a host there.
const BARE_TLDS = ['nl', 'com', 'dev', 'io', 'net', 'org', 'cloud', 'eu', 'be', 'de', 'app', 'co', 'uk', 'info', 'biz', 'local', 'internal', 'corp', 'lan'];
const BINARY = /\.(webp|png|jpe?g|gif|ico|woff2?|ttf|otf|zip)$/i;
const SKIP = [/^package-lock\.json$/, /^tools\/check-privacy\.js$/];

const allowedHost = (h) => {
  h = h.toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
};

function privateTerms() {
  const f = path.join(ROOT, '.private-terms');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#')).map((s) => s.toLowerCase());
}

function files(args) {
  if (args.length) return args.map((f) => path.relative(ROOT, path.resolve(f)));
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        if (['.git', 'node_modules'].includes(e.name)) continue;
        const r = path.join(d, e.name);
        e.isDirectory() ? walk(r) : out.push(r);
      }
    };
    walk('');
    return out;
  }
}

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }
function snippet(text, index, len) {
  return text.slice(Math.max(0, index - 30), index + len + 30).replace(/\s+/g, ' ');
}

function checkCity(json, report) {
  let d;
  try { d = JSON.parse(json); } catch { return; }
  if (!d || !Array.isArray(d.projects)) return;
  d.projects.forEach((p, i) => {
    const where = `project ${i} (${p.name})`;
    for (const a of p.authors || []) if (!/^Bouwer [A-Z]{1,2}$/.test(a)) report(`${where}: author "${a}" is not anonymised (use "Bouwer X")`);
    if (p.link != null && !/^https:\/\/example\.com\//.test(p.link)) report(`${where}: link must be null or https://example.com/…`);
    if (p.description != null && p.description !== 'Voorbeeldproject (geanonimiseerd).') report(`${where}: description must be "Voorbeeldproject (geanonimiseerd)."`);
  });
}

function check(rel, terms) {
  const problems = [];
  const report = (msg) => problems.push(`${rel}: ${msg}`);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return problems;
  if (SKIP.some((r) => r.test(rel.split(path.sep).join('/')))) return problems;
  const buf = fs.readFileSync(abs);
  const binary = BINARY.test(rel);
  const text = buf.toString(binary ? 'latin1' : 'utf8');
  const lower = text.toLowerCase();

  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) report(`private term from .private-terms found (line ${lineOf(text, i)})`);
  }
  if (binary) return problems;

  const seen = new Set();
  for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/([a-z0-9.-]+)(?::\d+)?/gi)) {
    const host = m[1];
    if (!host.includes('.') && host.toLowerCase() !== 'localhost') continue; // template fragments in bundles
    if (!allowedHost(host) && !seen.has(host)) { seen.add(host); report(`URL to non-allowed host "${host}" (line ${lineOf(text, m.index)}): …${snippet(text, m.index, m[0].length)}…`); }
  }
  const bare = new RegExp(`\\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_TLDS.join('|')}))\\b(?![.\\w(])`, 'gi');
  for (const m of text.matchAll(bare)) {
    const host = m[1];
    const before = text[m.index - 1] || '';
    if (/[@\w$]/.test(before)) continue; // e-mail (checked below) or part of an identifier
    if (/^(this|window|document|e|t|n|r|i|o|a|s|self|module|exports)\./i.test(host)) continue; // JS property chains
    if (!allowedHost(host) && !seen.has(host)) { seen.add(host); report(`host name "${host}" is not allowed (line ${lineOf(text, m.index)})`); }
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
    if (!/@example\.(com|org)$/i.test(m[0])) report(`e-mail address "${m[0]}" (line ${lineOf(text, m.index)})`);
  }
  if (/\.json$/i.test(rel)) checkCity(text, report);
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const terms = privateTerms();
  const list = files(args);
  const problems = list.flatMap((f) => check(f, terms));
  if (problems.length) {
    console.error(`Privacy check FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`Privacy check passed: ${list.length} files${terms.length ? `, ${terms.length} private terms` : ' (no .private-terms file: generic checks only)'}.`);
}

if (require.main === module) main();
module.exports = { check, privateTerms, allowedHost, ALLOWED_HOSTS };
