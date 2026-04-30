#!/usr/bin/env node
/**
 * Design tokens sync check.
 *
 * Asserts that the locked Refined Harbor token values in
 * `client-app/src/lib/designTokens.ts` match the corresponding
 * CSS custom properties in the `@theme` block of
 * `client-app/src/styles/_theme.css`. Drift between the two would
 * cause charts/programmatic UI to render in a different palette
 * than the rest of the app.
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

const css = readFileSync(cssPath, "utf8");
const ts = readFileSync(tsPath, "utf8");

/** Find a CSS custom property value within a given block (default = :root / @theme). */
function cssVar(name, { block } = {}) {
  // Restrict the search to a specific block (e.g. ".dark { ... }") if given.
  let haystack = css;
  if (block) {
    const blockRe = new RegExp(`${block}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
    const match = blockRe.exec(css);
    if (!match) {
      throw new Error(`Could not find CSS block: ${block}`);
    }
    haystack = match[1];
  }
  const re = new RegExp(`--${name}:\\s*([^;\\n]+);`, "m");
  const m = re.exec(haystack);
  if (!m) {
    throw new Error(`CSS var --${name} not found${block ? ` in ${block}` : ""}`);
  }
  return m[1].trim();
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
      cssVar(cssName, { block: "\\.dark" }),
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
