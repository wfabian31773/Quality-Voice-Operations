/**
 * BL-004 production-mode SPA fallback smoke test.
 *
 * Today (Express 5), the old `app.get('*', …)` registration crashes the
 * admin API with a `path-to-regexp` exception the moment anything hits the
 * SPA fallback in production mode. This test locks in two guarantees:
 *
 *   1. Registering the SPA fallback under `APP_ENV=production` does NOT
 *      throw (regression guard for the path-to-regexp crash).
 *   2. A request to a client-side route (`/dashboard`) is served the
 *      bundled `client-app/dist/index.html`, while the API surface area
 *      mounted before the fallback is still reachable.
 *
 * We exercise this against a tiny Express app that wires `attachSpaFallback`
 * the same way `server/admin-api/app.ts` does, so we get a fast, hermetic
 * smoke test without spawning the full admin API (which transitively
 * imports dozens of schedulers / DB-bound services).
 */
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

describe('BL-004 SPA fallback (production-mode boot smoke test)', () => {
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

  it('treats APP_ENV=production as a production boot', () => {
    expect(isProductionBoot({ APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionBoot({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionBoot({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionBoot({ APP_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('attachSpaFallback no-ops (returns false) when the dist directory is missing', () => {
    const app = express();
    const missingPath = path.join(os.tmpdir(), `qvo-missing-dist-${Date.now()}`);
    expect(fs.existsSync(missingPath)).toBe(false);

    expect(() => attachSpaFallback(app, missingPath)).not.toThrow();
    expect(attachSpaFallback(app, missingPath)).toBe(false);
  });

  it('registers the Express-5 wildcard pattern without throwing path-to-regexp', () => {
    // Build a temp dist with a known marker so we can assert the served body.
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      fs.writeFileSync(
        path.join(tmpDist, 'index.html'),
        '<!doctype html><html><head><title>QVO SPA</title></head><body><div id="root"></div></body></html>',
      );

      const app = express();
      // Mount a fake API surface area before the fallback so we can assert
      // earlier handlers still win — the fallback must not shadow them.
      app.get('/api/health', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      // The regression: in Express 5, `app.get('*', …)` throws a
      // `path-to-regexp` `TypeError: Missing parameter name` synchronously
      // at registration time. attachSpaFallback uses `/*splat`, so this
      // call must not throw.
      expect(() => attachSpaFallback(app, tmpDist)).not.toThrow();
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it('production boot serves index.html for SPA routes (e.g. /dashboard) and leaves the API alone', async () => {
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      const indexHtml =
        '<!doctype html><html><head><title>QVO SPA</title></head>' +
        '<body><div id="root"></div></body></html>';
      fs.writeFileSync(path.join(tmpDist, 'index.html'), indexHtml);

      const app = express();
      app.get('/api/health', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      const attached = attachSpaFallback(app, tmpDist);
      expect(attached).toBe(true);

      // SPA route → bundled index.html
      const dashboard = await request(app).get('/dashboard');
      expect(dashboard.status).toBe(200);
      expect(dashboard.text).toBe(indexHtml);
      expect(dashboard.headers['content-type']).toMatch(/text\/html/);

      // Deeper SPA route (covered by `/*splat`) → bundled index.html
      const nestedRoute = await request(app).get('/admin/sales-inbox/edit/123');
      expect(nestedRoute.status).toBe(200);
      expect(nestedRoute.text).toBe(indexHtml);

      // Real API endpoint mounted earlier still wins over the fallback.
      const health = await request(app).get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ ok: true });
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it('serves static assets from the dist directory before falling back to index.html', async () => {
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'qvo-spa-fallback-'));
    try {
      fs.writeFileSync(path.join(tmpDist, 'index.html'), '<html>spa</html>');
      fs.mkdirSync(path.join(tmpDist, 'assets'));
      fs.writeFileSync(
        path.join(tmpDist, 'assets', 'app.js'),
        'console.log("qvo-static-marker");',
      );

      const app = express();
      attachSpaFallback(app, tmpDist);

      const asset = await request(app).get('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toContain('qvo-static-marker');

      const fallback = await request(app).get('/some/spa/route');
      expect(fallback.status).toBe(200);
      expect(fallback.text).toBe('<html>spa</html>');
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it('regression: the old `*` pattern would still throw under Express 5', () => {
    // Document the actual bug we fixed: registering the legacy wildcard on
    // an Express 5 app throws synchronously. This guards against someone
    // accidentally reverting attachSpaFallback to `app.get('*', …)`.
    const app = express();
    expect(() => {
      app.get('*' as unknown as string, (_req, res) => {
        res.send('nope');
      });
    }).toThrow();
  });
});
