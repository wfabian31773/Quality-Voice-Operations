/**
 * BL-004 production-mode boot smoke test (integration).
 *
 * Companion to `spaFallbackSmoke.test.ts`. The helper-level test pins
 * down `attachSpaFallback`'s Express 5 wildcard behaviour. THIS test
 * goes one level deeper and boots the actual `server/admin-api/app`
 * module under `APP_ENV=production`, then asserts the SPA fallback is
 * wired correctly end-to-end. That guards against future drift in
 * `app.ts` itself (e.g. moving the fallback after `errorHandler`,
 * forgetting to call it, or reverting the wildcard form).
 *
 * Why a separate file: this test sets `APP_ENV=production` BEFORE the
 * dynamic import of `server/admin-api/app`. Vitest gives every test
 * file its own module graph, so we can isolate the production-mode
 * boot from the rest of the suite without polluting global state.
 *
 * What we deliberately don't do: we don't mock the entire route
 * surface area. `server/admin-api/app.ts` only registers express
 * routers at module load — no DB calls, no scheduler kicks (those
 * live in `start.ts`). So the import is safe in test mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

const previousAppEnv = process.env.APP_ENV;
const previousNodeEnv = process.env.NODE_ENV;

const clientDistPath = path.resolve(__dirname, '../../client-app/dist');
const indexHtmlPath = path.join(clientDistPath, 'index.html');

let app: import('express').Express;

describe('BL-004 admin-api production-mode boot smoke test', () => {
  beforeAll(async () => {
    // app.ts checks APP_ENV / NODE_ENV at module-evaluation time, so
    // the env stubs MUST land before the dynamic import.
    process.env.APP_ENV = 'production';

    // The bundled SPA must exist for the integration assertion to be
    // meaningful. The Vite build emits `client-app/dist/index.html`
    // before tests run; if it's missing the test bails out loudly so
    // the failure mode is "build first" rather than a confusing 404.
    if (!fs.existsSync(indexHtmlPath)) {
      throw new Error(
        `Expected bundled SPA at ${indexHtmlPath}. Run \`npm --prefix client-app run build\` before \`npx vitest run\`.`,
      );
    }

    // Dynamic import so the env stub above is in effect at evaluation
    // time. The cast keeps the test free of dependency-specific
    // declaration files.
    const mod = (await import('../../server/admin-api/app')) as {
      default: import('express').Express;
    };
    app = mod.default;
  });

  // After the test finishes restore env vars so other suites in the
  // same vitest worker (if any) don't see APP_ENV=production.
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

  it('imports server/admin-api/app under APP_ENV=production without throwing', () => {
    // The whole point of BL-004: registering the SPA fallback used to
    // throw `path-to-regexp: Missing parameter name` synchronously at
    // module load. If we got this far, the import succeeded — i.e.
    // the production-mode boot no longer crashes.
    expect(app).toBeDefined();
    expect(typeof app.use).toBe('function');
  });

  it('GET /dashboard returns the bundled client-app/dist/index.html', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    const res = await request(app).get('/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(expectedHtml);
  });

  it('GET / serves the static index.html (express.static handles root)', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toBe(expectedHtml);
  });

  it('a deep SPA route also resolves through the /*splat fallback', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    const res = await request(app).get('/admin/sales-inbox/details/abc-123');

    expect(res.status).toBe(200);
    expect(res.text).toBe(expectedHtml);
  });

  it('GET /health still hits the API surface area, not the SPA fallback', async () => {
    // /health is mounted by `routes/health` BEFORE the SPA fallback
    // in app.ts. This locks in route precedence — the fallback must
    // not shadow real API endpoints. The handler hits the platform
    // DB; in dev/CI the pool resolves OK and we get HTTP 200, but
    // either way it must NOT return the SPA bundle.
    const res = await request(app).get('/health');

    expect([200, 503]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ service: 'admin-api' });
    expect(res.text).not.toContain('<!DOCTYPE html');
  });
});

