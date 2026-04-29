import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { twilioSignatureMiddleware } from '../../server/voice-gateway/middleware/twilioSignature';
import {
  __resetTwilioSignatureMetricsForTests,
  getTwilioSignatureMetrics,
} from '../../server/voice-gateway/middleware/twilioSignatureMetrics';
import {
  __resetTwilioReplayCacheForTests,
  __setTwilioReplayDurableBackendForTests,
} from '../../server/voice-gateway/middleware/twilioReplayCache';

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
    __resetTwilioReplayCacheForTests();
    // Tests don't have a real Postgres pool — install a null durable backend
    // so the cache exercises the in-memory path. Two tests below override
    // this with a fake backend to assert cross-instance behavior.
    __setTwilioReplayDurableBackendForTests(null);
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
        __resetTwilioReplayCacheForTests();
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

  // ---------------------------------------------------------------------------
  // Replay protection — mirrors the "replay protection" describe block in
  // tests/marketing/calcomBookingWebhook.test.ts, adapted for Twilio's
  // (timestamp-less) signature scheme. Twilio doesn't sign a timestamp into
  // its webhooks, so the defense is a per-request-ID nonce cache instead of
  // a 5-minute window. A captured (URL, params, signature) tuple replayed
  // verbatim within the TTL must be rejected with 403, even though the
  // signature itself is still cryptographically valid.
  // ---------------------------------------------------------------------------
  describe('replay protection', () => {
    it('accepts a fresh /twilio/sms request and rejects the verbatim replay', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/sms';
      const params = {
        MessageSid: 'SM_replay_1',
        From: '+15551112222',
        To: '+15553334444',
        Body: 'hello',
      };
      const signature = signRequest(fullUrl, params);

      // Mount /twilio/sms by re-using the same middleware.
      app.use('/twilio/sms', twilioSignatureMiddleware);
      app.post('/twilio/sms', (_req, res) => res.status(200).json({ ok: true }));

      const fresh = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(fresh.status).toBe(200);

      const replay = await request(app)
        .post('/twilio/sms')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(replay.status).toBe(403);

      const m = getTwilioSignatureMetrics();
      expect(m.totals.replay_detected).toBe(1);
      expect(m.totals.invalid_signature).toBe(0);
    });

    it('rejects a replayed /twilio/voice payload (CallSid is the nonce)', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/voice';
      const params = { CallSid: 'CA_replay_voice', From: '+15551112222', To: '+15553334444' };
      const signature = signRequest(fullUrl, params);

      const fresh = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(fresh.status).toBe(200);

      const replay = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(replay.status).toBe(403);

      const m = getTwilioSignatureMetrics();
      expect(m.totals.replay_detected).toBe(1);
    });

    it('lets distinct calls from the same caller through (each has a unique CallSid)', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/voice';

      for (const callSid of ['CA_unique_1', 'CA_unique_2', 'CA_unique_3']) {
        const params = { CallSid: callSid, From: '+15551112222', To: '+15553334444' };
        const signature = signRequest(fullUrl, params);
        const r = await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(r.status).toBe(200);
      }

      const m = getTwilioSignatureMetrics();
      expect(m.totals.replay_detected).toBe(0);
    });

    it('dedupes /twilio/sms-status by MessageSid + MessageStatus so the queued→sent→delivered chain passes', async () => {
      const app = buildApp('example.com', 'https');
      app.use('/twilio/sms-status', twilioSignatureMiddleware);
      app.post('/twilio/sms-status', (_req, res) => res.sendStatus(204));

      const fullUrl = 'https://example.com/twilio/sms-status';
      const messageSid = 'SM_lifecycle_legit';

      // The legitimate Twilio SMS lifecycle for a single message — each
      // transition arrives as its own webhook with the SAME MessageSid but a
      // different MessageStatus. All four must pass; only a verbatim re-fire
      // of one transition is a replay.
      for (const status of ['queued', 'sent', 'delivered']) {
        const params = { MessageSid: messageSid, MessageStatus: status };
        const signature = signRequest(fullUrl, params);
        const r = await request(app)
          .post('/twilio/sms-status')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(r.status).toBe(204);
      }
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(0);

      // Now replay the `delivered` callback verbatim — must be rejected.
      const replayParams = { MessageSid: messageSid, MessageStatus: 'delivered' };
      const replaySig = signRequest(fullUrl, replayParams);
      const replay = await request(app)
        .post('/twilio/sms-status')
        .set('X-Twilio-Signature', replaySig)
        .type('form')
        .send(replayParams);
      expect(replay.status).toBe(403);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
    });

    it('dedupes /twilio/status by CallSid + SequenceNumber so legitimate per-event status callbacks pass', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/status';

      // Three distinct status events for the same call — these are the
      // legitimate sequence Twilio sends (`initiated` → `ringing` →
      // `completed`). Each has a different SequenceNumber, so they must
      // all pass.
      for (let seq = 0; seq < 3; seq++) {
        const params = {
          CallSid: 'CA_status_legit',
          CallStatus: ['initiated', 'ringing', 'completed'][seq]!,
          SequenceNumber: String(seq),
        };
        const signature = signRequest(fullUrl, params);
        const r = await request(app)
          .post('/twilio/status')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(r.status).toBe(204);
      }
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(0);

      // Now replay one of them verbatim — must be rejected.
      const replayParams = {
        CallSid: 'CA_status_legit',
        CallStatus: 'completed',
        SequenceNumber: '2',
      };
      const replaySig = signRequest(fullUrl, replayParams);
      const replay = await request(app)
        .post('/twilio/status')
        .set('X-Twilio-Signature', replaySig)
        .type('form')
        .send(replayParams);
      expect(replay.status).toBe(403);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
    });

    it('does not pollute the replay cache when the signature is invalid (a forged replay still fails on signature)', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/voice';
      const params = { CallSid: 'CA_forged_then_real', From: '+15551112222', To: '+15553334444' };

      // Attacker tries to lock the CallSid by sending a forged signature
      // first. This must be rejected on signature, NOT on replay.
      const tampered = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', 'definitely-not-a-real-signature')
        .type('form')
        .send(params);
      expect(tampered.status).toBe(403);
      expect(getTwilioSignatureMetrics().totals.invalid_signature).toBe(1);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(0);

      // The legitimate request with the same CallSid then arrives — must
      // be accepted because the forged attempt did not enter the cache.
      const signature = signRequest(fullUrl, params);
      const real = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(real.status).toBe(200);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(0);
    });

    it('matches the Cal.com 5-minute replay window: in-window replay rejected, out-of-window replay tolerated (cache TTL is the window)', async () => {
      vi.useFakeTimers();
      try {
        const baseTime = new Date('2026-04-25T10:00:00Z').getTime();
        vi.setSystemTime(baseTime);
        __resetTwilioReplayCacheForTests();
        // Re-install the null durable backend after the inner reset, so the
        // cache doesn't try to lazy-load the (unavailable in tests) Postgres
        // module under fake timers — keeps the test focused on TTL semantics.
        __setTwilioReplayDurableBackendForTests(null);
        __resetTwilioSignatureMetricsForTests();

        const app = buildApp('example.com', 'https');
        const fullUrl = 'https://example.com/twilio/voice';
        const params = { CallSid: 'CA_window_check', From: '+15551112222', To: '+15553334444' };
        const signature = signRequest(fullUrl, params);

        // T+0: original request — accepted, nonce marked.
        const fresh = await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(fresh.status).toBe(200);

        // T+299s: still inside the 5-minute window — must be rejected.
        vi.setSystemTime(baseTime + 299 * 1000);
        const inWindow = await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(inWindow.status).toBe(403);
        expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);

        // T+301s: outside the 5-minute window — the nonce has expired and the
        // cache no longer treats this as a replay. We document this as the
        // accepted trade-off in `twilioReplayCache.ts`: a captured payload
        // replayed >5min later is "stale" by the same yardstick Cal.com /
        // Stripe use, but Twilio gives us no signed timestamp to enforce
        // staleness cryptographically.
        vi.setSystemTime(baseTime + 301 * 1000);
        const outOfWindow = await request(app)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(outOfWindow.status).toBe(200);
        // The replay_detected counter must NOT have advanced — the
        // out-of-window request was accepted, not rejected as a replay.
        expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    // Faithful in-memory simulation of the production Postgres claim:
    //   INSERT ... ON CONFLICT (nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at
    //     WHERE existing.expires_at <= NOW() RETURNING (xmax = 0) AS inserted
    // Returns true on a fresh insert OR on an expired-row reclaim, false when
    // the existing row is still inside its TTL. Backed by a shared Map so the
    // same store can simulate "two gateway instances racing on the same row"
    // or "one instance, before and after restart".
    function makeDurableFake(shared: Map<string, number>) {
      return {
        async claim(key: string, expiresAtMs: number): Promise<boolean> {
          const existing = shared.get(key);
          const now = Date.now();
          if (existing !== undefined && existing > now) return false; // still in TTL ⇒ replay
          shared.set(key, expiresAtMs); // fresh insert OR expired-row reclaim
          return true;
        },
      };
    }

    it('rejects replays even after a process restart, when the durable Postgres backend has the nonce', async () => {
      // Simulate two gateway processes (or one process before/after restart)
      // sharing the same Postgres-backed nonce store. Process A claims the
      // nonce via the durable backend; process B's in-memory cache is empty
      // but the durable backend still reports the nonce as already claimed,
      // so process B must reject the replay.
      const sharedDurableNonces = new Map<string, number>();
      __setTwilioReplayDurableBackendForTests(makeDurableFake(sharedDurableNonces));

      const fullUrl = 'https://example.com/twilio/voice';
      const params = { CallSid: 'CA_durable_check', From: '+15551112222', To: '+15553334444' };
      const signature = signRequest(fullUrl, params);

      // Process A: fresh request, claims the nonce in shared storage.
      const procA = buildApp('example.com', 'https');
      const fresh = await request(procA)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(fresh.status).toBe(200);
      expect(sharedDurableNonces.size).toBe(1);

      // Simulate "process B" by clearing the in-memory cache (the shared
      // durable store survives — that's the whole point) and rebuilding the
      // app. The durable backend must still flag the nonce.
      __resetTwilioReplayCacheForTests();
      __setTwilioReplayDurableBackendForTests(makeDurableFake(sharedDurableNonces));

      const procB = buildApp('example.com', 'https');
      const replay = await request(procB)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(replay.status).toBe(403);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
    });

    it('rolls over after the 5-minute TTL even when the check goes through the durable Postgres backend', async () => {
      // This is the durable-path counterpart to the in-memory 5-min-window
      // test above. We must prove that a captured payload re-fired AFTER the
      // TTL is allowed again — otherwise the durable layer would block
      // legitimate Twilio retries indefinitely.
      vi.useFakeTimers();
      try {
        const baseTime = new Date('2026-04-25T12:00:00Z').getTime();
        vi.setSystemTime(baseTime);
        __resetTwilioReplayCacheForTests();
        __resetTwilioSignatureMetricsForTests();

        const sharedDurableNonces = new Map<string, number>();
        __setTwilioReplayDurableBackendForTests(makeDurableFake(sharedDurableNonces));

        const fullUrl = 'https://example.com/twilio/voice';
        const params = { CallSid: 'CA_durable_rollover', From: '+15551112222', To: '+15553334444' };
        const signature = signRequest(fullUrl, params);

        // T+0: fresh — accepted, nonce written to the durable store.
        const appA = buildApp('example.com', 'https');
        const first = await request(appA)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(first.status).toBe(200);
        expect(sharedDurableNonces.size).toBe(1);

        // Drop the in-memory cache to force the next check through the
        // durable layer (otherwise the in-memory TTL would short-circuit the
        // verdict and we wouldn't actually be testing durable expiry).
        __resetTwilioReplayCacheForTests();
        __setTwilioReplayDurableBackendForTests(makeDurableFake(sharedDurableNonces));

        // T+299s: still inside the durable TTL — must be rejected via the
        // Postgres path (since in-memory was just cleared).
        vi.setSystemTime(baseTime + 299 * 1000);
        const inWindow = await request(appA)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(inWindow.status).toBe(403);
        expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);

        // Drop in-memory again before the rollover check, so the verdict
        // again has to come from the durable backend.
        __resetTwilioReplayCacheForTests();
        __setTwilioReplayDurableBackendForTests(makeDurableFake(sharedDurableNonces));

        // T+301s: outside the 5-min window — durable claim must reclaim the
        // expired row and report fresh (HTTP 200). This is the bug the
        // reviewer flagged: ON CONFLICT DO NOTHING would block this forever.
        vi.setSystemTime(baseTime + 301 * 1000);
        const afterWindow = await request(appA)
          .post('/twilio/voice')
          .set('X-Twilio-Signature', signature)
          .type('form')
          .send(params);
        expect(afterWindow.status).toBe(200);
        // No additional replay_detected metric increment from the rollover.
        expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails open at the durable tier (still safe in-memory) when the Postgres backend errors', async () => {
      // Simulate a Postgres outage: `claim()` always throws. The cache must
      // fail open at the durable tier (so a DB blip doesn't take down voice)
      // but still enforce the in-memory check, so an in-process replay is
      // still rejected.
      __setTwilioReplayDurableBackendForTests({
        async claim(): Promise<boolean> {
          throw new Error('simulated postgres outage');
        },
      });

      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/voice';
      const params = { CallSid: 'CA_db_outage', From: '+15551112222', To: '+15553334444' };
      const signature = signRequest(fullUrl, params);

      const fresh = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(fresh.status).toBe(200);

      const replay = await request(app)
        .post('/twilio/voice')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(params);
      expect(replay.status).toBe(403);
      expect(getTwilioSignatureMetrics().totals.replay_detected).toBe(1);
    });

    it('records replay_detected in the per-minute bucket and increments rejection metrics', async () => {
      const app = buildApp('example.com', 'https');
      const fullUrl = 'https://example.com/twilio/sms';
      const params = { MessageSid: 'SM_metric_1', From: '+15551112222', To: '+15553334444', Body: 'm' };
      const sig = signRequest(fullUrl, params);

      app.use('/twilio/sms', twilioSignatureMiddleware);
      app.post('/twilio/sms', (_req, res) => res.status(200).json({ ok: true }));

      // First — fresh; second + third — replays.
      await request(app).post('/twilio/sms').set('X-Twilio-Signature', sig).type('form').send(params);
      await request(app).post('/twilio/sms').set('X-Twilio-Signature', sig).type('form').send(params);
      await request(app).post('/twilio/sms').set('X-Twilio-Signature', sig).type('form').send(params);

      const m = getTwilioSignatureMetrics();
      expect(m.totals.replay_detected).toBe(2);
      expect(m.ratePerMinute.replay_detected).toBe(2);
    });
  });
});
