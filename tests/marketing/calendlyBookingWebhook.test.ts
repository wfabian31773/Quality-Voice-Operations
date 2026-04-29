import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const WEBHOOK_PATH = '/book-demo/calendar-webhook';
const TEST_SECRET = 'test_calendly_webhook_secret_value_xyz';

/**
 * Build the `Calendly-Webhook-Signature` header value for a given body.
 * Calendly's format is `t=<unix_seconds>,v1=<hex_hmac>` and the HMAC is
 * computed over `<timestamp>.<raw_body>` with the signing key.
 */
function signCalendly(
  body: string,
  opts: { secret?: string; timestampSeconds?: number } = {},
): string {
  const secret = opts.secret ?? TEST_SECRET;
  const ts = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${body}`)
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

interface BuildAppOptions {
  findLeadById?: ReturnType<typeof vi.fn>;
  findLatestLeadByEmail?: ReturnType<typeof vi.fn>;
  attachBookingToLeadById?: ReturnType<typeof vi.fn>;
  attachBookingToLead?: ReturnType<typeof vi.fn>;
  notifyBookingConfirmed?: ReturnType<typeof vi.fn>;
  recordLead?: ReturnType<typeof vi.fn>;
}

interface MockHandles {
  findLeadById: ReturnType<typeof vi.fn>;
  findLatestLeadByEmail: ReturnType<typeof vi.fn>;
  attachBookingToLeadById: ReturnType<typeof vi.fn>;
  attachBookingToLead: ReturnType<typeof vi.fn>;
  notifyBookingConfirmed: ReturnType<typeof vi.fn>;
  recordLead: ReturnType<typeof vi.fn>;
}

async function buildApp(opts: BuildAppOptions = {}): Promise<{ app: express.Express; mocks: MockHandles }> {
  const mocks: MockHandles = {
    findLeadById: opts.findLeadById ?? vi.fn(async () => null),
    findLatestLeadByEmail: opts.findLatestLeadByEmail ?? vi.fn(async () => null),
    attachBookingToLeadById:
      opts.attachBookingToLeadById ?? vi.fn(async () => ({ leadId: null, duplicate: false })),
    attachBookingToLead:
      opts.attachBookingToLead ?? vi.fn(async () => ({ leadId: null, duplicate: false })),
    notifyBookingConfirmed: opts.notifyBookingConfirmed ?? vi.fn(async () => {}),
    recordLead: opts.recordLead ?? vi.fn(async () => ({ id: 1 })),
  };

  vi.doMock('../../server/admin-api/services/marketing-leads', () => ({
    findLeadById: mocks.findLeadById,
    findLatestLeadByEmail: mocks.findLatestLeadByEmail,
    attachBookingToLeadById: mocks.attachBookingToLeadById,
    attachBookingToLead: mocks.attachBookingToLead,
    notifyBookingConfirmed: mocks.notifyBookingConfirmed,
    recordLead: mocks.recordLead,
  }));

  const router = (await import('../../server/admin-api/routes/contact')).default;
  const app = express();
  app.use(WEBHOOK_PATH, express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/', router);
  return { app, mocks };
}

function inviteeCreatedBody(overrides: {
  email?: string;
  name?: string;
  utmContent?: string;
  inviteeUri?: string;
  scheduledEventUri?: string;
  startTime?: string;
  endTime?: string;
  joinUrl?: string;
  rescheduleUrl?: string;
  cancelUrl?: string;
  timezone?: string;
} = {}): string {
  return JSON.stringify({
    event: 'invitee.created',
    payload: {
      email: overrides.email ?? 'invitee@example.com',
      name: overrides.name ?? 'Invitee Person',
      uri: overrides.inviteeUri ?? 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
      cancel_url: overrides.cancelUrl ?? 'https://calendly.com/cancellations/INV',
      reschedule_url: overrides.rescheduleUrl ?? 'https://calendly.com/reschedulings/INV',
      timezone: overrides.timezone ?? 'America/Los_Angeles',
      tracking: overrides.utmContent ? { utm_content: overrides.utmContent } : {},
      scheduled_event: {
        uri: overrides.scheduledEventUri ?? 'https://api.calendly.com/scheduled_events/EVT',
        name: '30 Minute Meeting',
        start_time: overrides.startTime ?? '2026-05-01T10:00:00Z',
        end_time: overrides.endTime ?? '2026-05-01T10:30:00Z',
        location: { type: 'zoom', join_url: overrides.joinUrl ?? 'https://zoom.us/j/abc' },
      },
    },
  });
}

describe('POST /book-demo/calendar-webhook — Calendly signature verification', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
    CALENDLY_WEBHOOK_ALLOW_UNSIGNED: process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED,
    CALENDLY_WEBHOOK_TOLERANCE_SECONDS: process.env.CALENDLY_WEBHOOK_TOLERANCE_SECONDS,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED;
    delete process.env.CALENDLY_WEBHOOK_TOLERANCE_SECONDS;
    // Provide a Cal.com secret too so the cross-provider routing test isn't
    // accidentally rejected by the Cal.com path's "secret not configured" check.
    process.env.CALCOM_WEBHOOK_SECRET = 'test_calcom_secret_for_routing';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('accepts a valid Calendly v1 signature and processes the event', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'invitee@example.com',
        payload: {},
        name: 'Invitee Person',
        company: 'Acme',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = inviteeCreatedBody({ utmContent: 'lead-42' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 42, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(42);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        provider: 'calendly',
        eventType: 'created',
        bookingUid: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
        bookingId: 'https://api.calendly.com/scheduled_events/EVT',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T10:30:00Z',
        timezone: 'America/Los_Angeles',
        meetingUrl: 'https://zoom.us/j/abc',
        rescheduleUrl: 'https://calendly.com/reschedulings/INV',
        cancelUrl: 'https://calendly.com/cancellations/INV',
        attendeeEmail: 'invitee@example.com',
        attendeeName: 'Invitee Person',
      }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when the Calendly-Webhook-Signature header is missing', async () => {
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    // Send some other Calendly-only header to force the route into the
    // Calendly branch even without the signature header. We do this by
    // POSTing the body without ANY signature header — both branches reject
    // unsigned requests, but the Calendly branch is only reached when the
    // signature header is present. So instead test: empty signature header
    // is treated as "Cal.com path", which also rejects. Use the dedicated
    // Calendly path by sending a malformed signature header below.
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', '   ')
      .send(body);

    // Empty/whitespace header is still considered "present" → routed to the
    // Calendly verifier → rejected for missing/invalid signature parts.
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/signature/i);
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the Calendly signature is malformed', async () => {
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', 'totally-not-a-calendly-signature')
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/signature/i);
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the Calendly v1 signature does not match', async () => {
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body, { secret: 'a-different-secret' }))
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid signature' });
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the Calendly signature timestamp is outside the replay window', async () => {
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    // 1 hour old — well past the 5-minute default tolerance.
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body, { timestampSeconds: staleTs }))
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Signature timestamp out of tolerance' });
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
  });

  it('rejects with 500 when CALENDLY_WEBHOOK_SECRET is missing in production', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body, { secret: 'whatever' }))
      .send(body);

    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Webhook secret not configured' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('honours CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1 in non-production when the secret is unset', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED = '1';
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'invitee@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = inviteeCreatedBody({ utmContent: 'lead-7' });
    // Signature header is still required to enter the Calendly branch, but
    // its contents are not verified when the secret is unset and the dev
    // opt-in is on.
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', 't=1,v1=ignored')
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(7, expect.any(Object));
  });
});

describe('POST /book-demo/calendar-webhook — Calendly lead resolution & event mapping', () => {
  const ORIGINAL = {
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
    process.env.CALCOM_WEBHOOK_SECRET = 'test_calcom_secret_for_routing';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('resolves the lead via tracking.utm_content=lead-<id> without falling back to email', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'lead@example.com',
        payload: {},
        name: 'Tracked Lead',
        company: 'Tracked Co',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = inviteeCreatedBody({
      utmContent: 'lead-99',
      email: 'a-different-email@example.com',
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 99, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(99);
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.findLatestLeadByEmail).not.toHaveBeenCalled();
    // Notification fires using the resolved lead's email (not the invitee's).
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![0]).toBe('lead@example.com');
  });

  it('falls back to invitee email when utm_content tracking is missing', async () => {
    const { app, mocks } = await buildApp({
      attachBookingToLead: vi.fn(async () => ({ leadId: 17, duplicate: false })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 17,
        payload: {},
        name: 'Fallback Lead',
        company: 'Fallback Co',
      })),
    });
    const body = inviteeCreatedBody({ email: 'fallback@example.com' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 17, duplicate: false });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).toHaveBeenCalledWith(
      'fallback@example.com',
      expect.objectContaining({ provider: 'calendly', eventType: 'created' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('maps invitee.canceled → eventType "cancelled" and notifies the sales team', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'cancel@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = JSON.stringify({
      event: 'invitee.canceled',
      payload: {
        email: 'cancel@example.com',
        name: 'Canceller',
        uri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-CXL',
        cancel_url: 'https://calendly.com/cancellations/INV-CXL',
        reschedule_url: 'https://calendly.com/reschedulings/INV-CXL',
        timezone: 'UTC',
        tracking: { utm_content: 'lead-5' },
        cancellation: { canceled_by: 'invitee', reason: 'Conflict' },
        scheduled_event: {
          uri: 'https://api.calendly.com/scheduled_events/EVT',
          name: '30 Minute Meeting',
          start_time: '2026-05-01T10:00:00Z',
          end_time: '2026-05-01T10:30:00Z',
        },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ provider: 'calendly', eventType: 'cancelled' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![1]).toMatchObject({
      eventType: 'cancelled',
      provider: 'calendly',
    });
  });

  it('acknowledges without action when neither tracking nor invitee email is usable', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        // No email, no tracking.utm_content
        scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/EVT' },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('acknowledges and ignores Calendly events we do not care about', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      event: 'routing_form_submission.created',
      payload: { email: 'someone@example.com' },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true, reason: 'unsupported_event' });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('does NOT re-send the booking-confirmed notification when the storage layer reports a duplicate', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'dup@example.com',
        payload: {},
        name: 'Dup',
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: true })),
    });
    const body = inviteeCreatedBody({ utmContent: 'lead-11', email: 'dup@example.com' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 11, duplicate: true });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});

describe('POST /book-demo/calendar-webhook — provider routing', () => {
  const ORIGINAL = {
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_WEBHOOK_SECRET = 'test_calcom_secret_for_routing';
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('routes to the Calendly verifier when Calendly-Webhook-Signature is present (rejects bad Cal.com sig sent in same request)', async () => {
    const { app, mocks } = await buildApp();
    const body = inviteeCreatedBody({ utmContent: 'lead-1' });
    // Provide BOTH headers — a bogus Cal.com header that would have been
    // accepted by the Cal.com branch never gets a chance because we route on
    // the Calendly header first. The Calendly signature here is intentionally
    // wrong, so we should see a 401 from the Calendly verifier.
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', 't=1,v1=deadbeef')
      .set(
        'x-cal-signature-256',
        crypto.createHmac('sha256', 'test_calcom_secret_for_routing').update(body).digest('hex'),
      )
      .send(body);

    // Routed to Calendly verifier, which rejects the stale/wrong signature.
    expect(r.status).toBe(401);
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('still routes to the Cal.com verifier when only x-cal-signature-256 is present', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'lead@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-1',
        attendees: [{ email: 'lead@example.com' }],
        metadata: { leadId: 3 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set(
        'x-cal-signature-256',
        crypto.createHmac('sha256', 'test_calcom_secret_for_routing').update(body).digest('hex'),
      )
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ provider: 'cal.com' }),
    );
  });
});
