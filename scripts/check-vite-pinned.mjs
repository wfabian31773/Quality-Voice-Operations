#!/usr/bin/env node
/**
 * Vite major-version pin check.
 *
 * Background: a fresh `npm install --legacy-peer-deps` once silently
 * pulled `vite@8.0.10` (the rolldown-based prerelease) into `client-app`
 * because Vite was only present transitively in the lockfile. That broke
 * the production build with an EISDIR error from the rolldown HTML
 * plugin — see Task #1166.
 *
 * The fix at the time was to add `vite`, `@vitejs/plugin-react`, and
 * `@tailwindcss/vite` as explicit dev dependencies pinned to the working
 * majors. This script is the CI guard that prevents the regression from
 * silently returning the next time someone runs `npm install` and the
 * resolver picks a newer Vite major. It compares the *resolved* version
 * in every lockfile we ship against an allow-list of known-good majors,
 * and additionally asserts that `vite`, `@vitejs/plugin-react`, and
 * `@tailwindcss/vite` remain declared as direct dependencies (so the
 * regression cannot recur by someone deleting them from package.json).
 *
 * Wired into `scripts/post-merge.sh` alongside the other check:* scripts.
 *
 * Allowed majors:
 *   - vite                      6
 *   - @vitejs/plugin-react      4
 *   - @tailwindcss/vite         4
 *
 * Bump these only after a real upgrade has been validated end-to-end
 * (build:app, build:public, dev server, and the marketing-bundle Preact
 * smoke). Bumping the allow-list without re-validating is the exact
 * footgun this script exists to prevent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_MAJORS = {
  vite: [6],
  '@vitejs/plugin-react': [4],
  '@tailwindcss/vite': [4],
};

const REQUIRED_DIRECT_DEPS = Object.keys(ALLOWED_MAJORS);

const PACKAGE_JSONS_REQUIRING_DIRECT_DEPS = [
  'package.json',
  'client-app/package.json',
];

const NPM_LOCKFILES = [
  'package-lock.json',
  'client-app/package-lock.json',
];

const PNPM_LOCKFILES = [
  'pnpm-lock.yaml',
  'client-app/pnpm-lock.yaml',
];

const errors = [];

function majorOf(version) {
  const m = String(version).match(/^(\d+)\./);
  return m ? Number(m[1]) : NaN;
}

function checkDirectDep(pkgJsonRelPath) {
  const abs = path.join(ROOT, pkgJsonRelPath);
  if (!existsSync(abs)) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    errors.push(`${pkgJsonRelPath}: failed to parse (${err.message})`);
    return;
  }
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  for (const name of REQUIRED_DIRECT_DEPS) {
    const range = allDeps[name];
    if (!range) {
      errors.push(
        `${pkgJsonRelPath}: missing required direct dependency "${name}". ` +
          `It must stay declared so the resolver cannot silently jump to a ` +
          `newer major via a transitive bump.`,
      );
      continue;
    }
    // Surface obviously-unsafe ranges like "*" or "latest" / "next".
    if (/^(\*|latest|next|workspace:\*)$/i.test(range.trim())) {
      errors.push(
        `${pkgJsonRelPath}: "${name}" is declared as "${range}", which ` +
          `does not pin a major. Use a caret range like "^6.4.1" instead.`,
      );
    }
  }
}

function checkNpmLockfile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return;
  let lock;
  try {
    lock = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    errors.push(`${relPath}: failed to parse (${err.message})`);
    return;
  }
  const packages = lock.packages || {};
  for (const [name, allowed] of Object.entries(ALLOWED_MAJORS)) {
    const entry = packages[`node_modules/${name}`];
    if (!entry) continue; // not used in this lockfile, fine
    const major = majorOf(entry.version);
    if (!allowed.includes(major)) {
      errors.push(
        `${relPath}: ${name} resolved to ${entry.version} (major ${major}), ` +
          `but only major(s) [${allowed.join(', ')}] are known to build. ` +
          `Either revert the bump or update ALLOWED_MAJORS in ` +
          `scripts/check-vite-pinned.mjs after validating the upgrade.`,
      );
    }
  }
}

function checkPnpmLockfile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return;
  const text = readFileSync(abs, 'utf8');
  for (const [name, allowed] of Object.entries(ALLOWED_MAJORS)) {
    // Match top-level package keys like `vite@6.4.2:` (unscoped) and
    // `'@vitejs/plugin-react@4.7.0(vite@6.4.2)':` (scoped, which pnpm
    // always quotes because of the `@`). We deliberately only look at
    // the snapshot keys (start of line + 2-space indent) so that we
    // don't pick up peer-dependency declarations, which list ranges
    // rather than resolved versions. The optional leading quote
    // handles the scoped/quoted form.
    const escapedName = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const re = new RegExp(`^  '?${escapedName}@(\\d+\\.\\d+\\.\\d+)`, 'gm');
    const versions = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      versions.add(m[1]);
    }
    if (versions.size === 0) continue;
    for (const version of versions) {
      const major = majorOf(version);
      if (!allowed.includes(major)) {
        errors.push(
          `${relPath}: ${name} resolved to ${version} (major ${major}), ` +
            `but only major(s) [${allowed.join(', ')}] are known to build. ` +
            `Either revert the bump or update ALLOWED_MAJORS in ` +
            `scripts/check-vite-pinned.mjs after validating the upgrade.`,
        );
      }
    }
  }
}

for (const p of PACKAGE_JSONS_REQUIRING_DIRECT_DEPS) checkDirectDep(p);
for (const p of NPM_LOCKFILES) checkNpmLockfile(p);
for (const p of PNPM_LOCKFILES) checkPnpmLockfile(p);

if (errors.length > 0) {
  console.error('✗ Vite pin check failed:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    '\nThis guard exists because vite@8 (rolldown-vite) silently broke ' +
      'the production build once before. See Task #1166.',
  );
  process.exit(1);
}

console.log('✓ Vite pin check passed (vite, @vitejs/plugin-react, @tailwindcss/vite)');
