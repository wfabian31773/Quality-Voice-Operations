import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);

describe('POST /support/inbound — static guards', () => {
  it('rejects requests in production when SUPPORT_INBOUND_SECRET is unset', () => {
    expect(supportFile).toMatch(/process\.env\.NODE_ENV === 'production'/);
    expect(supportFile).toMatch(/isProduction && !INBOUND_SECRET/);
  });

  it('verifies the shared secret from header or query when configured', () => {
    expect(supportFile).toMatch(/x-webhook-secret/);
    expect(supportFile).toMatch(/req\.query\.secret/);
    expect(supportFile).toMatch(/provided !== INBOUND_SECRET/);
  });

  it('returns 401 on auth failures', () => {
    expect(supportFile).toMatch(/res\.status\(401\)\.json\(\{ error: 'unauthorized' \}\)/);
  });
});

describe('POST /support/inbound — runtime auth enforcement', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_SECRET = process.env.SUPPORT_INBOUND_SECRET;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPPORT_INBOUND_SECRET;
    else process.env.SUPPORT_INBOUND_SECRET = ORIGINAL_SECRET;
  });

  async function buildApp() {
    const router = (await import('../../server/admin-api/routes/support')).default;
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  }

  it('rejects with 401 in production when the secret env var is missing', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SUPPORT_INBOUND_SECRET;
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: '(tkt_abc)', text: 'hi' });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects with 401 when the secret is set but the request omits it', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_INBOUND_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: '(tkt_abc)', text: 'hi' });
    expect(r.status).toBe(401);
  });

  it('rejects with 401 when the provided secret does not match', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_INBOUND_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound')
      .set('X-Webhook-Secret', 'wrong')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: '(tkt_abc)', text: 'hi' });
    expect(r.status).toBe(401);
  });

  it('allows the request past the auth gate when the header secret matches', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_INBOUND_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound')
      .set('X-Webhook-Secret', 'shhh')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: 'no ticket ref', text: 'hi' });
    // Past auth: either 202 (no ticket match) or 500 (db unavailable in tests),
    // but never 401.
    expect(r.status).not.toBe(401);
  });

  it('allows the request past the auth gate when the query secret matches', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPPORT_INBOUND_SECRET = 'shhh';
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound?secret=shhh')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: 'no ticket ref', text: 'hi' });
    expect(r.status).not.toBe(401);
  });

  it('does not require the secret in development when env var is unset', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SUPPORT_INBOUND_SECRET;
    const app = await buildApp();
    const r = await request(app)
      .post('/support/inbound')
      .send({ from: 'a@b.c', to: 'support@reply.qvo.ai', subject: 'no ticket ref', text: 'hi' });
    expect(r.status).not.toBe(401);
  });
});
