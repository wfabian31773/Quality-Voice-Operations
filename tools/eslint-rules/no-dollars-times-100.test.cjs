/**
 * Run with: node tools/eslint-rules/no-dollars-times-100.test.cjs
 *
 * Uses ESLint's RuleTester to ensure the custom rule fires on the
 * inverse off-by-100x patterns and stays silent on benign code (e.g.
 * percentage math that just happens to multiply by 100).
 */
'use strict';

const { RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const rule = require('./no-dollars-times-100');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

ruleTester.run('no-dollars-times-100', rule, {
  valid: [
    // Plain percentage math — no monetary identifier, no Cents target.
    'const pct = Math.round(rate * 100);',
    'const pct = (count / total) * 100;',
    'const random = Math.random() * 100;',
    'const v = (currentRate * 100).toFixed(1);',
    // Function arg that isn't a setter for a *Cents key.
    'score -= Math.min(20, Math.round(ratio * 100));',
    // Right side isn't literal 100.
    'const v = priceDollars * factor;',
    // Operator isn't multiplication.
    'const v = priceDollars + 100;',
    // Identifier name is monetary-ish but no `* 100` involved.
    'const v = priceDollars / 2;',
    // Both literals — nonsense, ignored.
    'const v = 100 * 100;',
  ],
  invalid: [
    // Heuristic A — identifier name on the non-literal side is monetary.
    {
      code: 'const cents = priceDollars * 100;',
      errors: [{ messageId: 'noInlineDollars' }],
    },
    {
      code: 'const cents = 100 * priceDollars;',
      errors: [{ messageId: 'noInlineDollars' }],
    },
    {
      code: 'const cents = form.usdAmount * 100;',
      errors: [{ messageId: 'noInlineDollars' }],
    },
    {
      code: 'const cents = order?.priceDollars * 100;',
      errors: [{ messageId: 'noInlineDollars' }],
    },
    {
      code: 'const cents = (form.priceDollars as number) * 100;',
      errors: [{ messageId: 'noInlineDollars' }],
    },
    // Heuristic B — enclosing target name contains Cents.
    {
      code: 'const obj = { priceCents: Math.round(parseFloat(value) * 100) };',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
    {
      code: 'updateField("priceCents", Math.round(parseFloat(value) * 100));',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
    {
      code: 'this.priceCents = Math.round((form.amount ?? 0) * 100);',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
    {
      code: 'const maxCostPerConversationCents = Math.round(parseFloat(input) * 100);',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
    // Conditional / ternary on the value side still surfaces the *Cents target.
    {
      code: 'const obj = { priceCents: enabled ? Math.round(amount * 100) : 0 };',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
    // Larger arithmetic chain, *Cents target.
    {
      code: 'const obj = { estimatedRevenueImpactCents: Math.round(missed * 0.5 * 1000 * 100) };',
      errors: [{ messageId: 'noInlineDollarsToCents' }],
    },
  ],
});

console.log('no-dollars-times-100: all tests passed');
