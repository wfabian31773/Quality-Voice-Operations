/**
 * Custom ESLint rule: no-raw-marketing-colors
 *
 * Flags raw white / gray / slate / zinc / neutral / stone Tailwind utility
 * classes inside JSX `className` strings under
 * `client-app/src/pages/public/` and `client-app/src/components/`. These
 * classes (`bg-white`, `from-white`, `text-slate-600`, `border-gray-200`,
 * etc.) bypass the QVO design tokens defined in
 * `client-app/src/styles/_theme.css` and silently break dark mode because
 * they don't flip with the theme.
 *
 * Until now the only safety net was the runtime e2e contrast test, which
 * only catches an issue once it actually fails contrast. This rule
 * catches the same drift statically at PR time and points the author at
 * the canonical theme tokens (`bg-surface`, `text-text-secondary`,
 * `border-border`, etc.).
 *
 * Allowlisted by default (no warning produced):
 *   - Any class with an alpha modifier — `bg-white/10`, `border-white/15`,
 *     `from-white/[0.08]`, `from-slate-500/25`. These are intentional
 *     overlays / glass tints on dark heroes.
 *   - `text-white`, `ring-white`, `border-white` (no alpha). These are
 *     routinely used on dark surfaces (sidebar, navy hero, dark CTAs)
 *     and don't break dark mode because they're already "on dark".
 *   - A raw light class paired with a `dark:` variant of the same
 *     utility prefix in the same className string — e.g.
 *     `bg-white dark:bg-gray-800` or `text-gray-600 dark:text-gray-300`.
 *     The author has explicitly handled both modes; we still prefer
 *     tokens, but it isn't a dark-mode bug.
 *   - `dark:` variants themselves are never flagged directly. The rule
 *     only flags the missing-light-mode-token side; we don't want to
 *     double-report the pair.
 *   - File paths listed in the rule's `allowedFiles` option (substring
 *     match against the source filename). Use this for known-intentional
 *     glass effects like `LiveTranscriptMock` if they ever drop the
 *     alpha modifier.
 *
 * What it walks:
 *   - JSX attributes named `className` or `class`.
 *   - Inside that attribute, it descends through string literals,
 *     template literals (including `${...}` expressions), conditionals,
 *     logical expressions, arrays, and `cn(...)`-style call arguments,
 *     so the rule still fires for
 *     `<div className={cn('bg-white', open && 'text-slate-600')} />`.
 *   - Object-literal keys passed to those helpers
 *     (e.g. `cn({ 'bg-white': true })`) are also checked.
 */
'use strict';

const UTILITY_PREFIXES = [
  'bg',
  'from',
  'to',
  'via',
  'text',
  'border',
  'ring',
  'ring-offset',
  'divide',
  'outline',
  'placeholder',
  'caret',
  'fill',
  'stroke',
  'decoration',
  'shadow',
  'accent',
];

const COLOR_PALETTES = [
  'white',
  'gray-\\d+',
  'slate-\\d+',
  'zinc-\\d+',
  'neutral-\\d+',
  'stone-\\d+',
];

const UTILITY_PREFIX_GROUP = '(' + UTILITY_PREFIXES.join('|') + ')';
const COLOR_GROUP = '(' + COLOR_PALETTES.join('|') + ')';
// Alpha modifier: `/10`, `/87.5`, `/[0.08]`, `/[var(--x)]`, etc.
const ALPHA_GROUP = '(\\/(?:\\d+(?:\\.\\d+)?|\\[[^\\]]+\\]))?';

// Variant prefixes like `dark:`, `hover:`, `md:`, `aria-checked:`,
// `data-[state=open]:`, `group-hover:`. We accept any chain of
// `<word-or-bracketed>:` segments before the actual utility.
const VARIANT_SEGMENT = '(?:[a-z][a-z0-9-]*|\\[[^\\]]+\\]|[a-z][a-z0-9-]*-\\[[^\\]]+\\])';
const VARIANT_PREFIX_GROUP = '((?:' + VARIANT_SEGMENT + ':)*)';

// Bare token, anchored — matches a single class like `bg-white`,
// `dark:bg-white`, `bg-white/10`, `from-white/[0.08]`, `text-slate-600`.
const TOKEN_RE = new RegExp(
  '^' + VARIANT_PREFIX_GROUP + UTILITY_PREFIX_GROUP + '-' + COLOR_GROUP + ALPHA_GROUP + '$'
);

// Loose match for ANY `dark:<utility>-...` token (color or token-name)
// so we can detect that the author has paired a `bg-white` with a
// `dark:bg-sidebar-bg` (token-based) or `dark:bg-gray-800` (raw).
// We deliberately don't constrain the color side here — the goal is
// just "is there a dark variant of this utility prefix?".
const ANY_DARK_UTILITY_RE = new RegExp(
  '(?:^|\\s)' +
    '(?:' + VARIANT_SEGMENT + ':)*' +
    'dark:' +
    '(?:' + VARIANT_SEGMENT + ':)*' +
    UTILITY_PREFIX_GROUP +
    '-',
  'g'
);

// `text-white`, `ring-white`, `border-white` (with no alpha) are
// intentionally allowed because they appear ~250 times across the
// dark-hero / sidebar surfaces and don't break dark mode.
const SOLID_WHITE_ALLOW = new Set(['text', 'ring', 'border']);

function findDarkUtilityPrefixes(str) {
  const set = new Set();
  if (!str) return set;
  ANY_DARK_UTILITY_RE.lastIndex = 0;
  let m;
  while ((m = ANY_DARK_UTILITY_RE.exec(str)) !== null) {
    set.add(m[1]);
  }
  return set;
}

function findRawColorViolations(str) {
  const violations = [];
  if (!str) return violations;
  const darkUtilities = findDarkUtilityPrefixes(str);
  // Tailwind class strings can include `&nbsp;`-ish weird whitespace, but
  // realistically `\s+` is enough for everything we ship.
  const tokens = str.split(/\s+/);
  for (const raw of tokens) {
    if (!raw) continue;
    const m = TOKEN_RE.exec(raw);
    if (!m) continue;
    const variantPrefix = m[1] || '';
    const utility = m[2];
    const color = m[3];
    const alpha = m[4] || null;
    // `dark:` variants are paired with the light side; flagging both
    // would be double-counting. We only flag the missing-token side.
    if (variantPrefix.split(':').includes('dark')) continue;
    // Alpha overlays are intentional (glass tints, dark hero overlays).
    if (alpha) continue;
    // Solid `text-white` / `ring-white` / `border-white` are fine.
    if (color === 'white' && SOLID_WHITE_ALLOW.has(utility)) continue;
    // Author already paired this with a `dark:` variant of the same
    // utility, so dark mode is handled even if it isn't tokenised.
    if (darkUtilities.has(utility)) continue;
    violations.push({ raw, utility, color });
  }
  return violations;
}

function reportViolations(node, str, context) {
  const violations = findRawColorViolations(str);
  for (const v of violations) {
    context.report({
      node,
      messageId: 'rawColor',
      data: { token: v.raw },
    });
  }
}

function visitClassNameValue(node, context, seen) {
  if (!node) return;
  if (seen.has(node)) return;
  seen.add(node);
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') {
        reportViolations(node, node.value, context);
      }
      return;
    case 'StringLiteral':
      if (typeof node.value === 'string') {
        reportViolations(node, node.value, context);
      }
      return;
    case 'TemplateLiteral':
      for (const quasi of node.quasis) {
        const cooked = quasi.value && quasi.value.cooked;
        if (typeof cooked === 'string') {
          reportViolations(quasi, cooked, context);
        }
      }
      for (const expr of node.expressions) {
        visitClassNameValue(expr, context, seen);
      }
      return;
    case 'JSXExpressionContainer':
      visitClassNameValue(node.expression, context, seen);
      return;
    case 'ConditionalExpression':
      visitClassNameValue(node.consequent, context, seen);
      visitClassNameValue(node.alternate, context, seen);
      return;
    case 'LogicalExpression':
      visitClassNameValue(node.left, context, seen);
      visitClassNameValue(node.right, context, seen);
      return;
    case 'ArrayExpression':
      for (const el of node.elements) visitClassNameValue(el, context, seen);
      return;
    case 'CallExpression':
      // cn('foo', condition && 'bg-white', { 'text-slate-600': isDark })
      for (const arg of node.arguments) visitClassNameValue(arg, context, seen);
      return;
    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (
          (prop.type === 'Property' || prop.type === 'ObjectProperty') &&
          prop.key
        ) {
          if (
            (prop.key.type === 'Literal' || prop.key.type === 'StringLiteral') &&
            typeof prop.key.value === 'string'
          ) {
            reportViolations(prop.key, prop.key.value, context);
          }
        }
      }
      return;
    case 'SpreadElement':
      visitClassNameValue(node.argument, context, seen);
      return;
    default:
      return;
  }
}

function getJsxAttributeName(attr) {
  if (!attr || attr.type !== 'JSXAttribute' || !attr.name) return null;
  if (attr.name.type === 'JSXIdentifier') return attr.name.name;
  if (attr.name.type === 'JSXNamespacedName') return attr.name.name && attr.name.name.name;
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw white / gray / slate / zinc / neutral / stone Tailwind classes inside JSX className strings; require theme tokens (`bg-surface`, `text-text-secondary`, `border-border`, …) defined in `client-app/src/styles/_theme.css` so dark mode keeps working.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowedFiles: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
      },
    ],
    messages: {
      rawColor:
        'Raw color class `{{token}}` bypasses the QVO design tokens and breaks dark mode. Use a theme token from `client-app/src/styles/_theme.css` (e.g. `bg-surface`, `bg-surface-secondary`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `border-border`, `border-border-strong`). For intentional dark-hero overlays, add an alpha modifier like `bg-white/10` or pair the class with a `dark:` variant.',
    },
  },
  create(context) {
    const opts = (context.options && context.options[0]) || {};
    const allowedFiles = Array.isArray(opts.allowedFiles) ? opts.allowedFiles : [];
    const filename = (context.getFilename && context.getFilename()) || (context.filename || '');
    const normalizedFilename = filename.replace(/\\/g, '/');
    const isAllowedFile = allowedFiles.some((needle) => normalizedFilename.includes(needle));
    if (isAllowedFile) {
      return {};
    }
    return {
      JSXAttribute(node) {
        const name = getJsxAttributeName(node);
        if (name !== 'className' && name !== 'class') return;
        if (!node.value) return;
        const seen = new WeakSet();
        visitClassNameValue(node.value, context, seen);
      },
    };
  },
};
