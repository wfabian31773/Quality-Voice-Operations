#!/usr/bin/env node
/**
 * Sitemap coverage check.
 *
 * The sitemap generator's `STATIC_ROUTES` list in `scripts/generate-sitemap.mjs`
 * mirrors the `<Route element={<PublicLayout />}>` block in
 * `client-app/src/App.tsx` (and `client-app/src/PublicApp.tsx`) by hand. If a
 * contributor adds a new public route there and forgets to add it to
 * `STATIC_ROUTES`, the sitemap silently misses it — search engines never
 * discover the page, there is no runtime error, and no production alert.
 *
 * This script parses both `App.tsx` and `PublicApp.tsx`, extracts every static
 * path declared inside the `<PublicLayout />` route group, and asserts that
 * each one is also present in `STATIC_ROUTES`. It also flags `STATIC_ROUTES`
 * entries that no longer correspond to a declared public route (orphans).
 *
 * Dynamic segments (e.g. `/docs/:slug`, `/industries/:vertical`,
 * `/case-studies/:slug`) are intentionally skipped — those are resolved by
 * `collectDynamicPaths()` in the generator, which scans the underlying data
 * files instead.
 *
 * Exits non-zero on drift. Wired into the PR Typecheck workflow and
 * `scripts/post-merge.sh` alongside `check:i18n-keys`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STATIC_ROUTES } from './generate-sitemap.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Files whose `<Route element={<PublicLayout />}>` block defines the public
 * marketing route table. Both files mirror each other today (App.tsx is the
 * full SPA, PublicApp.tsx is the marketing-only bundle) — we union the two
 * sets so a route only listed in one of them is still treated as declared.
 */
export const APP_FILES = [
  'client-app/src/App.tsx',
  'client-app/src/PublicApp.tsx',
];

/**
 * Extract every `path="…"` declared inside the first
 * `<Route element={<PublicLayout />}>` group in `source`.
 *
 * The parser is intentionally regex-based rather than a real JSX parser:
 * - The opening tag is matched with a small regex tolerant of whitespace
 *   between attributes.
 * - The matching `</Route>` is the next `</Route>` after that opening, since
 *   every nested `<Route path="…" element={<X />} />` is self-closing in
 *   both files we parse.
 *
 * Returns `null` if no `<PublicLayout />` block is found (so the caller can
 * surface a helpful error rather than silently passing).
 */
export function extractPublicRoutePaths(source) {
  const openRe = /<Route\s+element=\{<PublicLayout\s*\/>\}>/;
  const open = openRe.exec(source);
  if (!open) return null;

  const after = source.slice(open.index + open[0].length);
  const closeIdx = after.indexOf('</Route>');
  if (closeIdx === -1) {
    throw new Error(
      'extractPublicRoutePaths: <Route element={<PublicLayout />}> opened but no closing </Route> found',
    );
  }
  const block = after.slice(0, closeIdx);

  const paths = [];
  const pathRe = /<Route\s+path="([^"]+)"/g;
  let m;
  while ((m = pathRe.exec(block)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

/**
 * A path is "dynamic" if any segment is a React-Router param (`:slug`,
 * `:vertical`, …). Dynamic paths are resolved by `collectDynamicPaths()` in
 * the sitemap generator and are intentionally excluded from `STATIC_ROUTES`,
 * so we skip them here too.
 */
export function isDynamicPath(p) {
  return p.split('/').some((seg) => seg.startsWith(':'));
}

/**
 * Compare the public route tables in `files` against `staticRoutes`.
 *
 * Returns an object with three arrays:
 *   - `missingFromSitemap`: paths declared in App.tsx/PublicApp.tsx but not
 *     present in `STATIC_ROUTES`. This is the primary failure mode the check
 *     exists to catch.
 *   - `orphanedInSitemap`: `STATIC_ROUTES` entries that no public route
 *     declares anywhere (e.g. a marketing page was deleted but the sitemap
 *     entry was left behind).
 *   - `errors`: file-level problems (missing PublicLayout block, unreadable
 *     file). These are treated as drift too.
 */
export function findSitemapDrift({
  files = APP_FILES,
  staticRoutes = STATIC_ROUTES,
  repoRoot = REPO_ROOT,
} = {}) {
  const staticSet = new Set(staticRoutes.map((r) => r.path));
  const declaredStatic = new Map(); // path -> [files]
  const errors = [];

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch (err) {
      errors.push(`${rel}: could not be read (${err.message})`);
      continue;
    }
    let paths;
    try {
      paths = extractPublicRoutePaths(src);
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
      continue;
    }
    if (paths === null) {
      errors.push(`${rel}: no <Route element={<PublicLayout />}> block found`);
      continue;
    }
    for (const p of paths) {
      if (isDynamicPath(p)) continue;
      const arr = declaredStatic.get(p) || [];
      arr.push(rel);
      declaredStatic.set(p, arr);
    }
  }

  const missingFromSitemap = [];
  for (const [p, sources] of declaredStatic) {
    if (!staticSet.has(p)) {
      missingFromSitemap.push({ path: p, sources });
    }
  }

  const declaredSet = new Set(declaredStatic.keys());
  const orphanedInSitemap = [];
  for (const r of staticRoutes) {
    if (!declaredSet.has(r.path)) {
      orphanedInSitemap.push(r.path);
    }
  }

  return {
    missingFromSitemap,
    orphanedInSitemap,
    errors,
    declaredCount: declaredStatic.size,
  };
}

function isCli() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === __filename;
}

if (isCli()) {
  const { missingFromSitemap, orphanedInSitemap, errors, declaredCount } = findSitemapDrift();
  let failed = false;

  if (errors.length) {
    failed = true;
    for (const e of errors) {
      console.error(`error: ${e}`);
    }
  }

  if (missingFromSitemap.length) {
    failed = true;
    console.error(
      'Public routes declared in App.tsx / PublicApp.tsx are missing from STATIC_ROUTES in scripts/generate-sitemap.mjs:',
    );
    for (const { path: p, sources } of missingFromSitemap) {
      console.error(`  - ${p}  (declared in ${sources.join(', ')})`);
    }
  }

  if (orphanedInSitemap.length) {
    failed = true;
    console.error(
      'STATIC_ROUTES entries in scripts/generate-sitemap.mjs are not present in any <PublicLayout /> route group:',
    );
    for (const p of orphanedInSitemap) {
      console.error(`  - ${p}`);
    }
  }

  if (failed) {
    console.error(
      '\nUpdate scripts/generate-sitemap.mjs (STATIC_ROUTES) so it matches the public route table in App.tsx / PublicApp.tsx.',
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`OK: STATIC_ROUTES matches ${declaredCount} public routes declared in ${APP_FILES.join(', ')}.`);
}
