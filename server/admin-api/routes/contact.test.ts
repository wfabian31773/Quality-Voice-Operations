import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  recordLeadMock: vi.fn(),
  attachBookingToLeadMock: vi.fn(),
  attachBookingToLeadByIdMock: vi.fn(),
  notifyBookingConfirmedMock: vi.fn(),
  findLatestLeadByEmailMock: vi.fn(),
  findLeadByIdMock: vi.fn(),
  getActiveCalcomSecretMock: vi.fn(),
  getActiveCalendlySecretMock: vi.fn(),
  getPublicDemoSchedulerConfigMock: vi.fn(),
}));

vi.mock('../services/marketing-leads', () => ({
  recordLead: a.recordLeadMock,
  attachBookingToLead: a.attachBookingToLeadMock,
  attachBookingToLeadById: a.attachBookingToLeadByIdMock,
  notifyBookingConfirmed: a.notifyBookingConfirmedMock,
  findLatestLeadByEmail: a.findLatestLeadByEmailMock,
  findLeadById: a.findLeadByIdMock,
}));
vi.mock('../services/demo-scheduler-settings', () => ({
  getActiveCalcomWebhookSecret: a.getActiveCalcomSecretMock,
  getActiveCalendlyWebhookSecret: a.getActiveCalendlySecretMock,
  getPublicDemoSchedulerConfig: a.getPublicDemoSchedulerConfigMock,
}));

import router, { verifyCalcomSignature, verifyCalcomNativeSignature } from './contact';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const SECRET = 'whsec_test';
const calcomEnvelope = (body: string, ts: number, secret = SECRET) => {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
};

beforeEach(() => {
  a.recordLeadMock.mockReset().mockResolvedValue({ id: 42 });
  a.getPublicDemoSchedulerConfigMock.mockReset().mockResolvedValue({ provider: 'calcom', embedUrl: 'https://cal.com/x' });
  delete process.env.CALCOM_WEBHOOK_SECRET;
  delete process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED;
});
afterEach(() => {
  delete process.env.CALCOM_WEBHOOK_SECRET;
  delete process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED;
});

describe('verifyCalcomSignature (exported)', () => {
  const body = Buffer.from('{"event":"x"}');
  const now = Math.floor(Date.now() / 1000);

  it('rejects (500) when no secret is configured and unsigned is not allowed', () => {
    expect(verifyCalcomSignature(body, 'sig', undefined, now, '')).toMatchObject({ ok: false, status: 500 });
  });

  it('accepts a valid Stripe-style envelope signature', () => {
    const header = calcomEnvelope(body.toString('utf8'), now);
    expect(verifyCalcomSignature(body, header, undefined, now, SECRET)).toEqual({ ok: true });
  });

  it('rejects a stale timestamp (401)', () => {
    const stale = now - 10_000;
    const header = calcomEnvelope(body.toString('utf8'), stale);
    expect(verifyCalcomSignature(body, header, undefined, now, SECRET)).toMatchObject({ ok: false, status: 401, error: 'Stale timestamp' });
  });

  it('rejects a missing signature header (401)', () => {
    expect(verifyCalcomSignature(body, undefined, undefined, now, SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects an invalid signature with a valid timestamp (401)', () => {
    const header = `t=${now},v1=deadbeef`;
    expect(verifyCalcomSignature(body, header, undefined, now, SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it('supports the scalar-signature + x-cal-timestamp form', () => {
    const sig = crypto.createHmac('sha256', SECRET).update(`${now}.${body.toString('utf8')}`).digest('hex');
    expect(verifyCalcomSignature(body, sig, String(now), now, SECRET)).toEqual({ ok: true });
  });
});

describe('verifyCalcomNativeSignature (exported)', () => {
  const body = Buffer.from('{"native":true}');
  it('accepts a body-only HMAC', () => {
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyCalcomNativeSignature(body, `sha256=${sig}`, SECRET)).toEqual({ ok: true });
  });
  it('rejects a wrong signature', () => {
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const wrong = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    expect(verifyCalcomNativeSignature(body, wrong, SECRET)).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects when no secret configured', () => {
    expect(verifyCalcomNativeSignature(body, 'sig', '')).toMatchObject({ ok: false, status: 500 });
  });
});

describe('POST /contact', () => {
  it('requires name/email/message', async () => {
    expect((await request(app()).post('/contact').send({ name: 'A' })).status).toBe(400);
  });
  it('rejects an invalid email', async () => {
    expect((await request(app()).post('/contact').send({ name: 'A', email: 'bad', message: 'hi' })).status).toBe(400);
  });
  it('records a valid contact lead', async () => {
    const res = await request(app()).post('/contact').send({ name: 'A', email: 'a@b.com', message: 'hi' });
    expect(res.body.success).toBe(true);
    expect(a.recordLeadMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'contact', email: 'a@b.com' }));
  });
});

describe('POST /book-demo', () => {
  it('requires name/email/company', async () => {
    expect((await request(app()).post('/book-demo').send({ name: 'A', email: 'a@b.com' })).status).toBe(400);
  });
  it('records a demo request and returns the leadId', async () => {
    a.recordLeadMock.mockResolvedValue({ id: 99 });
    const res = await request(app()).post('/book-demo').send({ name: 'A', email: 'a@b.com', company: 'Acme' });
    expect(res.body).toMatchObject({ success: true, leadId: 99 });
  });
});

describe('POST /roi-lead', () => {
  it('requires a valid email', async () => {
    expect((await request(app()).post('/roi-lead').send({ name: 'A' })).status).toBe(400);
  });
  it('records an roi_calculator lead', async () => {
    const res = await request(app()).post('/roi-lead').send({ email: 'a@b.com', results: {}, vertical: 'dental' });
    expect(res.body.success).toBe(true);
    expect(a.recordLeadMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'roi_calculator' }));
  });
});

describe('GET /book-demo/config', () => {
  it('returns the public scheduler config', async () => {
    const res = await request(app()).get('/book-demo/config');
    expect(res.body).toMatchObject({ provider: 'calcom' });
  });
  it('500 on failure', async () => {
    a.getPublicDemoSchedulerConfigMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/book-demo/config')).status).toBe(500);
  });
});

describe('POST /book-demo/calendar-webhook signature rejection', () => {
  it('rejects a Cal.com delivery with a missing timestamp (401)', async () => {
    a.getActiveCalcomSecretMock.mockResolvedValue(SECRET);
    // scalar signature, no x-cal-timestamp → "Missing timestamp"
    const res = await request(app())
      .post('/book-demo/calendar-webhook')
      .set('x-cal-signature-256', 'abcdef')
      .send({ triggerEvent: 'BOOKING_CREATED' });
    expect(res.status).toBe(401);
  });
});
