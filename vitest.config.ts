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

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react/jsx-runtime': rootReactJsxRuntime,
      'react/jsx-dev-runtime': rootReactJsxDevRuntime,
      'react-dom/client': fileURLToPath(
        new URL('./node_modules/react-dom/client.js', import.meta.url),
      ),
      'react-dom': rootReactDom,
      react: rootReact,
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
});
