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
});
