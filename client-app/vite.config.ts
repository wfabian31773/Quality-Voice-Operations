import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Rollup-generated virtuals (e.g. \0commonjsHelpers.js) are shared
          // by every vendor chunk that goes through commonjs interop. Pin
          // them to `react-vendor` so they live in the chunk that loads
          // first and other vendor chunks just import from it. Without this
          // they would land in whichever chunk happened to need them first
          // and create cross-chunk cycles (e.g. `react-vendor` ↔
          // `i18n-vendor`) that Rollup warns about and that produce fragile
          // preload ordering.
          if (id.startsWith('\0') || id.includes('/vite/dist/client/')) {
            return 'react-vendor';
          }

          if (!id.includes('node_modules')) return undefined;

          if (
            id.includes('/react-router/') ||
            id.includes('/react-router-dom/') ||
            id.includes('/@remix-run/router/')
          ) {
            return 'router-vendor';
          }
          if (id.includes('/@tanstack/')) {
            return 'query-vendor';
          }
          if (
            id.includes('/i18next/') ||
            id.includes('/react-i18next/') ||
            id.includes('/i18next-browser-languagedetector/')
          ) {
            return 'i18n-vendor';
          }
          if (
            /\/node_modules\/react\//.test(id) ||
            /\/node_modules\/react-dom\//.test(id) ||
            /\/node_modules\/react-is\//.test(id) ||
            /\/node_modules\/scheduler\//.test(id)
          ) {
            return 'react-vendor';
          }

          return undefined;
        },
      },
    },
  },
  server: {
    port: 5000,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/twilio': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const originalHost = req.headers.host || req.headers['x-forwarded-host'];
            if (originalHost) {
              proxyReq.setHeader('x-forwarded-host', originalHost);
            }
            proxyReq.setHeader('x-forwarded-proto', 'https');
          });
        },
      },
      // Mirror the production `/vg/*` proxy admin-api mounts so dev mode
      // can also serve Twilio webhooks whose TwiML now references
      // `wss://<host>/vg/twilio/stream`. Strips `/vg` and forwards to
      // voice-gateway on 3001, signaling the original prefix so the
      // signature middleware reconstructs the right URL.
      '/vg': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        rewrite: (urlPath) => urlPath.replace(/^\/vg/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const originalHost = req.headers.host || req.headers['x-forwarded-host'];
            if (originalHost) {
              proxyReq.setHeader('x-forwarded-host', originalHost);
            }
            proxyReq.setHeader('x-forwarded-proto', 'https');
            proxyReq.setHeader('x-forwarded-prefix', '/vg');
          });
        },
      },
    },
  },
});
