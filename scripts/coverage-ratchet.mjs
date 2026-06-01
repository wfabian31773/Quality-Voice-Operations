#!/usr/bin/env node
// Coverage ratchet — guards line coverage of specific, deterministically
// tested areas against regression, and lets you raise the floor as coverage
// improves.
//
// Why a custom script rather than vitest's `coverage.thresholds`?
//   - This repo runs with `coverage.all = false` (see vitest.config.ts): only
//     files imported by an executing test are measured. A global threshold
//     therefore drifts with which tests ran/passed.
//   - ~56 tests are DB/secret-dependent and fail outside CI, so the global
//     headline is a *floor* that varies by environment.
// This ratchet sidesteps both by scoping to areas covered by hand-written,
// dependency-mocked tests (no DB needed). Their numbers are stable across
// environments, so they make a reliable regression gate.
//
// Usage:
//   node scripts/coverage-ratchet.mjs            # check (exit 1 on regression)
//   node scripts/coverage-ratchet.mjs --update   # raise floors to current
//   --summary=<path>   coverage-summary.json  (default ./coverage/coverage-summary.json)
//   --baseline=<path>  ratchet baseline json   (default ./coverage-ratchet.json)
//
// The summary must be generated first, e.g. `npm run test:coverage`
// (vitest is configured with reportOnFailure:true, so the summary is written
// even when some tests fail).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const cwd = process.cwd();
const baselinePath = resolve(cwd, getArg('baseline', 'coverage-ratchet.json'));
const summaryPath = resolve(cwd, getArg('summary', 'coverage/coverage-summary.json'));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function fail(msg) {
  console.error(`${RED}coverage-ratchet: ${msg}${RESET}`);
  process.exit(2);
}

if (!existsSync(baselinePath)) fail(`baseline not found at ${baselinePath}`);
if (!existsSync(summaryPath)) {
  fail(
    `coverage summary not found at ${summaryPath}\n` +
      `  Run a coverage pass first, e.g.:  npm run test:coverage`,
  );
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const tolerance = typeof baseline.tolerancePct === 'number' ? baseline.tolerancePct : 0.5;

// Normalise the summary into [relPath, lines{covered,total}] entries.
const files = [];
for (const [abs, data] of Object.entries(summary)) {
  if (abs === 'total' || !data?.lines) continue;
  const rel = relative(cwd, abs).split(sep).join('/');
  if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
  files.push([rel, data.lines]);
}

function aggregate(areaKey) {
  const isFile = areaKey.endsWith('.ts') || areaKey.endsWith('.tsx');
  let covered = 0;
  let total = 0;
  let n = 0;
  for (const [rel, lines] of files) {
    const match = isFile ? rel === areaKey : rel.startsWith(areaKey);
    if (!match) continue;
    covered += lines.covered;
    total += lines.total;
    n += 1;
  }
  return { pct: total > 0 ? (100 * covered) / total : null, files: n };
}

const rows = [];
const regressions = [];
const raised = [];
const notMeasured = [];

for (const [area, spec] of Object.entries(baseline.areas)) {
  const floor = spec.lines;
  const { pct, files: n } = aggregate(area);

  if (pct === null) {
    notMeasured.push(area);
    rows.push({ area, floor, current: null, n: 0, status: 'skip' });
    continue;
  }

  const current = Math.round(pct * 10) / 10;
  if (current < floor - tolerance) {
    regressions.push({ area, floor, current });
    rows.push({ area, floor, current, n, status: 'fail' });
  } else {
    rows.push({ area, floor, current, n, status: 'ok' });
  }

  if (UPDATE) {
    const newFloor = Math.floor(pct); // raise only to a whole-percent floor
    if (newFloor > floor) {
      raised.push({ area, from: floor, to: newFloor });
      spec.lines = newFloor;
    }
  }
}

// ---- Report ----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`\n${BOLD}Coverage ratchet${RESET} ${DIM}(line %, tolerance ${tolerance}pt)${RESET}`);
console.log(DIM + '─'.repeat(72) + RESET);
console.log(`${pad('area', 46)} ${lpad('floor', 6)} ${lpad('now', 7)}  status`);
for (const r of rows) {
  const color = r.status === 'fail' ? RED : r.status === 'skip' ? YELLOW : GREEN;
  const now = r.current === null ? `${DIM}n/a${RESET}` : `${lpad(r.current.toFixed(1), 7)}`;
  const tag =
    r.status === 'fail' ? `${RED}REGRESSED${RESET}` :
    r.status === 'skip' ? `${YELLOW}not measured${RESET}` :
    `${GREEN}ok${RESET}`;
  console.log(`${color}${pad(r.area, 46)}${RESET} ${lpad(r.floor, 6)} ${now}  ${tag}`);
}
console.log(DIM + '─'.repeat(72) + RESET);

if (notMeasured.length) {
  console.log(
    `${YELLOW}warning:${RESET} ${notMeasured.length} area(s) not present in the coverage summary ` +
      `— their tests did not run this pass, so they were skipped (not failed). ` +
      `Run the full suite (npm run test:coverage) for a complete check.`,
  );
}

if (UPDATE) {
  if (raised.length) {
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\n${GREEN}Raised ${raised.length} floor(s):${RESET}`);
    for (const r of raised) console.log(`  ${r.area}: ${r.from} → ${r.to}`);
    console.log(`${DIM}Updated ${relative(cwd, baselinePath)} — commit it to lock in the gains.${RESET}`);
  } else {
    console.log(`\n${DIM}No floors raised (no measured area exceeded its current floor).${RESET}`);
  }
  process.exit(0);
}

if (regressions.length) {
  console.log(`\n${RED}${BOLD}✗ ${regressions.length} area(s) regressed below the ratchet floor:${RESET}`);
  for (const r of regressions) {
    console.log(`  ${RED}${r.area}${RESET}: floor ${r.floor}% but measured ${r.current}%`);
  }
  console.log(
    `\n${DIM}Add tests to restore coverage, or — if the drop is intentional and ` +
      `justified — lower the floor in ${relative(cwd, baselinePath)} in the same commit.${RESET}`,
  );
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}✓ all ${rows.filter((r) => r.status === 'ok').length} measured areas meet their coverage floor.${RESET}`);
process.exit(0);
