#!/usr/bin/env node
/**
 * Design tokens sync check.
 *
 * Asserts that the token values in
 * `client-app/src/lib/designTokens.ts` match the corresponding
 * CSS custom properties shipped to Tailwind by the brand bridge in
 * `client-app/src/styles/_theme.css`. Drift between the two would
 * cause charts/programmatic UI to render in a different palette
 * than the rest of the app.
 *
 * The bridge aliases every `--color-*` / `--radius-*` token to a
 * `--qvo-*` primitive defined in the canonical brand kit
 * (`client-app/src/brand/qvo-global.css`), and dark mode flips by
 * redefining those primitives under `[data-theme="dark"]`. So a raw
 * string compare is meaningless — this check RESOLVES the `var()`
 * chains through the real CSS cascade before comparing:
 *   - light: @theme value → resolve via brand kit `:root`
 *   - dark:  `.dark` chrome override (if any) else @theme value,
 *            resolved via brand kit `[data-theme="dark"]` (falling
 *            back to `:root`)
 * Non-var() values (rgba(), color-mix(), raw hex) pass through as-is.
 *
 * Exits non-zero on any mismatch. Designed to be cheap enough to
 * run in CI on every PR that touches either file.
 *
 * Usage:
 *   node scripts/check-design-tokens-sync.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const cssPath = resolve(root, "client-app/src/styles/_theme.css");
const tsPath = resolve(root, "client-app/src/lib/designTokens.ts");
const brandPath = resolve(root, "client-app/src/brand/qvo-global.css");

// Strip CSS block comments up front so the brace-aware block scanner can
// never trip on `{`/`}` that appear inside a comment (e.g. the file header
// literally mentions `@theme {}`). `ts` is left raw — it is read with
// targeted regexes, not block scanning.
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = stripCssComments(readFileSync(cssPath, "utf8"));
const ts = readFileSync(tsPath, "utf8");
const brand = stripCssComments(readFileSync(brandPath, "utf8"));

/**
 * Extract the inner body of the FIRST CSS block matching `selector`.
 * Uses a brace-aware scan (not a `\n}` regex) so it is robust to CSS
 * reformatting — closing brace on the same line, nested braces, CRLF, etc.
 */
function blockBody(src, selector) {
  const re = new RegExp(`${selector}\\s*\\{`, "m");
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return src.slice(start, i - 1);
}

/** Parse `--name: value;` declarations from a block body into a Map. */
function parseDecls(body) {
  const map = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1].trim(), m[2].trim().replace(/\s*\/\*[\s\S]*?\*\/\s*$/, "").trim());
  }
  return map;
}

// Brand-kit primitives: light (`:root`) + dark overrides (`[data-theme="dark"]`).
const brandLight = parseDecls(blockBody(brand, ":root"));
const brandDark = parseDecls(blockBody(brand, '\\[data-theme="dark"\\]'));
// Bridge tokens: light (`@theme`) + dark chrome overrides (`.dark`).
const themeLight = parseDecls(blockBody(css, "@theme"));
const themeDark = parseDecls(blockBody(css, "\\n\\.dark"));

/** Resolve a single-level `var(--x)` chain to a concrete value for the mode. */
function resolveVar(value, mode, depth = 0) {
  if (value == null || depth > 16) return value;
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (!m) return value.trim(); // hex / rgba / color-mix — leave literal
  const name = m[1];
  let next;
  if (mode === "dark" && brandDark.has(name)) next = brandDark.get(name);
  else if (brandLight.has(name)) next = brandLight.get(name);
  else return value.trim();
  return resolveVar(next, mode, depth + 1);
}

/**
 * Effective value of a bridge token `--name` in `light` or `dark`.
 * Models the cascade: a `.dark` override wins; otherwise the `@theme`
 * definition is resolved against the dark primitive overrides.
 */
function cssVar(name, { mode = "light" } = {}) {
  const key = `--${name}`;
  if (mode === "dark" && themeDark.has(key)) {
    return resolveVar(themeDark.get(key), "dark");
  }
  if (themeLight.has(key)) {
    return resolveVar(themeLight.get(key), mode);
  }
  throw new Error(`CSS var --${name} not found in @theme`);
}

/** Find an object literal property value in the TS source, e.g. `primary: "#1F8E83"`. */
function tsValue(objectName, propName) {
  // Find the named const declaration block.
  const declRe = new RegExp(
    `export const ${objectName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*as const;`,
    "m",
  );
  const decl = declRe.exec(ts);
  if (!decl) {
    throw new Error(`TS object \`${objectName}\` not found`);
  }
  const propRe = new RegExp(`\\b${propName}:\\s*"([^"]+)"`, "m");
  const m = propRe.exec(decl[1]);
  if (!m) {
    throw new Error(`TS property \`${objectName}.${propName}\` not found`);
  }
  return m[1].trim();
}

/** Normalize a hex color: lowercase, strip whitespace. Accepts CSS-style values too. */
function normalize(value) {
  return value.toLowerCase().trim();
}

// (cssVarName, tsObject, tsProp, [block])
const lightChecks = [
  // Brand
  ["color-primary", "palette", "primary"],
  ["color-primary-hover", "palette", "primaryHover"],
  ["color-primary-light", "palette", "primaryLight"],
  ["color-on-primary", "palette", "onPrimary"],
  ["color-accent", "palette", "accent"],
  ["color-accent-hover", "palette", "accentHover"],
  ["color-accent-light", "palette", "accentLight"],
  // Semantic
  ["color-success", "palette", "success"],
  ["color-warning", "palette", "warning"],
  ["color-danger", "palette", "danger"],
  ["color-info", "palette", "info"],
  // Surfaces / text
  ["color-surface", "palette", "surface"],
  ["color-surface-secondary", "palette", "surfaceSecondary"],
  ["color-surface-hover", "palette", "surfaceHover"],
  ["color-surface-inverse", "palette", "surfaceInverse"],
  ["color-on-inverse", "palette", "onInverse"],
  ["color-border", "palette", "border"],
  ["color-border-strong", "palette", "borderStrong"],
  ["color-text-primary", "palette", "textPrimary"],
  ["color-text-secondary", "palette", "textSecondary"],
  ["color-text-muted", "palette", "textMuted"],
  // Sidebar
  ["color-sidebar-bg", "palette", "sidebarBg"],
  ["color-sidebar-text", "palette", "sidebarText"],
  ["color-sidebar-active", "palette", "sidebarActive"],
  ["color-sidebar-hover", "palette", "sidebarHover"],
  ["color-on-sidebar", "palette", "onSidebar"],
  ["color-overlay", "palette", "overlay"],
];

const darkChecks = [
  ["color-primary", "paletteDark", "primary"],
  ["color-primary-hover", "paletteDark", "primaryHover"],
  ["color-on-primary", "paletteDark", "onPrimary"],
  ["color-success", "paletteDark", "success"],
  ["color-warning", "paletteDark", "warning"],
  ["color-danger", "paletteDark", "danger"],
  ["color-info", "paletteDark", "info"],
  ["color-surface", "paletteDark", "surface"],
  ["color-surface-secondary", "paletteDark", "surfaceSecondary"],
  ["color-border", "paletteDark", "border"],
  ["color-text-primary", "paletteDark", "textPrimary"],
  ["color-text-secondary", "paletteDark", "textSecondary"],
  ["color-sidebar-bg", "paletteDark", "sidebarBg"],
  ["color-sidebar-active", "paletteDark", "sidebarActive"],
  ["color-on-sidebar", "paletteDark", "onSidebar"],
  ["color-overlay", "paletteDark", "overlay"],
];

const radiusChecks = [
  ["radius-sm", "radius", "sm"],
  ["radius-md", "radius", "md"],
  ["radius-lg", "radius", "lg"],
  ["radius-xl", "radius", "xl"],
  ["radius-pill", "radius", "pill"],
];

const failures = [];

function compare(label, cssValue, tsVal) {
  if (normalize(cssValue) !== normalize(tsVal)) {
    failures.push(`  • ${label}\n      CSS: ${cssValue}\n      TS:  ${tsVal}`);
  }
}

for (const [cssName, obj, prop] of lightChecks) {
  try {
    compare(`light ${cssName} ↔ ${obj}.${prop}`, cssVar(cssName), tsValue(obj, prop));
  } catch (err) {
    failures.push(`  • light ${cssName} ↔ ${obj}.${prop}: ${err.message}`);
  }
}

for (const [cssName, obj, prop] of darkChecks) {
  try {
    compare(
      `dark  ${cssName} ↔ ${obj}.${prop}`,
      cssVar(cssName, { mode: "dark" }),
      tsValue(obj, prop),
    );
  } catch (err) {
    failures.push(`  • dark ${cssName} ↔ ${obj}.${prop}: ${err.message}`);
  }
}

for (const [cssName, obj, prop] of radiusChecks) {
  try {
    compare(`radius ${cssName} ↔ ${obj}.${prop}`, cssVar(cssName), tsValue(obj, prop));
  } catch (err) {
    failures.push(`  • radius ${cssName} ↔ ${obj}.${prop}: ${err.message}`);
  }
}

const totalChecks = lightChecks.length + darkChecks.length + radiusChecks.length;

if (failures.length > 0) {
  console.error(
    `\n❌ Design tokens are out of sync (${failures.length}/${totalChecks} mismatches):\n`,
  );
  console.error(failures.join("\n"));
  console.error(
    `\nFix: edit BOTH client-app/src/styles/_theme.css AND client-app/src/lib/designTokens.ts so the values match. See docs/design-system.md.\n`,
  );
  process.exit(1);
}

console.log(
  `✓ Design tokens are in sync (${totalChecks} checks: ${lightChecks.length} light, ${darkChecks.length} dark, ${radiusChecks.length} radius).`,
);
