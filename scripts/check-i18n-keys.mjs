#!/usr/bin/env node
/**
 * i18n key sync check.
 *
 * Asserts that every translation key present in the English source-of-truth
 * locale files (`client-app/src/locales/en/*.json`) is also present in every
 * other supported locale shipped by `client-app/src/lib/i18n.ts`
 * (today: `de`, `es`, `fr`, `pt-BR`), and vice versa.
 *
 * Why: when a developer adds new keys to `en/common.json` (for example for a
 * new marketing page) but forgets to add them to the other locale files,
 * users in those locales silently see the raw key (e.g.
 * `vertical_agents_page.spotlight.partner_cta`) instead of a translated
 * string. There is no runtime error, no console warning, and no production
 * alert — it just looks broken. This script catches that drift in CI.
 *
 * Exits non-zero on any drift. Designed to be cheap enough to run in CI on
 * every PR that touches a locale file.
 *
 * Tolerated overrides:
 *   Some keys are intentionally English-only (brand names, untranslated
 *   product taglines, etc.) or intentionally missing from a specific
 *   locale. Add them to `scripts/i18n-allowed-overrides.json` (see the file
 *   header for the schema). Anything not listed there is treated as drift.
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
 * Supports both shapes:
 *   ns: ['common', 'docs', ...]                          (inline literal)
 *   const NAMESPACES = ['common', ...] as const;
 *   ...
 *   ns: NAMESPACES as unknown as string[]                (named constant)
 */
function parseNamespaces() {
  const src = readFileSync(i18nFile, "utf8");
  let listSrc = null;
  const inline = /\bns:\s*\[([^\]]+)\]/m.exec(src);
  if (inline) {
    listSrc = inline[1];
  } else {
    const nsRef = /\bns:\s*([A-Za-z_$][\w$]*)\b/m.exec(src);
    if (nsRef) {
      const ident = nsRef[1];
      const constRe = new RegExp(
        `\\b(?:const|let|var)\\s+${ident}\\s*=\\s*\\[([^\\]]+)\\]`,
        "m",
      );
      const constMatch = constRe.exec(src);
      if (constMatch) {
        listSrc = constMatch[1];
      }
    }
  }
  if (!listSrc) {
    throw new Error(
      `Could not find \`ns: [...]\` in ${i18nFile}. Update scripts/check-i18n-keys.mjs.`,
    );
  }
  const names = [];
  const nameRe = /'([^']+)'/g;
  let nm;
  while ((nm = nameRe.exec(listSrc)) !== null) {
    names.push(nm[1]);
  }
  if (names.length === 0) {
    throw new Error(
      `Namespaces parsed empty from ${i18nFile} — the regex may need updating.`,
    );
  }
  return names;
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
 *     }
 *   }
 *
 * `missing` = keys present in `en` that this locale is allowed to NOT have
 *             (e.g. brand names that should fall through to English).
 * `extra`   = keys present in this locale that are NOT in `en` (e.g. a
 *             locale-specific note that has no English equivalent).
 */
function loadOverrides() {
  if (!existsSync(overridesFile)) {
    return { missing: {}, extra: {} };
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
    const sourceKeys = new Set(flattenKeys(loadNamespace(SOURCE_LOCALE, ns)));
    for (const locale of otherLocales) {
      const targetKeys = new Set(flattenKeys(loadNamespace(locale, ns)));
      const missingAllow = allowedSet(resolvedOverrides, "missing", locale, ns);
      const extraAllow = allowedSet(resolvedOverrides, "extra", locale, ns);
      const { missing, extra } = diffKeys(sourceKeys, targetKeys, missingAllow, extraAllow);
      if (missing.length || extra.length) {
        report.push({ locale, namespace: ns, missing, extra });
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
  for (const entry of result.drift) {
    totalMissing += entry.missing.length;
    totalExtra += entry.extra.length;
    lines.push(
      `\n  • ${entry.locale}/${entry.namespace}.json — ${entry.missing.length} missing, ${entry.extra.length} extra:`,
    );
    for (const k of entry.missing) lines.push(`      - missing: ${k}`);
    for (const k of entry.extra) lines.push(`      + extra:   ${k}`);
  }
  lines.push(
    `\nFix: add the missing keys to the listed locale files (or, for an intentional` +
      ` override, add the key to scripts/i18n-allowed-overrides.json). Source of truth is` +
      ` client-app/src/locales/${result.sourceLocale}/.`,
  );
  return {
    summary:
      `i18n keys are out of sync (${result.drift.length} files affected, ` +
      `${totalMissing} missing, ${totalExtra} extra)`,
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
