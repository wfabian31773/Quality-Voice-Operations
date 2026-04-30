// Flat ESLint config (ESLint v9+).
//
// Scope: this configuration enables a small set of custom rules —
// `local/no-cents-divided-by-100`, `local/no-dollars-times-100`,
// `local/no-literal-cta-name`, and `local/no-literal-analytics-label`.
// The two off-by-100x money rules run across `client-app/src/**`,
// `platform/**`, `mobile/**`, `widget/**`, `server/**`, and
// `shared/**` so the same off-by-100x guard protects every part of
// the workspace that handles money. The two marketing-analytics
// literal rules stay scoped to `client-app/src/**` and `platform/**`
// (mobile/widget don't render marketing CTAs or feature funnels).
// The goal is to fail CI when contributors reintroduce inline
// off-by-100x money math after the BL-023 `formatCurrency` /
// `dollarsToCents` cleanup, or when new marketing analytics labels
// drift back to one-off string literals (Task #426 /
// `client-app/src/lib/analyticsCtas.ts` and Task #1082 /
// `client-app/src/lib/analyticsLabels.ts`).
//
// To run locally:
//     npm run lint
//
// To add a justified exception:
//     // eslint-disable-next-line local/no-cents-divided-by-100 -- <reason>
//     // eslint-disable-next-line local/no-dollars-times-100 -- <reason>
//     // eslint-disable-next-line local/no-literal-cta-name -- <reason>
//     // eslint-disable-next-line local/no-literal-analytics-label -- <reason>

import { createRequire } from 'node:module';
import tsParser from '@typescript-eslint/parser';

const require = createRequire(import.meta.url);
const noCentsDividedBy100 = require('./tools/eslint-rules/no-cents-divided-by-100.js');
const noDollarsTimes100 = require('./tools/eslint-rules/no-dollars-times-100.js');
const noLiteralCtaName = require('./tools/eslint-rules/no-literal-cta-name.js');
const noLiteralAnalyticsLabel = require('./tools/eslint-rules/no-literal-analytics-label.js');

const localPlugin = {
  rules: {
    'no-cents-divided-by-100': noCentsDividedBy100,
    'no-dollars-times-100': noDollarsTimes100,
    'no-literal-cta-name': noLiteralCtaName,
    'no-literal-analytics-label': noLiteralAnalyticsLabel,
  },
};

// Stub plugins so pre-existing `eslint-disable-next-line <plugin>/<rule>`
// comments in the codebase (left over from earlier tooling that never
// shipped) do not produce "Definition for rule 'X' was not found"
// errors. We deliberately do NOT enable any of these rules — this config
// is scoped to the cents-bug guard only. Adding a real lint pass for
// react-hooks / @typescript-eslint is out of scope.
const noopRule = {
  meta: { type: 'problem', schema: [], messages: {} },
  create() {
    return {};
  },
};
const reactHooksStub = { rules: { 'exhaustive-deps': noopRule, 'rules-of-hooks': noopRule } };
const tsEslintStub = { rules: { 'no-namespace': noopRule, 'no-explicit-any': noopRule, 'no-unused-vars': noopRule, 'no-require-imports': noopRule } };

export default [
  {
    // Lint surface: app source + platform modules. We don't lint build
    // output, dependencies, tests, scripts, or migrations — those don't
    // ship to users and aren't where the off-by-100x bug recurs.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.cache/**',
      '**/coverage/**',
      'client-app/dist/**',
      'mobile/.expo/**',
      'tests/**',
      'scripts/**',
      'migrations/**',
      'attached_assets/**',
      'artifacts/**',
      // The canonical formatter helpers are the *only* place the
      // `cents / 100` and `dollars * 100` math is allowed to live.
      // `shared/billing/stripeUnitAmount.ts` is the Stripe-specific
      // sibling that preserves sub-cent precision on
      // `unit_amount_decimal`; same exemption rationale.
      'client-app/src/lib/formatCurrency.ts',
      'platform/core/formatCurrency.ts',
      'shared/billing/formatCurrency.ts',
      'shared/billing/stripeUnitAmount.ts',
    ],
  },
  {
    // Off-by-100x money guard — full workspace surface. Every directory
    // that handles money (or could reasonably grow money math) goes
    // here so the rules can't be reintroduced anywhere we ship code.
    // `widget/embed.js` is plain ES5 JS so we include `.js` here too.
    files: [
      'client-app/src/**/*.{ts,tsx}',
      'platform/**/*.{ts,tsx}',
      'mobile/**/*.{ts,tsx}',
      'widget/**/*.{js,ts,tsx}',
      'server/**/*.{ts,tsx}',
      'shared/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // Pre-existing `eslint-disable` comments target rules that aren't
      // loaded here; treating them as unused would be misleading.
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      local: localPlugin,
      'react-hooks': reactHooksStub,
      '@typescript-eslint': tsEslintStub,
    },
    rules: {
      'local/no-cents-divided-by-100': 'error',
      'local/no-dollars-times-100': 'error',
    },
  },
  {
    // CTA literal guard — narrower scope. Only the web app and platform
    // modules render marketing CTAs; mobile/widget/server/shared have
    // no analyticsCtas equivalent.
    files: ['client-app/src/**/*.{ts,tsx}', 'platform/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      local: localPlugin,
      'react-hooks': reactHooksStub,
      '@typescript-eslint': tsEslintStub,
    },
    rules: {
      'local/no-literal-cta-name': 'error',
      'local/no-literal-analytics-label': 'error',
    },
  },
];
