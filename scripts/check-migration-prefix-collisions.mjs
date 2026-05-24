#!/usr/bin/env node
/**
 * Migration prefix collision check (Iron-out 7).
 *
 * History: this repo accumulated a lot of `NNN_*.sql` filename collisions
 * because feature branches landed in parallel — e.g. six different
 * `046_*.sql` files exist today. Postgres doesn't care, but our migration
 * runner sorts lexicographically by filename, so two `046_*.sql` files
 * land in an order that depends purely on the rest of the filename. This
 * means migration order on a fresh DB is not the same as the order
 * migrations were merged — which already burned us on issue #4 (PR #7,
 * migration 063 backfill on fresh DB).
 *
 * The cleanest fix would be to renumber every collision, but that rewrites
 * history on a production DB that has already executed them. So instead:
 * existing collisions are grandfathered, and this script makes sure no
 * NEW collision lands without an explicit decision.
 *
 * Algorithm:
 *   1. Resolve the PR's merge base with the default branch.
 *      - In GitHub Actions PR runs that's $GITHUB_BASE_REF (`origin/main`).
 *      - On local invocation we fall back to `origin/main`, then `main`.
 *   2. List migrations/*.sql files ADDED (filter=A) in this branch since
 *      the merge base via `git diff --diff-filter=A --name-only ...`.
 *   3. Extract the numeric prefix (first underscore-delimited token).
 *   4. For each new prefix, count how many other migrations on the base
 *      branch already use it. Anything > 0 is a NEW collision the PR is
 *      introducing.
 *   5. Exit non-zero with a clear diff so the contributor knows what to
 *      renumber.
 *
 * Renumbering instructions are printed inline with each failure so a
 * reviewer doesn't have to dig into this comment to know what to do.
 */
import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const PREFIX_RE = /^(\d{3,})_/;

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function resolveBaseRef() {
  // GitHub Actions sets GITHUB_BASE_REF on pull_request events.
  const ghBase = process.env.GITHUB_BASE_REF;
  if (ghBase) {
    // The base ref is fetched as origin/<ref> by checkout@v4 with fetch-depth: 0
    return `origin/${ghBase}`;
  }
  // Local fallback: try origin/main, then main.
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      sh(`git rev-parse --verify ${candidate}`);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('Could not resolve a base ref. Set GITHUB_BASE_REF or ensure origin/main exists.');
}

function extractPrefix(filename) {
  const base = path.basename(filename);
  const m = base.match(PREFIX_RE);
  return m ? m[1] : null;
}

function listMigrationsAtRef(ref) {
  // List migrations/*.sql at the given ref. Returns Set of basenames.
  try {
    const out = sh(`git ls-tree -r --name-only ${ref} -- migrations/`);
    return new Set(
      out
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.endsWith('.sql'))
        .map((p) => path.basename(p)),
    );
  } catch (err) {
    throw new Error(`Failed to list migrations at ${ref}: ${err.message}`);
  }
}

function listAddedMigrations(baseRef) {
  try {
    const out = sh(`git diff --diff-filter=A --name-only ${baseRef}...HEAD -- 'migrations/*.sql'`);
    return out
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => path.basename(p));
  } catch (err) {
    throw new Error(`Failed to diff against ${baseRef}: ${err.message}`);
  }
}

function suggestNextPrefix(usedPrefixes) {
  // usedPrefixes: Set<string>
  let n = 1;
  for (const p of usedPrefixes) {
    const v = parseInt(p, 10);
    if (Number.isFinite(v) && v > n) n = v;
  }
  return String(n + 1).padStart(3, '0');
}

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`migrations/ directory not found at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  const added = listAddedMigrations(baseRef);

  if (added.length === 0) {
    console.log('[migration-prefix-check] No new migrations in this branch. OK.');
    return;
  }

  const baseFiles = listMigrationsAtRef(baseRef);
  const basePrefixes = new Map(); // prefix -> [filename, ...]
  for (const f of baseFiles) {
    const p = extractPrefix(f);
    if (!p) continue;
    if (!basePrefixes.has(p)) basePrefixes.set(p, []);
    basePrefixes.get(p).push(f);
  }

  const failures = [];
  // Also catch the case where two new migrations in the same PR collide
  // with each other on a fresh prefix.
  const seenInPr = new Map();
  for (const f of added) {
    const p = extractPrefix(f);
    if (!p) {
      failures.push({
        file: f,
        kind: 'no_prefix',
        message: `Migration filename does not start with a 3+ digit prefix: ${f}`,
      });
      continue;
    }
    const existing = basePrefixes.get(p) ?? [];
    const newInThisPr = seenInPr.get(p) ?? [];
    const conflicts = [...existing, ...newInThisPr];
    if (conflicts.length > 0) {
      failures.push({
        file: f,
        kind: 'collision',
        prefix: p,
        conflictsWith: conflicts,
      });
    }
    if (!seenInPr.has(p)) seenInPr.set(p, []);
    seenInPr.get(p).push(f);
  }

  if (failures.length === 0) {
    console.log(
      `[migration-prefix-check] ${added.length} new migration(s) on this branch — no prefix collisions. OK.`,
    );
    for (const f of added) console.log(`  + ${f}`);
    return;
  }

  // Build the suggested next prefix from the union of base + PR migrations.
  const allPrefixes = new Set(basePrefixes.keys());
  for (const p of seenInPr.keys()) allPrefixes.add(p);
  const suggested = suggestNextPrefix(allPrefixes);

  console.error('');
  console.error('[migration-prefix-check] FAILED — new migration prefix collisions:');
  console.error('');
  for (const f of failures) {
    if (f.kind === 'no_prefix') {
      console.error(`  ✗ ${f.message}`);
    } else {
      console.error(`  ✗ ${f.file}`);
      console.error(`      prefix ${f.prefix} already used by:`);
      for (const c of f.conflictsWith) console.error(`        - ${c}`);
    }
  }
  console.error('');
  console.error('Why this matters: the migration runner sorts lexicographically by');
  console.error('filename. Two migrations sharing a prefix run in an order that');
  console.error('depends on the rest of the name, not on merge order. That bit us in');
  console.error('issue #4 (migration 063 backfill broke fresh DBs).');
  console.error('');
  console.error(`Suggested next available prefix: ${suggested}`);
  console.error('');
  console.error('Rename your new migration(s) to a fresh prefix and update any');
  console.error('reference to the old filename in tests/docs (`git grep <oldname>`).');
  console.error('');
  console.error('Existing collisions in main are grandfathered intentionally — they');
  console.error('cannot be renumbered without rewriting production DB history.');
  process.exit(1);
}

main();
