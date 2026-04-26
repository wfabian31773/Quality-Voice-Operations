import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

const previousAppEnv = process.env.APP_ENV;
const previousNodeEnv = process.env.NODE_ENV;

const clientDistPath = path.resolve(__dirname, '../../client-app/dist');
const indexHtmlPath = path.join(clientDistPath, 'index.html');

let app: import('express').Express;
let createdDist = false;
let createdIndex = false;
let expectedHtml = '';

const FIXTURE_HTML =
  '<!doctype html><html><head><title>QVO SPA</title></head>' +
  '<body><div id="root"></div></body></html>';

describe('admin-api production-mode boot smoke', () => {
  beforeAll(async () => {
    if (!fs.existsSync(clientDistPath)) {
      fs.mkdirSync(clientDistPath, { recursive: true });
      createdDist = true;
    }
    if (!fs.existsSync(indexHtmlPath)) {
      fs.writeFileSync(indexHtmlPath, FIXTURE_HTML);
      createdIndex = true;
    }
    expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    process.env.APP_ENV = 'production';
    vi.resetModules();
    const mod = (await import('../../server/admin-api/app')) as {
      default: import('express').Express;
    };
    app = mod.default;
  });

  afterAll(() => {
    if (createdIndex && fs.existsSync(indexHtmlPath)) {
      fs.unlinkSync(indexHtmlPath);
    }
    if (createdDist && fs.existsSync(clientDistPath)) {
      try {
        fs.rmdirSync(clientDistPath);
      } catch {
        // Directory not empty (real build artifacts landed mid-test).
        // Leaving it in place is safe.
      }
    }

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

  it('imports app under APP_ENV=production without throwing', () => {
    expect(app).toBeDefined();
    expect(typeof app.use).toBe('function');
  });

  it('GET /dashboard returns the bundled index.html', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(expectedHtml);
  });

  it('GET / serves the static index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe(expectedHtml);
  });

  it('a deep SPA route resolves through the fallback', async () => {
    const res = await request(app).get('/admin/sales-inbox/details/abc-123');
    expect(res.status).toBe(200);
    expect(res.text).toBe(expectedHtml);
  });

  it('GET /health hits the API surface, not the SPA fallback', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ service: 'admin-api' });
    expect(res.text).not.toContain('<!DOCTYPE html');
  });
});
