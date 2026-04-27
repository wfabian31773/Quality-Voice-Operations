// Flat ESLint config (ESLint v9+).
//
// Scope: this configuration intentionally only enables one custom rule —
// `local/no-cents-divided-by-100` — across `client-app/src/**` and
// `platform/**`. We are not (yet) trying to lint the rest of the codebase;
// the goal is to fail CI when contributors reintroduce inline
// cents-to-dollar conversions like `priceCents / 100` after the BL-023
// `formatCurrency` cleanup.
//
// To run locally:
//     npm run lint
//
// To add a justified exception:
//     // eslint-disable-next-line local/no-cents-divided-by-100 -- <reason>

import { createRequire } from 'node:module';
import tsParser from '@typescript-eslint/parser';

const require = createRequire(import.meta.url);
const noCentsDividedBy100 = require('./tools/eslint-rules/no-cents-divided-by-100.js');

const localPlugin = {
  rules: {
    'no-cents-divided-by-100': noCentsDividedBy100,
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
const tsEslintStub = { rules: { 'no-namespace': noopRule, 'no-explicit-any': noopRule, 'no-unused-vars': noopRule } };

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
      'mobile/**',
      'tests/**',
      'scripts/**',
      'migrations/**',
      'attached_assets/**',
      'artifacts/**',
      // The canonical formatter helpers are the *only* place the
      // `cents / 100` math is allowed to live.
      'client-app/src/lib/formatCurrency.ts',
      'platform/core/formatCurrency.ts',
    ],
  },
  {
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
    },
  },
];
