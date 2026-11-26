#!/usr/bin/env node
// Turns an `/api/city` dump from the real app into an anonymous city for local/ – keeps what the
// 3D city needs (layout, sizes, colours, roads, build state) and replaces everything that could
// identify the project, a person or the organisation.
//
//   node tools/anonymise-city.js <dump.json> [out.json]      (default out: local/city.json)
//
// - id: a new random UUID (real database ids must not leave the real app)
// - name: a made-up Dutch project name ("Snelle Exportscript")
// - description: "Voorbeeldproject (geanonimiseerd)."
// - authors: "Bouwer A", "Bouwer B", … (the same person keeps the same letter within one run)
// - link: https://example.com/ when there was one, else null
// - time_estimated_no_ai, time_spent_ai, budget_spent: × a random 0.7…1.3 and rounded
//   (building height depends on these, so the city keeps its shape; real totals don't survive)
// - everything else (gx, gy, facing, colour, dates, open_for_placement, roads) is kept.
// Afterwards it runs the privacy check on the output.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { check, privateTerms } = require('./check-privacy');

const ADJ = ['Automatische', 'Centrale', 'Digitale', 'Groene', 'Handige', 'Interne', 'Lichte', 'Moderne', 'Nieuwe', 'Slimme', 'Snelle', 'Veilige'];
const NOUN = ['Agenda', 'Archief', 'Chatbot', 'Dashboard', 'Export', 'Facturatie', 'Import', 'Kalender', 'Koppeling', 'Migratie', 'Monitor', 'Notificaties', 'Planning', 'Rapportage', 'Review', 'Scanner', 'Testsuite', 'Uploader', 'Validatie', 'Zoekfunctie'];
const KIND = ['app', 'assistent', 'check', 'generator', 'module', 'pipeline', 'plugin', 'script', 'service', 'tool'];
const pick = (a) => a[crypto.randomInt(a.length)];
const jitter = (v, digits) => {
  if (typeof v !== 'number') return v;
  const f = 10 ** digits;
  return Math.max(0, Math.round(v * (0.7 + Math.random() * 0.6) * f) / f);
};
const letters = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

function anonymise(city) {
  const people = new Map();
  const names = new Set();
  const projects = (city.projects || []).map((p) => {
    let name;
    do name = `${pick(ADJ)} ${pick(NOUN)}${pick(KIND)}`; while (names.has(name) && names.size < ADJ.length * NOUN.length * KIND.length);
    names.add(name);
    const authors = (p.authors || []).filter((a) => String(a).trim()).map((a) => {
      const key = String(a).trim().toLowerCase();
      if (!people.has(key)) people.set(key, `Bouwer ${letters(people.size)}`);
      return people.get(key);
    });
    return {
      ...p,
      id: crypto.randomUUID(),
      name,
      description: 'Voorbeeldproject (geanonimiseerd).',
      time_estimated_no_ai: jitter(p.time_estimated_no_ai, 0),
      time_spent_ai: jitter(p.time_spent_ai, 0),
      budget_spent: jitter(p.budget_spent, 1),
      link: p.link ? 'https://example.com/' : null,
      authors,
    };
  });
  const out = { projects, roads: city.roads || [], revision: city.revision || 1 };
  if (city.server_time) out.server_time = city.server_time;
  return out;
}

function main() {
  const [inFile, outFile = path.join(__dirname, '..', 'local', 'city.json')] = process.argv.slice(2);
  if (!inFile) { console.error('usage: node tools/anonymise-city.js <dump.json> [out.json]'); process.exit(2); }
  const city = anonymise(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  // One project per line: readable diffs, and small.
  const json = '{"projects": [\n' + city.projects.map((p) => JSON.stringify(p)).join(',\n') + '\n],\n'
    + Object.entries(city).filter(([k]) => k !== 'projects').map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '}\n';
  fs.writeFileSync(outFile, json);
  console.log(`${outFile}: ${city.projects.length} projects, ${city.roads.length} roads`);
  const problems = check(path.relative(path.resolve(__dirname, '..'), path.resolve(outFile)), privateTerms());
  if (problems.length) { for (const p of problems) console.error('  ' + p); process.exit(1); }
  console.log('Privacy check passed.');
}

if (require.main === module) main();
module.exports = { anonymise };
