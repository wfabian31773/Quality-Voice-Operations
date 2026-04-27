/**
 * Run with: node tools/eslint-rules/no-cents-divided-by-100.test.cjs
 *
 * Uses ESLint's RuleTester to ensure the custom rule fires on the
 * patterns we want to catch and stays silent on benign code.
 */
'use strict';

const { RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const rule = require('./no-cents-divided-by-100');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

ruleTester.run('no-cents-divided-by-100', rule, {
  valid: [
    'const seconds = ms / 1000;',
    'const x = numeric / 100;',
    'const y = amountCents * (sharePercent / 100);',
    'const z = standardTotalCost / s.avg_cost_cents;',
    'const a = totalCents / 1000;',
    // not literal 100
    'const b = priceCents / divisor;',
  ],
  invalid: [
    {
      code: 'const dollars = priceCents / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = (form.priceCents / 100).toFixed(2);',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = budget.maxCostPerConversationCents / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = totalAmountInCents / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    // Common TypeScript wrapper bypass attempts must still trip the rule.
    {
      code: 'const v = (priceCents as number) / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = priceCents! / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = order?.priceCents / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
    {
      code: 'const v = (order?.priceCents as number) / 100;',
      errors: [{ messageId: 'noInlineCents' }],
    },
  ],
});

console.log('no-cents-divided-by-100: all tests passed');
