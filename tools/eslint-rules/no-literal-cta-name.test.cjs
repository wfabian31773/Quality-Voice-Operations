/**
 * Run with: node tools/eslint-rules/no-literal-cta-name.test.cjs
 *
 * Uses ESLint's RuleTester to ensure the custom rule fires whenever
 * `trackCTAClick` is called with a string literal and stays silent on
 * imported CTA constants and dynamic per-card expressions.
 */
'use strict';

const { RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const rule = require('./no-literal-cta-name');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run('no-literal-cta-name', rule, {
  valid: [
    // Canonical pattern: imported constant.
    "trackCTAClick(CTA.TRY_LIVE_DEMO, '/', 'hero');",
    "trackCTAClick(CTA.START_FREE_TRIAL, '/');",
    // Dynamic per-card label (Product.tsx "go-deeper" cards).
    "trackCTAClick(card.title, '/product', 'go-deeper');",
    // Demo.tsx wrapper threading a variable through.
    "trackCTAClick(ctaType, 'demo', agentType);",
    // Conditional / computed expressions are always fine.
    "trackCTAClick(isHero ? CTA.A : CTA.B, '/', 'hero');",
    // Template literal WITH substitutions is dynamic — allowed.
    "trackCTAClick(`industry-${slug}`, '/foo');",
    // Optional chaining or member access through a namespace.
    "trackCTAClick(analytics.cta, '/foo');",
    // Unrelated function with the same first-arg shape — we only target
    // `trackCTAClick`, never its siblings.
    "track('signup_submit', 'signup', plan);",
    "trackConversionEvent('cta_click', '/foo', { cta: 'signup' });",
    // The function definition itself binds an Identifier param; the rule
    // must not trip on the declaration site.
    'export function trackCTAClick(ctaText, page, position) { return ctaText; }',
    // Page / position arguments are intentionally still allowed to be
    // string literals — only the first arg is constrained.
    "trackCTAClick(CTA.BOOK_DEMO, 'pricing_bottom');",
  ],
  invalid: [
    {
      code: "trackCTAClick('signup_submit', 'signup', plan);",
      errors: [{ messageId: 'noLiteralCta' }],
    },
    {
      code: "trackCTAClick('plan_selected', 'signup', p.key);",
      errors: [{ messageId: 'noLiteralCta' }],
    },
    {
      code: "trackCTAClick(\"try_live_demo\", '/', 'hero');",
      errors: [{ messageId: 'noLiteralCta' }],
    },
    // No-substitution template literal is identical to a string literal.
    {
      code: 'trackCTAClick(`book_demo`, "/foo");',
      errors: [{ messageId: 'noLiteralCta' }],
    },
    // Member-style call (foo.trackCTAClick) must also be guarded so the
    // rule isn't trivially bypassed by re-exporting through a namespace.
    {
      code: "api.trackCTAClick('contact_sales', '/foo');",
      errors: [{ messageId: 'noLiteralCta' }],
    },
    // Inside JSX onClick — the actual shape used across marketing pages.
    {
      code: "const x = <button onClick={() => trackCTAClick('see_features', '/integrations', 'hero')} />;",
      errors: [{ messageId: 'noLiteralCta' }],
    },
  ],
});

console.log('no-literal-cta-name: all tests passed');
