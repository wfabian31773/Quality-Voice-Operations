import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ getTwilioSignatureMetricsMock: vi.fn() }));

vi.mock('../middleware/twilioSignatureMetrics', () => ({
  getTwilioSignatureMetrics: h.getTwilioSignatureMetricsMock,
}));

import adminMetricsRouter from './adminMetrics';

function app() {
  const a = express();
  a.use(adminMetricsRouter);
  return a;
}

const PATH = '/admin/twilio-webhook-security';

beforeEach(() => {
  h.getTwilioSignatureMetricsMock.mockReset().mockReturnValue({ verified: 10, rejected: 1 });
  process.env.ADMIN_INTERNAL_TOKEN = 'secret-token';
});
afterEach(() => {
  delete process.env.ADMIN_INTERNAL_TOKEN;
});

describe('admin metrics auth', () => {
  it('returns 503 when no admin token is configured', async () => {
    delete process.env.ADMIN_INTERNAL_TOKEN;
    const res = await request(app()).get(PATH);
    expect(res.status).toBe(503);
  });

  it('returns 403 when the token is wrong', async () => {
    const res = await request(app()).get(PATH).set('x-admin-token', 'nope');
    expect(res.status).toBe(403);
  });

  it('returns the signature metrics snapshot when authorized', async () => {
    const res = await request(app()).get(PATH).set('x-admin-token', 'secret-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: 10, rejected: 1 });
  });

  it('returns 500 when the snapshot read throws', async () => {
    h.getTwilioSignatureMetricsMock.mockImplementation(() => { throw new Error('boom'); });
    const res = await request(app()).get(PATH).set('x-admin-token', 'secret-token');
    expect(res.status).toBe(500);
  });
});
