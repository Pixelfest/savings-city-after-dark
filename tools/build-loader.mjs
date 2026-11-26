#!/usr/bin/env node
// Builds the release folder dist/: the loader (with the release address filled in) and every userscript.
// The address is given at build time and never stored in the repo.
//
//   node tools/build-loader.mjs --base https://<folder where the files will be hosted>
//   (or set SC_RELEASE_BASE instead of --base)
//
// Then upload the contents of dist/ to that folder. Tampermonkey installs dist/savings-city-after-dark.user.js.

import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const LOADER = 'savings-city-after-dark.user.js';

// Load order: the core and buildings come first. Every other script must be listed here (the build checks).
const LOAD_ORDER = [
  'savings-city-core.user.js',
  'savings-city-buildings.user.js',
  'savings-city-bodycount.user.js',
  'savings-city-car-tyres.user.js',
  'savings-city-auto-layout.user.js',
  'savings-city-graphics.user.js',
  'savings-city-walk-mode.user.js',
  'savings-city-residents.user.js',
  'savings-city-rocket-launcher.user.js',
  'savings-city-flamethrower.user.js',
  'savings-city-cops.user.js',
  'savings-city-heli-crane.user.js',
  'savings-city-billboard.user.js',
  'savings-city-drive.user.js',
  'savings-city-nuke.user.js',
  'savings-city-monster.user.js',
];

const argIndex = process.argv.indexOf('--base');
const rawBase = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.SC_RELEASE_BASE;
const base = (rawBase || '').replace(/\/+$/, '');
if (!/^https:\/\/\S+$/.test(base)) {
  console.error('Usage: node tools/build-loader.mjs --base https://<folder where the files will be hosted>');
  process.exit(1);
}

const scripts = readdirSync(root).filter((f) => f.endsWith('.user.js') && f !== LOADER).sort();
const missing = scripts.filter((f) => !LOAD_ORDER.includes(f));
const unknown = LOAD_ORDER.filter((f) => !scripts.includes(f));
if (missing.length || unknown.length) {
  console.error('LOAD_ORDER in tools/build-loader.mjs does not match the scripts in the repo.');
  if (missing.length) console.error('  not listed:', missing.join(', '));
  if (unknown.length) console.error('  listed but missing:', unknown.join(', '));
  process.exit(1);
}

const template = readFileSync(join(root, 'tools', 'loader-template.user.js'), 'utf8');
const version = template.match(/@version\s+(\S+)/)?.[1];
if (!version) throw new Error('no @version in loader template');

const requires = LOAD_ORDER.map((f) => `// @require      ${base}/${f}?v=${version}`).join('\n');
const loader = template
  .replaceAll('{{BASE}}', base)
  .replaceAll('{{VERSION}}', version)
  .replace('{{REQUIRES}}', requires);
if (loader.includes('{{')) throw new Error('unfilled placeholder in loader');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
writeFileSync(join(dist, LOADER), loader);
for (const f of scripts) copyFileSync(join(root, f), join(dist, f));

console.log(`Built loader ${version} and ${scripts.length} scripts into dist/ for ${base}`);
console.log('Upload the contents of dist/ to that folder.');
