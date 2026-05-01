/**
 * Run with: node tools/eslint-rules/no-raw-marketing-colors.test.cjs
 *
 * Uses ESLint's RuleTester to ensure the custom rule fires on raw
 * white/gray/slate utilities inside JSX className strings, but stays
 * silent on alpha overlays, paired light/dark variants, solid
 * `text-white`, helper-call composition (cn / clsx / classnames),
 * and the `allowedFiles` escape hatch.
 */
'use strict';

const { RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const rule = require('./no-raw-marketing-colors');

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

ruleTester.run('no-raw-marketing-colors', rule, {
  valid: [
    // ---- Theme tokens are the canonical good case. ----
    {
      code: 'const x = <div className="bg-surface text-text-primary border-border" />;',
    },
    {
      code: 'const x = <span className="text-text-secondary" />;',
    },
    // ---- Alpha modifiers are intentional overlays / glass tints. ----
    {
      code: 'const x = <div className="bg-white/10 border-white/15 text-white/70" />;',
    },
    {
      code: 'const x = <div className="from-white/[0.08] to-white/[0.02] border-white/15" />;',
    },
    {
      code: 'const x = <div className="from-slate-500/25 to-blue-500/10 ring-slate-400/30" />;',
    },
    // ---- Solid `text-white` / `ring-white` / `border-white` are
    //      whitelisted because they're routinely used on dark surfaces. ----
    {
      code: 'const x = <button className="text-white ring-white border-white" />;',
    },
    // ---- Paired `dark:` variants signal explicit dark-mode handling. ----
    {
      code: 'const x = <div className="bg-white dark:bg-gray-800" />;',
    },
    {
      code: 'const x = <p className="text-gray-600 dark:text-gray-300" />;',
    },
    {
      code: 'const x = <div className="bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700" />;',
    },
    // ---- `dark:` variants are never flagged on their own (they're the
    //      paired side, the rule only flags the missing-token light side). ----
    {
      code: 'const x = <div className="bg-surface dark:bg-gray-900" />;',
    },
    // ---- Conditional / helper composition — values still resolve correctly. ----
    {
      code:
        "import cn from 'clsx';\n" +
        "const x = <div className={cn('bg-surface', isDark && 'text-white')} />;",
    },
    {
      code:
        "import cn from 'clsx';\n" +
        "const x = <div className={cn({ 'bg-surface': true, 'text-text-primary': isLight })} />;",
    },
    // ---- Other Tailwind colors (blue/red/green/etc.) are out of scope. ----
    {
      code: 'const x = <div className="bg-blue-500 text-red-700 border-green-200" />;',
    },
    // ---- Non-color utilities that share a prefix shouldn't false-positive. ----
    {
      code: 'const x = <div className="bg-gradient-to-r border-2 ring-1 text-base shadow-lg" />;',
    },
    // ---- `class` attribute (Preact / vanilla JSX) is also handled, but
    //      tokens still work. ----
    {
      code: 'const x = <div class="bg-surface" />;',
    },
    // ---- Strings outside JSX className aren't checked (e.g. JS object
    //      literals that hold raw strings — separately tracked, intentional). ----
    {
      code: "const palette = { hero: 'bg-slate-700', card: 'bg-white' };",
    },
    // ---- File allowlist escape hatch. ----
    {
      code: 'const x = <div className="bg-white from-white border-gray-200" />;',
      filename: '/repo/client-app/src/components/LiveTranscriptMock.tsx',
      options: [{ allowedFiles: ['client-app/src/components/LiveTranscriptMock.tsx'] }],
    },
  ],
  invalid: [
    // ---- The motivating cases listed in the task description. ----
    {
      code: 'const x = <div className="bg-white" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'bg-white' } }],
    },
    {
      code: 'const x = <div className="from-white" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'from-white' } }],
    },
    {
      code: 'const x = <p className="text-slate-600" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'text-slate-600' } }],
    },
    {
      code: 'const x = <div className="border-gray-200" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'border-gray-200' } }],
    },
    // ---- Other raw palettes (zinc / neutral / stone) are also flagged. ----
    {
      code: 'const x = <div className="bg-zinc-100 text-neutral-500 border-stone-300" />;',
      errors: [
        { messageId: 'rawColor', data: { token: 'bg-zinc-100' } },
        { messageId: 'rawColor', data: { token: 'text-neutral-500' } },
        { messageId: 'rawColor', data: { token: 'border-stone-300' } },
      ],
    },
    // ---- Multiple violations in one className. ----
    {
      code: 'const x = <div className="bg-gray-50 text-slate-600 border-gray-200" />;',
      errors: [
        { messageId: 'rawColor', data: { token: 'bg-gray-50' } },
        { messageId: 'rawColor', data: { token: 'text-slate-600' } },
        { messageId: 'rawColor', data: { token: 'border-gray-200' } },
      ],
    },
    // ---- Pairing must match the SAME utility prefix; a `dark:text-*`
    //      doesn't excuse a raw `bg-white`. ----
    {
      code: 'const x = <div className="bg-white dark:text-white" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'bg-white' } }],
    },
    // ---- Inside a `cn(...)` helper. ----
    {
      code:
        "import cn from 'clsx';\n" +
        "const x = <div className={cn('bg-white', open && 'text-slate-600')} />;",
      errors: [
        { messageId: 'rawColor', data: { token: 'bg-white' } },
        { messageId: 'rawColor', data: { token: 'text-slate-600' } },
      ],
    },
    // ---- Object key inside `cn({ ... })`. ----
    {
      code:
        "import cn from 'clsx';\n" +
        "const x = <div className={cn({ 'border-gray-200': true })} />;",
      errors: [{ messageId: 'rawColor', data: { token: 'border-gray-200' } }],
    },
    // ---- Template literal with a substitution. ----
    {
      code:
        'const v = "hover:bg-gray-50";\n' +
        'const x = <div className={`bg-white ${v}`} />;',
      errors: [{ messageId: 'rawColor', data: { token: 'bg-white' } }],
    },
    // ---- Conditional expression. ----
    {
      code:
        'const x = <div className={isDark ? "bg-surface" : "bg-white"} />;',
      errors: [{ messageId: 'rawColor', data: { token: 'bg-white' } }],
    },
    // ---- Hover variant on a raw color is still raw. ----
    {
      code: 'const x = <button className="hover:bg-gray-100" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'hover:bg-gray-100' } }],
    },
    // ---- Solid `bg-white` should still be flagged even when other
    //      classes in the string include a totally unrelated `dark:text-X`. ----
    {
      code: 'const x = <div className="bg-white text-text-primary dark:text-text-secondary" />;',
      errors: [{ messageId: 'rawColor', data: { token: 'bg-white' } }],
    },
  ],
});

console.log('no-raw-marketing-colors: all tests passed');
