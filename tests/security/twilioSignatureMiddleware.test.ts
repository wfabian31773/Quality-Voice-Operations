import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { twilioSignatureMiddleware } from '../../server/voice-gateway/middleware/twilioSignature';
import {
  __resetTwilioSignatureMetricsForTests,
  getTwilioSignatureMetrics,
} from '../../server/voice-gateway/middleware/twilioSignatureMetrics';

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn(async () => {}),
}));

import { logError } from '../../platform/core/observability';

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
    __resetTwilioSignatureMetricsForTests();
    vi.mocked(logError).mockClear();
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

  describe('rejection metrics', () => {
    it('increments missing_header counter when X-Twilio-Signature is absent', async () => {
      const app = buildApp();
      await request(app).post('/twilio/voice').type('form').send({ CallSid: 'CA1' });

      const m = getTwilioSignatureMetrics();
      expect(m.totals.missing_header).toBe(1);
      expect(m.totals.invalid_signature).toBe(0);
      expect(m.totals.validator_unavailable).toBe(0);
      expect(m.ratePerMinute.missing_header).toBe(1);
    });

    it('increments invalid_signature counter when the signature is wrong', async () => {
      const app = buildApp();
      await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', 'tampered')
        .type('form')
        .send({ CallSid: 'CA1' });

      const m = getTwilioSignatureMetrics();
      expect(m.totals.invalid_signature).toBe(1);
      expect(m.ratePerMinute.invalid_signature).toBe(1);
    });

    it('increments validator_unavailable counter in production with no auth token', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      const app = buildApp();
      await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', 'irrelevant')
        .type('form')
        .send({ CallSid: 'CA1' });

      const m = getTwilioSignatureMetrics();
      expect(m.totals.validator_unavailable).toBe(1);
    });

    it('does not increment any counter when the signature is valid', async () => {
      const app = buildApp('example.com', 'https');
      const params = { CallSid: 'CA1' };
      const sig = signRequest('https://example.com/twilio/voice', params);
      await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', sig)
        .type('form')
        .send(params);

      const m = getTwilioSignatureMetrics();
      expect(m.totals.missing_header).toBe(0);
      expect(m.totals.invalid_signature).toBe(0);
      expect(m.totals.validator_unavailable).toBe(0);
    });

    it('fires a critical logError once when invalid_signature rejections cross the per-minute threshold', async () => {
      const app = buildApp();
      // Threshold is 5/min for invalid_signature — fire 6 to cross it.
      for (let i = 0; i < 6; i++) {
        await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', 'tampered')
          .type('form')
          .send({ CallSid: `CA${i}` });
      }

      const m = getTwilioSignatureMetrics();
      expect(m.totals.invalid_signature).toBe(6);
      expect(m.alertActive.invalid_signature).toBe(true);

      // logError should be called exactly once due to cooldown, and at critical severity.
      const calls = vi.mocked(logError).mock.calls;
      const spikeCalls = calls.filter(
        ([, severity, , ctx]) =>
          severity === 'critical' &&
          (ctx as { errorCode?: string } | undefined)?.errorCode === 'twilio_signature_invalid_signature_spike',
      );
      expect(spikeCalls).toHaveLength(1);
    });

    it('does not fire an alert when invalid_signature stays below the threshold', async () => {
      const app = buildApp();
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', 'tampered')
          .type('form')
          .send({ CallSid: `CA${i}` });
      }

      const m = getTwilioSignatureMetrics();
      expect(m.totals.invalid_signature).toBe(4);
      expect(m.alertActive.invalid_signature).toBe(false);
      const spikeCalls = vi
        .mocked(logError)
        .mock.calls.filter(
          ([, , , ctx]) =>
            (ctx as { errorCode?: string } | undefined)?.errorCode === 'twilio_signature_invalid_signature_spike',
        );
      expect(spikeCalls).toHaveLength(0);
    });

    it('correctly counts and alerts on a burst that arrives after a long idle period (>60min)', async () => {
      vi.useFakeTimers();
      try {
        const baseTime = new Date('2026-04-25T10:00:00Z').getTime();
        vi.setSystemTime(baseTime);
        __resetTwilioSignatureMetricsForTests();
        vi.mocked(logError).mockClear();

        const app = buildApp();

        // Two stale rejections at t=0
        for (let i = 0; i < 2; i++) {
          await request(app)
            .post('/twilio/voice')
            .set('X-Twilio-Signature', 'tampered')
            .type('form')
            .send({ CallSid: `OLD${i}` });
        }

        // Idle for 90 minutes — well past the 60-minute window
        vi.setSystemTime(baseTime + 90 * 60_000);

        // Snapshot now: stale events should have rolled out of the
        // per-minute window, ratePerMinute should be 0
        const idleSnapshot = getTwilioSignatureMetrics();
        expect(idleSnapshot.ratePerMinute.invalid_signature).toBe(0);
        expect(idleSnapshot.totals.invalid_signature).toBe(2); // totals are cumulative

        // Now a real burst — 6 invalid_signature rejections in the same minute
        for (let i = 0; i < 6; i++) {
          await request(app)
            .post('/twilio/voice')
            .set('X-Twilio-Signature', 'tampered')
            .type('form')
            .send({ CallSid: `BURST${i}` });
        }

        const burstSnapshot = getTwilioSignatureMetrics();
        // ratePerMinute must reflect the burst, not be diluted by the
        // earlier stale bucket: must be exactly 6
        expect(burstSnapshot.ratePerMinute.invalid_signature).toBe(6);
        expect(burstSnapshot.alertActive.invalid_signature).toBe(true);

        // The spike alert should have fired exactly once for the burst
        const spikeCalls = vi
          .mocked(logError)
          .mock.calls.filter(
            ([, severity, , ctx]) =>
              severity === 'critical' &&
              (ctx as { errorCode?: string } | undefined)?.errorCode ===
                'twilio_signature_invalid_signature_spike',
          );
        expect(spikeCalls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rotates buckets to the current minute even after multi-hour idle', async () => {
      vi.useFakeTimers();
      try {
        const baseTime = new Date('2026-04-25T10:00:00Z').getTime();
        vi.setSystemTime(baseTime);
        __resetTwilioSignatureMetricsForTests();

        // Idle for 5 hours
        vi.setSystemTime(baseTime + 5 * 60 * 60_000);

        const snapshot = getTwilioSignatureMetrics();
        // After multi-hour idle the ring should be reset to a single
        // bucket anchored at (or within one minute of) "now"
        expect(snapshot.buckets.length).toBeGreaterThanOrEqual(1);
        const head = snapshot.buckets[snapshot.buckets.length - 1];
        const headTime = new Date(head.startedAt).getTime();
        const now = baseTime + 5 * 60 * 60_000;
        expect(now - headTime).toBeLessThan(60_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
