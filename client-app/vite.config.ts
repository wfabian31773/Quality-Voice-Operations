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
    },
  },
});
