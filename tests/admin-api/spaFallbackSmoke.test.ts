import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import {
  attachSpaFallback,
  isProductionBoot,
} from '../../server/admin-api/spaFallback';

describe('spaFallback', () => {
  const previousAppEnv = process.env.APP_ENV;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.APP_ENV = 'production';
  });

  afterAll(() => {
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('detects production boot from APP_ENV or NODE_ENV', () => {
    expect(isProductionBoot({ APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionBoot({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionBoot({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionBoot({ APP_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('returns false when the dist directory is missing', () => {
    const app = express();
    const missingPath = path.join(os.tmpdir(), `qvo-missing-dist-${Date.now()}`);
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(attachSpaFallback(app, missingPath)).toBe(false);
  });

  it('registers the Express 5 wildcard pattern without throwing', () => {
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      fs.writeFileSync(path.join(tmpDist, 'index.html'), '<html>spa</html>');
      const app = express();
      expect(() => attachSpaFallback(app, tmpDist)).not.toThrow();
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it('serves index.html for SPA routes and preserves earlier API routes', async () => {
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      const indexHtml = '<html><body>spa</body></html>';
      fs.writeFileSync(path.join(tmpDist, 'index.html'), indexHtml);

      const app = express();
      app.get('/api/health', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      expect(attachSpaFallback(app, tmpDist)).toBe(true);

      const dashboard = await request(app).get('/dashboard');
      expect(dashboard.status).toBe(200);
      expect(dashboard.text).toBe(indexHtml);
      expect(dashboard.headers['content-type']).toMatch(/text\/html/);

      const nested = await request(app).get('/admin/sales-inbox/edit/123');
      expect(nested.status).toBe(200);
      expect(nested.text).toBe(indexHtml);

      const health = await request(app).get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ ok: true });
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it('serves static assets from the dist directory before the fallback', async () => {
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      fs.writeFileSync(path.join(tmpDist, 'index.html'), '<html>spa</html>');
      fs.mkdirSync(path.join(tmpDist, 'assets'));
      fs.writeFileSync(path.join(tmpDist, 'assets', 'app.js'), 'console.log("ok");');

      const app = express();
      attachSpaFallback(app, tmpDist);

      const asset = await request(app).get('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toContain('console.log');

      const fallback = await request(app).get('/some/spa/route');
      expect(fallback.status).toBe(200);
      expect(fallback.text).toBe('<html>spa</html>');
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  describe('two-bundle marketing routing', () => {
    function makeDist(): string {
      const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
      fs.writeFileSync(path.join(tmpDist, 'index.html'), '<html>IN-APP</html>');
      fs.mkdirSync(path.join(tmpDist, 'assets'));
      fs.writeFileSync(path.join(tmpDist, 'assets', 'app.js'), 'console.log("in-app");');

      const publicDir = path.join(tmpDist, 'public');
      fs.mkdirSync(publicDir);
      fs.writeFileSync(path.join(publicDir, 'index.public.html'), '<html>MARKETING</html>');
      fs.mkdirSync(path.join(publicDir, 'assets'));
      fs.writeFileSync(
        path.join(publicDir, 'assets', 'preact-vendor.js'),
        'console.log("preact");',
      );
      return tmpDist;
    }

    it('serves the marketing bundle for marketing URLs and the in-app bundle elsewhere', async () => {
      const tmpDist = makeDist();
      try {
        const app = express();
        attachSpaFallback(app, tmpDist);

        const marketing = ['/', '/pricing', '/blog/some-post', '/docs/intro', '/case-studies', '/es/pricing'];
        for (const url of marketing) {
          const r = await request(app).get(url).set('Accept', 'text/html');
          expect(r.status).toBe(200);
          expect(r.text).toBe('<html>MARKETING</html>');
        }

        const inApp = ['/dashboard', '/admin/users', '/auth/login', '/onboarding', '/agent-builder', '/settings/account'];
        for (const url of inApp) {
          const r = await request(app).get(url).set('Accept', 'text/html');
          expect(r.status).toBe(200);
          expect(r.text).toBe('<html>IN-APP</html>');
        }
      } finally {
        fs.rmSync(tmpDist, { recursive: true, force: true });
      }
    });

    it('serves marketing assets at /public/assets/* and in-app assets at /assets/*', async () => {
      const tmpDist = makeDist();
      try {
        const app = express();
        attachSpaFallback(app, tmpDist);

        const inApp = await request(app).get('/assets/app.js');
        expect(inApp.status).toBe(200);
        expect(inApp.text).toContain('in-app');

        const marketing = await request(app).get('/public/assets/preact-vendor.js');
        expect(marketing.status).toBe(200);
        expect(marketing.text).toContain('preact');
      } finally {
        fs.rmSync(tmpDist, { recursive: true, force: true });
      }
    });

    it('falls back to the in-app bundle when the marketing build is absent', async () => {
      const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
      try {
        fs.writeFileSync(path.join(tmpDist, 'index.html'), '<html>IN-APP</html>');
        const app = express();
        attachSpaFallback(app, tmpDist);

        const r = await request(app).get('/pricing').set('Accept', 'text/html');
        expect(r.status).toBe(200);
        expect(r.text).toBe('<html>IN-APP</html>');
      } finally {
        fs.rmSync(tmpDist, { recursive: true, force: true });
      }
    });
  });
});
