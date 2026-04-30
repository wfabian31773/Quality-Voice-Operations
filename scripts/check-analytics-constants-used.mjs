#!/usr/bin/env node
/**
 * Marketing analytics constants drift check.
 *
 * Task #1082 introduced canonical constants in
 * `client-app/src/lib/analyticsLabels.ts` (`FEATURE`, `VERTICAL_ACTION`,
 * `SIGNUP_STEP`) and Task #426 introduced
 * `client-app/src/lib/analyticsCtas.ts` (`CTA`). The custom ESLint rules
 * (`no-literal-cta-name` / `no-literal-analytics-label`) already prevent
 * the *forward* drift — a call site stops using the canonical constant
 * and inlines a string literal instead.
 *
 * This script catches the *reverse* drift: a constant gets deleted from
 * the call site (or renamed) and quietly stays in the constants file
 * forever, polluting funnel definitions and confusing future authors.
 *
 * It scans every exported member of the four canonical objects above
 * and verifies it is referenced (qualified — e.g. `CTA.TRY_LIVE_DEMO`)
 * somewhere under `client-app/` or `platform/`, ignoring the constants
 * files themselves. Anything unreferenced is reported and the script
 * exits non-zero so CI catches it.
 *
 * Wired into `npm run lint:rules`.
 *
 * Usage:
 *   node scripts/check-analytics-constants-used.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SOURCES = [
  {
    file: 'client-app/src/lib/analyticsCtas.ts',
    objects: ['CTA'],
  },
  {
    file: 'client-app/src/lib/analyticsLabels.ts',
    objects: ['FEATURE', 'VERTICAL_ACTION', 'SIGNUP_STEP'],
  },
];

// Directories scanned for references. Kept narrow on purpose: these are
// marketing/funnel constants consumed by the React app and the platform
// admin/tenant code; nothing on the server emits them.
const SCAN_DIRS = ['client-app', 'platform'];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
]);

/**
 * Extract the keys of a top-level `export const NAME = { ... } as const;`
 * block from a TypeScript source string.
 *
 * The constants files are hand-authored with a strict shape (each member
 * sits on its own line, optionally preceded by `//` comments), so a
 * regex-based extractor is sufficient and avoids pulling in a TS parser
 * just for this check.
 */
function extractMembers(source, objectName, filePath) {
  const headerRe = new RegExp(
    `export\\s+const\\s+${objectName}\\s*=\\s*\\{`,
    'm',
  );
  const headerMatch = headerRe.exec(source);
  if (!headerMatch) {
    throw new Error(
      `Could not find "export const ${objectName} = { ... }" in ${filePath}. ` +
        `If the export was renamed, update scripts/check-analytics-constants-used.mjs.`,
    );
  }

  // Walk braces from the opening `{` to find the matching close.
  let depth = 0;
  let start = headerMatch.index + headerMatch[0].length - 1; // position of `{`
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(
      `Unterminated object literal for ${objectName} in ${filePath}.`,
    );
  }

  const body = source.slice(start + 1, end);
  // Match `KEY:` at the start of a (possibly indented) line. Keys are
  // SCREAMING_SNAKE identifiers by convention.
  const keys = [];
  const keyRe = /^\s*([A-Z][A-Z0-9_]*)\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) {
    keys.push(m[1]);
  }
  if (keys.length === 0) {
    throw new Error(
      `Parsed zero members for ${objectName} in ${filePath} — the regex may need updating.`,
    );
  }
  return keys;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1) continue;
      const ext = entry.name.slice(dot);
      if (SCAN_EXTENSIONS.has(ext)) yield full;
    }
  }
}

function loadScannedFiles(excluded) {
  const excludedAbs = new Set(excluded.map((p) => resolve(root, p)));
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = resolve(root, dir);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const file of walk(abs)) {
      if (excludedAbs.has(file)) continue;
      files.push(file);
    }
  }
  return files;
}

function main() {
  const sources = SOURCES.map((s) => {
    const abs = resolve(root, s.file);
    const text = readFileSync(abs, 'utf8');
    const members = s.objects.flatMap((obj) =>
      extractMembers(text, obj, s.file).map((key) => ({
        object: obj,
        key,
        file: s.file,
      })),
    );
    return { ...s, members };
  });

  const allMembers = sources.flatMap((s) => s.members);
  const exclude = SOURCES.map((s) => s.file);
  const files = loadScannedFiles(exclude);

  // Read every scanned file once, then look for `OBJECT.KEY` references.
  // We use a literal substring check (not a regex) because the qualified
  // form is unambiguous and orders of magnitude faster on a large tree
  // than running a regex per (file × member) pair.
  const seen = new Set();
  const targets = allMembers.map((m) => `${m.object}.${m.key}`);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const target of targets) {
      if (seen.has(target)) continue;
      if (text.includes(target)) seen.add(target);
    }
    if (seen.size === targets.length) break;
  }

  const unused = allMembers.filter(
    (m) => !seen.has(`${m.object}.${m.key}`),
  );

  if (unused.length === 0) {
    const total = allMembers.length;
    console.log(
      `analytics constants: all ${total} exported member(s) are referenced.`,
    );
    return;
  }

  const byFile = new Map();
  for (const m of unused) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }

  console.error('Unused marketing analytics constants detected:');
  console.error('');
  for (const [file, members] of byFile) {
    console.error(`  ${file}`);
    for (const m of members) {
      console.error(`    - ${m.object}.${m.key}`);
    }
  }
  console.error('');
  console.error(
    'Each constant above is exported from a canonical analytics file but is not\n' +
      'referenced anywhere under ' +
      SCAN_DIRS.map((d) => `${d}/`).join(' or ') +
      '. Remove the dead member, or add a call site that uses it.',
  );
  process.exit(1);
}

main();
