#!/usr/bin/env node
// Copies the newest html/js/css of the original Savings City app into app/ (a mirror: copies that no longer
// exist in the source are removed). Source maps are never copied, and sourceMappingURL comments are removed,
// so nothing in app/ can point back to where the app came from. Then the privacy check runs on the repo.
//
//   npm run sync -- <path to the original app folder>
//
// After a sync: commit app/ only when `npm run check` passes. Stop and fix anything it reports; don't add exceptions.

import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, relative, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const KEEP = new Set(['.html', '.htm', '.js', '.mjs', '.css']);
const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

const source = process.argv[2] && resolve(process.argv[2]);
if (!source || !statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Usage: npm run sync -- <path to the original app folder>');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && KEEP.has(extname(entry.name))) {
      out.push(relative(source, join(dir, entry.name)));
    }
  }
  return out;
}

const wanted = walk(source).sort();
const wantedSet = new Set(wanted);

// Remove app/ copies that no longer exist in the source (only the kinds we sync).
const removed = [];
if (statSync(appDir, { throwIfNoEntry: false })) {
  const existing = walk(appDir).map((f) => relative(appDir, join(appDir, f)));
  for (const f of existing) {
    if (!wantedSet.has(f)) { rmSync(join(appDir, f)); removed.push(f); }
  }
}

let stripped = 0;
for (const f of wanted) {
  const to = join(appDir, f);
  mkdirSync(dirname(to), { recursive: true });
  if (TEXT.has(extname(f))) {
    const text = readFileSync(join(source, f), 'utf8');
    const clean = text.replace(/^[ \t]*(\/\/|\/\*)[#@]\s*sourceMappingURL=.*$/gm, () => { stripped++; return ''; });
    writeFileSync(to, clean);
  } else {
    copyFileSync(join(source, f), to);
  }
}

console.log(`synced ${wanted.length} file(s) into app/` + (removed.length ? `, removed ${removed.length} stale file(s)` : '') +
  (stripped ? `, stripped ${stripped} source-map comment(s)` : ''));

const check = spawnSync(process.execPath, [join(root, 'tools', 'check-privacy.mjs')], { stdio: 'inherit' });
if (check.status !== 0) {
  console.error('\nThe copied app contains content that must not be published. Fix it in app/ (see AGENTS.md).');
  process.exit(check.status ?? 1);
}
