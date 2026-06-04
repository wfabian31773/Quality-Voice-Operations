#!/usr/bin/env node
/**
 * Coverage gap reporter.
 *
 * `vitest run --coverage` (with `all: false`) only reports files that an
 * executing test imported. This script supplies the other half of the
 * picture: every backend source file that the suite never touched at all,
 * i.e. files with ZERO coverage.
 *
 * It reads coverage/coverage-summary.json (produced by the `json-summary`
 * reporter) and diffs the covered file set against the same source globs the
 * coverage config instruments. Run after `npm run test:coverage`:
 *
 *   node scripts/coverage-gaps.mjs
 *
 * Output: a per-top-level-directory tally of untested files plus the full
 * list, grouped, sorted by module. Exits 0 always (reporting tool, not a gate).
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// Keep these in sync with the `coverage.include` / `coverage.exclude` globs in
// vitest.config.ts.
const INCLUDE = [
  'platform/**/*.{ts,tsx}',
  'server/**/*.{ts,tsx}',
  'shared/**/*.{ts,tsx}',
  'scripts/**/*.{ts,tsx}',
];
const EXCLUDE_RE = [
  /\.(test|spec)\.(ts|tsx)$/,
  /\.d\.ts$/,
  /(^|\/)types\.ts$/,
  /(^|\/)__mocks__\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)node_modules\//,
];

function isExcluded(rel) {
  return EXCLUDE_RE.some((re) => re.test(rel));
}

const allSource = new Set();
for (const pattern of INCLUDE) {
  for (const abs of globSync(path.join(root, pattern), { nodir: true })) {
    const rel = path.relative(root, abs);
    if (!isExcluded(rel)) allSource.add(rel);
  }
}

let summary;
try {
  summary = JSON.parse(
    readFileSync(path.join(root, 'coverage/coverage-summary.json'), 'utf8'),
  );
} catch {
  console.error(
    'coverage/coverage-summary.json not found. Run `npm run test:coverage` first.',
  );
  process.exit(0);
}

// A file counts as "covered" only if at least one line executed. v8 lists
// files pulled in by the `include` glob even at 0% (e.g. a barrel imported but
// never exercised), so absence-from-report is not the only signal — pct===0 is.
const covered = new Set();
const partial = []; // { file, pct } for files with 0 < line% < 50
for (const [abs, data] of Object.entries(summary)) {
  if (abs === 'total') continue;
  const rel = path.relative(root, abs);
  const pct = data.lines?.pct ?? 0;
  if (pct > 0) covered.add(rel);
  if (pct > 0 && pct < 50) partial.push({ file: rel, pct });
}

const untested = [...allSource].filter((f) => !covered.has(f)).sort();

// Tally untested by module (top two path segments for platform/server).
const byModule = new Map();
for (const f of untested) {
  const seg = f.split('/');
  const key = seg.length >= 2 ? `${seg[0]}/${seg[1]}` : seg[0];
  byModule.set(key, (byModule.get(key) ?? 0) + 1);
}

console.log('=== Coverage gaps (backend) ===');
console.log(
  `Source files instrumented by config: ${allSource.size}\n` +
    `Touched by at least one test:        ${[...allSource].filter((f) => covered.has(f)).length}\n` +
    `ZERO coverage (never imported):      ${untested.length}\n`,
);

console.log('--- Untested files by module (worst first) ---');
for (const [mod, n] of [...byModule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${mod}`);
}

if (partial.length) {
  console.log('\n--- Files exercised but <50% line coverage ---');
  for (const { file, pct } of partial.sort((a, b) => a.pct - b.pct)) {
    console.log(`  ${String(pct.toFixed(1)).padStart(5)}%  ${file}`);
  }
}

console.log('\n--- Full untested file list ---');
for (const f of untested) console.log(`  ${f}`);
