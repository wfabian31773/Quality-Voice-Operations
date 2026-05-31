import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const rootReact = fileURLToPath(new URL('./node_modules/react', import.meta.url));
const rootReactDom = fileURLToPath(new URL('./node_modules/react-dom', import.meta.url));
const rootReactJsxRuntime = fileURLToPath(
  new URL('./node_modules/react/jsx-runtime.js', import.meta.url),
);
const rootReactJsxDevRuntime = fileURLToPath(
  new URL('./node_modules/react/jsx-dev-runtime.js', import.meta.url),
);

// Force every consumer (including dnd-kit pulled in transitively from
// `client-app/node_modules`) to resolve through the root copy of these
// packages, so the React identity is unique across the test process.
// See task #1144 for the keyboard-sortable test that originally exposed
// this when importing PinnedSavedViewsBar directly.
const rootDndKitCore = fileURLToPath(new URL('./node_modules/@dnd-kit/core', import.meta.url));
const rootDndKitSortable = fileURLToPath(new URL('./node_modules/@dnd-kit/sortable', import.meta.url));
const rootDndKitUtilities = fileURLToPath(new URL('./node_modules/@dnd-kit/utilities', import.meta.url));
const rootDndKitAccessibility = fileURLToPath(new URL('./node_modules/@dnd-kit/accessibility', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities', '@dnd-kit/accessibility'],
    alias: {
      'react/jsx-runtime': rootReactJsxRuntime,
      'react/jsx-dev-runtime': rootReactJsxDevRuntime,
      'react-dom/client': fileURLToPath(
        new URL('./node_modules/react-dom/client.js', import.meta.url),
      ),
      'react-dom': rootReactDom,
      react: rootReact,
      '@dnd-kit/core': rootDndKitCore,
      '@dnd-kit/sortable': rootDndKitSortable,
      '@dnd-kit/utilities': rootDndKitUtilities,
      '@dnd-kit/accessibility': rootDndKitAccessibility,
    },
  },
  esbuild: {
    jsx: 'automatic',
    // Avoid esbuild trying to resolve mobile/tsconfig.json which extends
    // `expo/tsconfig.base` (only present inside the Expo install).
    tsconfigRaw: '{}',
  },
  test: {
    // The default `vitest run` is the unit + integration suite. Two families
    // of files live in the tree but are NOT vitest tests and must be excluded,
    // or they get swept in and fail spuriously:
    //   - tests/e2e/**          Playwright/tsx specs that need a live server;
    //                           run individually via the `test:e2e:*` scripts.
    //   - tools/eslint-rules/** ESLint `RuleTester` scripts run with plain
    //                           `node` via the `lint:rules` script.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**',
      'tools/eslint-rules/**',
    ],
    coverage: {
      provider: 'v8',
      // `text-summary` prints the headline table to the console; the rest are
      // machine/browsable artifacts written under ./coverage (gitignored).
      reporter: ['text-summary', 'text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Vitest skips coverage report generation when any test fails (default
      // false). We still want the numbers for the green portion of the suite,
      // so always emit the report.
      reportOnFailure: true,
      // NOTE: `all: true` is intentionally OFF. On this monorepo the v8
      // provider's report generation hangs when asked to instrument every
      // uncovered file (hundreds of modules), so the default run only reports
      // files an executing test actually imported. The complementary list of
      // files with ZERO coverage is produced separately by
      // `scripts/coverage-gaps.mjs`, which diffs the source glob against the
      // report — same visibility, without the hang.
      all: false,
      // Scope to the backend / business-logic packages exercised by this
      // (node-environment) suite. The React frontend under `client-app/src`
      // has its own vitest project with the jsdom setup; measure it via
      // `npm --prefix client-app run test -- --coverage`.
      include: [
        'platform/**/*.{ts,tsx}',
        'server/**/*.{ts,tsx}',
        'shared/**/*.{ts,tsx}',
        'scripts/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.d.ts',
        '**/types.ts',
        '**/__mocks__/**',
        '**/__fixtures__/**',
        'tests/**',
      ],
    },
  },
});
