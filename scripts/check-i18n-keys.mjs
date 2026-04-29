#!/usr/bin/env node
/**
 * i18n key + value sync check.
 *
 * Three classes of drift are reported:
 *
 *  1. `missing` — every translation key present in the English source-of-
 *     truth locale files (`client-app/src/locales/en/*.json`) must also be
 *     present in every other supported locale shipped by
 *     `client-app/src/lib/i18n.ts` (today: `de`, `es`, `fr`, `pt-BR`).
 *  2. `extra`   — and vice-versa: keys must not exist in a non-English
 *     locale without an English source.
 *  3. `sameAsEnglish` — every leaf string in a non-English locale must
 *     differ from its English counterpart, unless the key is explicitly
 *     allowlisted. This catches the "translator copy-pasted the English
 *     string into the German file" failure mode that the missing-key check
 *     does not — the key *is* present, it just hasn't actually been
 *     translated.
 *
 * Why this exists: when a developer adds new keys to `en/common.json` (for
 * example for a new marketing page) but forgets to add them to the other
 * locale files, users in those locales silently see the raw key (e.g.
 * `vertical_agents_page.spotlight.partner_cta`) instead of a translated
 * string. The same-as-English variant is just as bad: a German user sees an
 * untranslated English sentence in the middle of an otherwise-German UI.
 * There is no runtime error, no console warning, and no production alert
 * for either failure — it just looks broken. This script catches both in CI.
 *
 * Exits non-zero on any drift. Designed to be cheap enough to run in CI on
 * every PR that touches a locale file.
 *
 * Tolerated overrides:
 *   Some keys are intentionally English-only (brand names, untranslated
 *   product taglines, etc.), intentionally missing from a specific locale,
 *   or intentionally identical to English (brand names, format strings,
 *   placeholders like "Acme Corp"). Add them to
 *   `scripts/i18n-allowed-overrides.json` (see the file header for the
 *   schema). Anything not listed there is treated as drift.
 *
 * Usage:
 *   node scripts/check-i18n-keys.mjs
 *   node scripts/check-i18n-keys.mjs --json   # machine-readable diff
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const localesDir = resolve(root, "client-app/src/locales");
const i18nFile = resolve(root, "client-app/src/lib/i18n.ts");
const overridesFile = resolve(here, "i18n-allowed-overrides.json");

const SOURCE_LOCALE = "en";

/** Parse SUPPORTED_LANGUAGES out of `client-app/src/lib/i18n.ts` so this
 *  script automatically picks up new locales without code changes. */
function parseSupportedLocales() {
  const src = readFileSync(i18nFile, "utf8");
  const blockRe =
    /export const SUPPORTED_LANGUAGES\s*=\s*\[([\s\S]*?)\]\s*as const;/m;
  const m = blockRe.exec(src);
  if (!m) {
    throw new Error(
      `Could not find SUPPORTED_LANGUAGES block in ${i18nFile}. ` +
        `If the export was renamed, update scripts/check-i18n-keys.mjs.`,
    );
  }
  const codes = [];
  const codeRe = /code:\s*'([^']+)'/g;
  let cm;
  while ((cm = codeRe.exec(m[1])) !== null) {
    codes.push(cm[1]);
  }
  if (codes.length === 0) {
    throw new Error(
      `SUPPORTED_LANGUAGES parsed empty from ${i18nFile} — the regex may need updating.`,
    );
  }
  return codes;
}

/** Parse the namespaces out of the i18n init call.
 *
 *  Two shapes are accepted, in priority order:
 *    1. The current shape (added by task #625): a hoisted const declaration
 *       like `const NAMESPACES = ['common', 'docs', ...] as const;` that is
 *       passed into i18next.init({ ns: NAMESPACES as unknown as string[] }).
 *    2. The legacy shape: a literal `ns: ['common', 'docs', ...]` argument
 *       passed directly to i18next.init({ ... }).
 *
 *  Both shapes resolve to the same list of namespaces. We accept both so a
 *  future revert (or a parallel branch still on the literal-`ns` form) does
 *  not break the check.
 */
export function parseNamespacesFromSource(src, sourceLabel = "(source)") {
  const constMatch =
    /\bNAMESPACES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/m.exec(src);
  const literalMatch = /\bns:\s*\[([^\]]*)\]/m.exec(src);
  const inner = constMatch?.[1] ?? literalMatch?.[1];
  if (inner === undefined) {
    throw new Error(
      `Could not find \`NAMESPACES = [...] as const\` or \`ns: [...]\` in ${sourceLabel}. ` +
        `Update scripts/check-i18n-keys.mjs.`,
    );
  }
  const names = [];
  const nameRe = /['"]([^'"]+)['"]/g;
  let nm;
  while ((nm = nameRe.exec(inner)) !== null) {
    names.push(nm[1]);
  }
  if (names.length === 0) {
    throw new Error(
      `Namespaces parsed empty from ${sourceLabel} — the regex may need updating.`,
    );
  }
  return names;
}

function parseNamespaces() {
  return parseNamespacesFromSource(readFileSync(i18nFile, "utf8"), i18nFile);
}

/** Recursively flatten a JSON object into dotted leaf-key paths. */
function flattenKeys(obj, prefix = "", out = []) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out.push(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    flattenKeys(v, next, out);
  }
  return out;
}

/** Recursively flatten a JSON object into a `{ "dotted.key": leafValue }` map.
 *
 *  Used by the same-as-English check, which needs the *value* of each leaf
 *  in addition to its key. Numbers, booleans, and `null` are preserved as-is
 *  but the same-as-English check ignores anything that isn't a string —
 *  format-string equality on non-string leaves is meaningless. */
export function flattenValues(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    flattenValues(v, next, out);
  }
  return out;
}

function loadNamespace(locale, namespace) {
  const file = resolve(localesDir, locale, `${namespace}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `Missing locale file: ${file}. Every supported locale must ship every namespace.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }
  return parsed;
}

/**
 * Load the allowlist of intentional language-specific overrides.
 *
 * Schema:
 *   {
 *     "missing": {
 *       "<locale>": { "<namespace>": ["dotted.key.path", ...] }
 *     },
 *     "extra": {
 *       "<locale>": { "<namespace>": ["dotted.key.path", ...] }
 *     },
 *     "sameAsEnglish": {
 *       "<locale>": { "<namespace>": ["dotted.key.path", ...] }
 *     }
 *   }
 *
 * `missing`       = keys present in `en` that this locale is allowed to NOT
 *                   have (e.g. brand names that should fall through to
 *                   English).
 * `extra`         = keys present in this locale that are NOT in `en` (e.g. a
 *                   locale-specific note that has no English equivalent).
 * `sameAsEnglish` = keys whose value in this locale is intentionally
 *                   identical to the English value (brand names, product
 *                   proper nouns, format strings like "n={{n}}", placeholder
 *                   data like "Acme Corp", etc.). Anything not listed here
 *                   that has the same string as `en` is treated as drift
 *                   ("translator forgot to translate this entry").
 */
function loadOverrides() {
  if (!existsSync(overridesFile)) {
    return { missing: {}, extra: {}, sameAsEnglish: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(overridesFile, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${overridesFile}: ${err.message}`);
  }
  return {
    missing: parsed.missing ?? {},
    extra: parsed.extra ?? {},
    sameAsEnglish: parsed.sameAsEnglish ?? {},
  };
}

function allowedSet(overrides, kind, locale, namespace) {
  return new Set(overrides?.[kind]?.[locale]?.[namespace] ?? []);
}

function diffKeys(sourceKeys, targetKeys, missingAllow, extraAllow) {
  const missing = [];
  const extra = [];
  for (const k of sourceKeys) {
    if (!targetKeys.has(k) && !missingAllow.has(k)) missing.push(k);
  }
  for (const k of targetKeys) {
    if (!sourceKeys.has(k) && !extraAllow.has(k)) extra.push(k);
  }
  missing.sort();
  extra.sort();
  return { missing, extra };
}

/** Find leaf string entries whose non-English value is byte-for-byte equal
 *  to the English value. Anything in `sameAsEnglishAllow` is ignored.
 *
 *  Why string-only: i18n leaves are ~99% strings, but we also tolerate
 *  arrays/numbers/booleans/null inside locale JSONs (e.g. ordered list
 *  bodies in `docs.json`). Comparing those for equality across locales is
 *  meaningless — the array's *string* leaves are themselves separate dotted
 *  paths and get compared individually. */
export function findSameAsEnglish(sourceValues, targetValues, allow) {
  const offenders = [];
  for (const [k, sv] of Object.entries(sourceValues)) {
    if (typeof sv !== "string") continue;
    if (!(k in targetValues)) continue; // already reported by missing-key diff
    if (targetValues[k] !== sv) continue;
    if (allow.has(k)) continue;
    offenders.push(k);
  }
  offenders.sort();
  return offenders;
}

export function runI18nKeyCheck({ locales, namespaces, overrides } = {}) {
  const resolvedLocales = locales ?? parseSupportedLocales();
  const resolvedNamespaces = namespaces ?? parseNamespaces();
  const resolvedOverrides = overrides ?? loadOverrides();

  if (!resolvedLocales.includes(SOURCE_LOCALE)) {
    throw new Error(
      `Source locale '${SOURCE_LOCALE}' is not in SUPPORTED_LANGUAGES. ` +
        `If you intentionally renamed the source-of-truth, update scripts/check-i18n-keys.mjs.`,
    );
  }

  const otherLocales = resolvedLocales.filter((l) => l !== SOURCE_LOCALE);
  const report = [];

  for (const ns of resolvedNamespaces) {
    const sourceParsed = loadNamespace(SOURCE_LOCALE, ns);
    const sourceValues = flattenValues(sourceParsed);
    const sourceKeys = new Set(Object.keys(sourceValues));
    for (const locale of otherLocales) {
      const targetParsed = loadNamespace(locale, ns);
      const targetValues = flattenValues(targetParsed);
      const targetKeys = new Set(Object.keys(targetValues));
      const missingAllow = allowedSet(resolvedOverrides, "missing", locale, ns);
      const extraAllow = allowedSet(resolvedOverrides, "extra", locale, ns);
      const sameAllow = allowedSet(resolvedOverrides, "sameAsEnglish", locale, ns);
      const { missing, extra } = diffKeys(sourceKeys, targetKeys, missingAllow, extraAllow);
      const sameAsEnglish = findSameAsEnglish(sourceValues, targetValues, sameAllow);
      if (missing.length || extra.length || sameAsEnglish.length) {
        report.push({ locale, namespace: ns, missing, extra, sameAsEnglish });
      }
    }
  }

  return {
    sourceLocale: SOURCE_LOCALE,
    locales: resolvedLocales,
    namespaces: resolvedNamespaces,
    drift: report,
    ok: report.length === 0,
  };
}

function formatHumanReport(result) {
  const lines = [];
  let totalMissing = 0;
  let totalExtra = 0;
  let totalSame = 0;
  for (const entry of result.drift) {
    const same = entry.sameAsEnglish ?? [];
    totalMissing += entry.missing.length;
    totalExtra += entry.extra.length;
    totalSame += same.length;
    lines.push(
      `\n  • ${entry.locale}/${entry.namespace}.json — ${entry.missing.length} missing, ${entry.extra.length} extra, ${same.length} same-as-English:`,
    );
    for (const k of entry.missing) lines.push(`      - missing:        ${k}`);
    for (const k of entry.extra) lines.push(`      + extra:          ${k}`);
    for (const k of same) lines.push(`      = same-as-English: ${k}`);
  }
  lines.push(
    `\nFix: ` +
      `\n  • For "missing"/"extra" — add the key to the listed locale file, or, if the omission is intentional, add the key to scripts/i18n-allowed-overrides.json under "missing"/"extra".` +
      `\n  • For "same-as-English" — replace the English copy in the non-English locale file with a real translation. If the value is intentionally English (brand name, product proper noun, format string, placeholder data), add it to scripts/i18n-allowed-overrides.json under "sameAsEnglish".` +
      `\nSource of truth is client-app/src/locales/${result.sourceLocale}/.`,
  );
  return {
    summary:
      `i18n keys are out of sync (${result.drift.length} files affected, ` +
      `${totalMissing} missing, ${totalExtra} extra, ${totalSame} same-as-English)`,
    body: lines.join("\n"),
  };
}

// CLI entrypoint — only runs when invoked directly, not when imported by
// the vitest test that wraps this module.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const wantJson = process.argv.includes("--json");
  let result;
  try {
    result = runI18nKeyCheck();
  } catch (err) {
    if (wantJson) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`\n❌ i18n key check failed to run: ${err.message}\n`);
    }
    process.exit(2);
  }

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (!result.ok) {
    const { summary, body } = formatHumanReport(result);
    console.error(`\n❌ ${summary}:`);
    console.error(body);
    process.exit(1);
  }

  const totalKeys = result.namespaces.length * (result.locales.length - 1);
  console.log(
    `✓ i18n keys are in sync (source=${result.sourceLocale}, ` +
      `${result.locales.length - 1} other locales × ${result.namespaces.length} namespaces = ` +
      `${totalKeys} comparisons).`,
  );
}
