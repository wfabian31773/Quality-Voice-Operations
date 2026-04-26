import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

const previousAppEnv = process.env.APP_ENV;
const previousNodeEnv = process.env.NODE_ENV;

const clientDistPath = path.resolve(__dirname, '../../client-app/dist');
const indexHtmlPath = path.join(clientDistPath, 'index.html');
const distAvailable = fs.existsSync(indexHtmlPath);

let app: import('express').Express;

describe.skipIf(!distAvailable)('admin-api production-mode boot smoke', () => {
  beforeAll(async () => {
    process.env.APP_ENV = 'production';
    vi.resetModules();
    const mod = (await import('../../server/admin-api/app')) as {
      default: import('express').Express;
    };
    app = mod.default;
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

  it('imports app under APP_ENV=production without throwing', () => {
    expect(app).toBeDefined();
    expect(typeof app.use).toBe('function');
  });

  it('GET /dashboard returns the bundled index.html', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(expectedHtml);
  });

  it('GET / serves the static index.html', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe(expectedHtml);
  });

  it('a deep SPA route resolves through the fallback', async () => {
    const expectedHtml = fs.readFileSync(indexHtmlPath, 'utf8');
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
