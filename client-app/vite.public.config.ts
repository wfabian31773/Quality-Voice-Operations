import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite's built-in HTML transform rewrites every absolute `href` it considers an
 * asset URL by prepending `base`. That's correct for `<script>` and stylesheet
 * `<link>`s, but it also catches our static hreflang `<link rel="alternate">`
 * fallbacks — turning `<link hreflang="en" href="/">` into `<link href="/public/">`
 * for the marketing build, which is wrong: those tags point at external locale
 * variants of the marketing site, not at hashed assets under `/public/`.
 *
 * This tiny plugin restores the original `href` on any `<link>` tagged with
 * `data-seo-hreflang-static`, which is the marker our `SEO` component uses to
 * identify these crawler-only fallbacks.
 */
function preserveStaticHreflang(): Plugin {
  return {
    name: 'preserve-static-hreflang',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"\s+data-seo-hreflang-static="true"\s*\/?>/g,
        (_match, hreflang: string, _href: string) => {
          const original = hreflang === 'en' || hreflang === 'x-default' ? '/' : `/${hreflang}`;
          return `<link rel="alternate" hreflang="${hreflang}" href="${original}" data-seo-hreflang-static="true" />`;
        },
      );
    },
  };
}

/**
 * Marketing-only build.
 *
 * The eager preload graph for the public marketing surface is dominated by the
 * React runtime (`react` + `react-dom`, ≈60 KiB gzip). Marketing pages don't
 * need any React-19-only feature, so this build aliases `react` and `react-dom`
 * to `preact/compat` (a React-API-compatible runtime that ships in roughly
 * 5 KiB gzip). The in-app surfaces continue to use full React via
 * `vite.config.ts`.
 *
 * Outputs are emitted under `dist/public/` so the production server (see
 * `server/admin-api/spaFallback.ts`) can route marketing URLs to this bundle
 * and everything else to the React-based bundle.
 */
export default defineConfig({
  root: __dirname,
  // The production server (see `server/admin-api/spaFallback.ts`) mounts the
  // marketing build's `dist/public/` directory at the `/public` URL prefix to
  // keep its hashed asset URLs from colliding with the in-app bundle's
  // `dist/assets/`. Setting `base` here makes Vite emit `/public/assets/...`
  // URLs in the generated `index.public.html` so they resolve under that mount.
  base: '/public/',
  // Use Preact's JSX runtime; the alias block below routes all React imports
  // through preact/compat so source files can keep importing from `react` /
  // `react-dom` unchanged.
  plugins: [
    react({ jsxRuntime: 'automatic', jsxImportSource: 'preact' }),
    tailwindcss(),
    preserveStaticHreflang(),
  ],
  resolve: {
    alias: [
      // Order matters — the more specific entries must come before the bare
      // `react` / `react-dom` aliases so they win during resolution.
      { find: 'react/jsx-runtime', replacement: 'preact/jsx-runtime' },
      { find: 'react/jsx-dev-runtime', replacement: 'preact/jsx-runtime' },
      { find: 'react-dom/test-utils', replacement: 'preact/test-utils' },
      { find: 'react-dom/client', replacement: 'preact/compat/client' },
      { find: 'react-dom', replacement: 'preact/compat' },
      { find: 'react', replacement: 'preact/compat' },
    ],
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: 'index.public.html',
      output: {
        manualChunks(id) {
          if (id.startsWith('\0') || id.includes('/vite/dist/client/')) {
            return 'preact-vendor';
          }
          if (!id.includes('node_modules')) return undefined;

          if (
            id.includes('/react-router/') ||
            id.includes('/react-router-dom/') ||
            id.includes('/@remix-run/router/')
          ) {
            return 'router-vendor';
          }
          if (
            id.includes('/i18next/') ||
            id.includes('/react-i18next/') ||
            id.includes('/i18next-browser-languagedetector/')
          ) {
            return 'i18n-vendor';
          }
          if (
            /\/node_modules\/preact\//.test(id) ||
            /\/node_modules\/react\//.test(id) ||
            /\/node_modules\/react-dom\//.test(id) ||
            /\/node_modules\/react-is\//.test(id) ||
            /\/node_modules\/scheduler\//.test(id)
          ) {
            return 'preact-vendor';
          }

          return undefined;
        },
      },
    },
  },
});
