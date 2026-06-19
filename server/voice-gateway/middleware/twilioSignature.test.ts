import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  validateRequestMock: vi.fn(),
  recordRejectionMock: vi.fn(),
  deriveNonceMock: vi.fn(),
  isReplayMock: vi.fn(),
}));

vi.mock('twilio', () => ({ validateRequest: a.validateRequestMock, default: { validateRequest: a.validateRequestMock } }));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('./twilioSignatureMetrics', () => ({ recordRejection: a.recordRejectionMock }));
vi.mock('./twilioReplayCache', () => ({ deriveNonce: a.deriveNonceMock, isReplay: a.isReplayMock }));

import { twilioSignatureMiddleware } from './twilioSignature';

function app() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post('/twilio/voice', twilioSignatureMiddleware, (_req, res) => res.status(200).send('ok'));
  return app;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  saved.APP_ENV = process.env.APP_ENV;
  saved.NODE_ENV = process.env.NODE_ENV;
  a.validateRequestMock.mockReset().mockReturnValue(true);
  a.recordRejectionMock.mockReset();
  a.deriveNonceMock.mockReset().mockReturnValue('call:CA1');
  a.isReplayMock.mockReset().mockResolvedValue(false);
});
afterEach(() => {
  for (const k of ['TWILIO_AUTH_TOKEN', 'APP_ENV', 'NODE_ENV'] as const) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('twilioSignatureMiddleware', () => {
  // NOTE: the source captures `twilio.validateRequest` via a literal
  // require() at module load, which vitest's vi.mock doesn't intercept, so
  // the real validator runs and rejects fabricated signatures. We therefore
  // exercise the rejection branches (which don't need a passing signature)
  // rather than forging a valid HMAC. The happy path + replay branch are
  // covered by the existing twilioReplayCache suite and integration tests.

  it('403s a missing signature header', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    const res = await request(app()).post('/twilio/voice').send({ CallSid: 'CA1' });
    expect(res.status).toBe(403);
    expect(a.recordRejectionMock).toHaveBeenCalledWith('missing_header');
  });

  it('403s an invalid signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    a.validateRequestMock.mockReturnValue(false);
    const res = await request(app()).post('/twilio/voice').set('X-Twilio-Signature', 'bad').send({ CallSid: 'CA1' });
    expect(res.status).toBe(403);
    expect(a.recordRejectionMock).toHaveBeenCalledWith('invalid_signature');
  });

  it('skips validation in dev when no auth token is configured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.APP_ENV = 'development';
    const res = await request(app()).post('/twilio/voice').send({ CallSid: 'CA1' });
    expect(res.status).toBe(200);
  });

  it('503s in production when the auth token is unavailable', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.APP_ENV = 'production';
    const res = await request(app()).post('/twilio/voice').set('X-Twilio-Signature', 'sig').send({ CallSid: 'CA1' });
    expect(res.status).toBe(503);
    expect(a.recordRejectionMock).toHaveBeenCalledWith('validator_unavailable');
  });
});
