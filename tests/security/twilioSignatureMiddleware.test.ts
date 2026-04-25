import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { twilioSignatureMiddleware } from '../../server/voice-gateway/middleware/twilioSignature';

const TEST_AUTH_TOKEN = 'test_auth_token_for_signature_validation';

function buildApp(forwardedHost = 'example.com', forwardedProto = 'https') {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    if (forwardedHost) req.headers['x-forwarded-host'] = forwardedHost;
    if (forwardedProto) req.headers['x-forwarded-proto'] = forwardedProto;
    next();
  });
  app.use('/twilio/voice', twilioSignatureMiddleware);
  app.use('/twilio/status', twilioSignatureMiddleware);
  app.post('/twilio/voice', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/twilio/status', (_req, res) => res.sendStatus(204));
  return app;
}

function signRequest(url: string, params: Record<string, string>): string {
  return twilio.getExpectedTwilioSignature(TEST_AUTH_TOKEN, url, params);
}

describe('twilioSignatureMiddleware', () => {
  const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_APP_ENV = process.env.APP_ENV;

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
  });

  afterEach(() => {
    if (ORIGINAL_AUTH_TOKEN === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = ORIGINAL_APP_ENV;
    vi.restoreAllMocks();
  });

  it('rejects with 403 when X-Twilio-Signature header is missing', async () => {
    const app = buildApp();
    const r = await request(app)
      .post('/twilio/voice')
      .type('form')
      .send({ CallSid: 'CA123', From: '+15551112222', To: '+15553334444' });
    expect(r.status).toBe(403);
  });

  it('rejects with 403 when the signature is tampered/invalid', async () => {
    const app = buildApp();
    const r = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', 'this-is-a-tampered-signature')
      .type('form')
      .send({ CallSid: 'CA123', From: '+15551112222', To: '+15553334444' });
    expect(r.status).toBe(403);
  });

  it('rejects with 403 when params are tampered after signing', async () => {
    const app = buildApp();
    const fullUrl = 'https://example.com/twilio/voice';
    const realParams = { CallSid: 'CA123', From: '+15551112222', To: '+15553334444' };
    const signature = signRequest(fullUrl, realParams);

    const r = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send({ ...realParams, To: '+15559998888' });
    expect(r.status).toBe(403);
  });

  it('accepts a request signed with the proxied (forwarded) URL', async () => {
    const app = buildApp('example.com', 'https');
    const fullUrl = 'https://example.com/twilio/voice';
    const params = { CallSid: 'CA123', From: '+15551112222', To: '+15553334444' };
    const signature = signRequest(fullUrl, params);

    const r = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('accepts a valid signature on /twilio/status', async () => {
    const app = buildApp('example.com', 'https');
    const fullUrl = 'https://example.com/twilio/status';
    const params = { CallSid: 'CA999', CallStatus: 'completed', CallDuration: '42' };
    const signature = signRequest(fullUrl, params);

    const r = await request(app)
      .post('/twilio/status')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);
    expect(r.status).toBe(204);
  });

  it('rejects in production with 503 when TWILIO_AUTH_TOKEN is unset', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const app = buildApp();
    const r = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', 'irrelevant')
      .type('form')
      .send({ CallSid: 'CA123' });
    expect(r.status).toBe(503);
  });

  it('verifies the proxied URL is used (not the local host header)', async () => {
    const app = buildApp('public.example.com', 'https');
    const proxiedUrl = 'https://public.example.com/twilio/voice';
    const params = { CallSid: 'CA123', From: '+15551112222', To: '+15553334444' };

    const localSignature = signRequest('https://127.0.0.1/twilio/voice', params);
    const tampered = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', localSignature)
      .type('form')
      .send(params);
    expect(tampered.status).toBe(403);

    const proxiedSignature = signRequest(proxiedUrl, params);
    const ok = await request(app)
      .post('/twilio/voice')
      .set('X-Twilio-Signature', proxiedSignature)
      .type('form')
      .send(params);
    expect(ok.status).toBe(200);
  });

  it('skips validation in development when TWILIO_AUTH_TOKEN is unset', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.NODE_ENV = 'development';
    process.env.APP_ENV = 'development';
    const app = buildApp();
    const r = await request(app)
      .post('/twilio/voice')
      .type('form')
      .send({ CallSid: 'CA123' });
    expect(r.status).toBe(200);
  });
});
