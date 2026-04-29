import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const WEBHOOK_PATH = '/book-demo/calendly-webhook';
const TEST_SECRET = 'test_calendly_webhook_secret_value_123';

function signCalendly(body: string, secret: string = TEST_SECRET, nowSec?: number): string {
  const t = nowSec ?? Math.floor(Date.now() / 1000);
  const payload = `${t}.${body}`;
  const v1 = crypto.createHmac('sha256', secret).update(Buffer.from(payload, 'utf8')).digest('hex');
  return `t=${t},v1=${v1}`;
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
  // Mirror the production mount in server/admin-api/app.ts: raw body parser
  // only on the webhook path, JSON parser elsewhere.
  app.use(WEBHOOK_PATH, express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/', router);
  return { app, mocks };
}

function buildInviteeCreatedBody(overrides: {
  inviteeId?: string;
  scheduledEventId?: string;
  email?: string;
  name?: string;
  rescheduled?: boolean;
  utmContent?: string | null;
  startTime?: string;
  endTime?: string;
  joinUrl?: string;
  rescheduleUrl?: string;
  cancelUrl?: string;
  timezone?: string;
} = {}): string {
  const inviteeId = overrides.inviteeId ?? 'invitee-uuid-aaa';
  const scheduledEventId = overrides.scheduledEventId ?? 'event-uuid-zzz';
  return JSON.stringify({
    event: 'invitee.created',
    payload: {
      uri: `https://api.calendly.com/scheduled_events/${scheduledEventId}/invitees/${inviteeId}`,
      name: overrides.name ?? 'Calendly Lead',
      first_name: 'Calendly',
      last_name: 'Lead',
      email: overrides.email ?? 'attendee@example.com',
      timezone: overrides.timezone ?? 'America/New_York',
      rescheduled: overrides.rescheduled ?? false,
      old_invitee: null,
      new_invitee: null,
      cancel_url: overrides.cancelUrl ?? 'https://calendly.com/cancellations/abc',
      reschedule_url: overrides.rescheduleUrl ?? 'https://calendly.com/reschedulings/abc',
      status: 'active',
      tracking:
        overrides.utmContent === null
          ? { utm_content: null }
          : { utm_content: overrides.utmContent ?? 'lead-42', utm_source: 'qvo-book-demo' },
      scheduled_event: {
        uri: `https://api.calendly.com/scheduled_events/${scheduledEventId}`,
        name: '30 Minute Meeting',
        start_time: overrides.startTime ?? '2026-05-01T10:00:00Z',
        end_time: overrides.endTime ?? '2026-05-01T10:30:00Z',
        location: { type: 'google_conference', join_url: overrides.joinUrl ?? 'https://meet.google.com/abc' },
      },
    },
  });
}

function buildInviteeCanceledBody(overrides: {
  inviteeId?: string;
  scheduledEventId?: string;
  email?: string;
  utmContent?: string;
} = {}): string {
  const inviteeId = overrides.inviteeId ?? 'invitee-uuid-bbb';
  const scheduledEventId = overrides.scheduledEventId ?? 'event-uuid-yyy';
  return JSON.stringify({
    event: 'invitee.canceled',
    payload: {
      uri: `https://api.calendly.com/scheduled_events/${scheduledEventId}/invitees/${inviteeId}`,
      name: 'Calendly Lead',
      email: overrides.email ?? 'attendee@example.com',
      timezone: 'America/New_York',
      rescheduled: false,
      cancel_url: 'https://calendly.com/cancellations/xyz',
      reschedule_url: 'https://calendly.com/reschedulings/xyz',
      status: 'canceled',
      cancellation: { canceled_by: 'Attendee', reason: 'Conflict', canceler_type: 'invitee' },
      tracking: { utm_content: overrides.utmContent ?? 'lead-42' },
      scheduled_event: {
        uri: `https://api.calendly.com/scheduled_events/${scheduledEventId}`,
        name: '30 Minute Meeting',
        start_time: '2026-05-01T10:00:00Z',
        end_time: '2026-05-01T10:30:00Z',
      },
    },
  });
}

const PRESERVED_ENV_KEYS = [
  'NODE_ENV',
  'APP_ENV',
  'CALENDLY_WEBHOOK_SECRET',
  'CALENDLY_WEBHOOK_ALLOW_UNSIGNED',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of PRESERVED_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string>)[k] = v;
  }
}

describe('POST /book-demo/calendly-webhook — signature verification', () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = snapshotEnv();
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED;
  });

  afterEach(() => {
    restoreEnv(original);
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('accepts a valid Calendly signature and processes invitee.created', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'attendee@example.com',
        payload: {},
        name: 'Calendly Lead',
        company: 'Calendly Co',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = buildInviteeCreatedBody({ utmContent: 'lead-42' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 42, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(42);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    const [, booking] = mocks.attachBookingToLeadById.mock.calls[0]!;
    expect(booking).toMatchObject({
      provider: 'calendly',
      eventType: 'created',
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T10:30:00Z',
      timezone: 'America/New_York',
      attendeeEmail: 'attendee@example.com',
      meetingUrl: 'https://meet.google.com/abc',
    });
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when the signature header is missing', async () => {
    const { app, mocks } = await buildApp();
    const body = buildInviteeCreatedBody();
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Missing signature' });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature header is malformed (no v1)', async () => {
    const { app, mocks } = await buildApp();
    const body = buildInviteeCreatedBody();
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', `t=${Math.floor(Date.now() / 1000)}`)
      .send(body);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid signature format' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature does not match the body', async () => {
    const { app, mocks } = await buildApp();
    const body = buildInviteeCreatedBody();
    const wrong = signCalendly(body, 'a-different-secret-entirely');
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', wrong)
      .send(body);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid signature' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature timestamp is older than the 5-minute tolerance', async () => {
    const { app, mocks } = await buildApp();
    const body = buildInviteeCreatedBody();
    const stale = signCalendly(body, TEST_SECRET, Math.floor(Date.now() / 1000) - 60 * 60);
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', stale)
      .send(body);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Signature timestamp out of tolerance' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('accepts a signature header that lists multiple v1 values during key rotation', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'attendee@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = buildInviteeCreatedBody({ utmContent: 'lead-7' });
    const t = Math.floor(Date.now() / 1000);
    const goodHmac = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(Buffer.from(`${t}.${body}`, 'utf8'))
      .digest('hex');
    const fakeOld = '0'.repeat(goodHmac.length);
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', `t=${t},v1=${fakeOld},v1=${goodHmac}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 7, duplicate: false });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when CALENDLY_WEBHOOK_SECRET is missing in production-like env (no unsigned escape hatch)', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    delete process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED;
    const { app, mocks } = await buildApp();
    const body = buildInviteeCreatedBody();
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Webhook secret not configured' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('accepts unsigned requests when CALENDLY_WEBHOOK_ALLOW_UNSIGNED=1 outside production', async () => {
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED = '1';
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'attendee@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = buildInviteeCreatedBody({ utmContent: 'lead-99' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 99, duplicate: false });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
  });
});

describe('POST /book-demo/calendly-webhook — lead resolution', () => {
  let original: Record<string, string | undefined>;
  beforeEach(() => {
    original = snapshotEnv();
    vi.resetModules();
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED;
  });
  afterEach(() => {
    restoreEnv(original);
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('invitee.created resolves the lead via tracking.utm_content (lead-<id>) without falling back to email', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'lead@example.com',
        payload: {},
        name: 'Lead Person',
        company: 'Lead Co',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = buildInviteeCreatedBody({ email: 'attendee-different@example.com', utmContent: 'lead-99' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 99, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(99);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ provider: 'calendly', eventType: 'created' }),
    );
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.findLatestLeadByEmail).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    const [notifyEmail] = mocks.notifyBookingConfirmed.mock.calls[0]!;
    expect(notifyEmail).toBe('lead@example.com');
  });

  it('falls back to email lookup when tracking.utm_content is missing entirely', async () => {
    const { app, mocks } = await buildApp({
      attachBookingToLead: vi.fn(async () => ({ leadId: 17, duplicate: false })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 17,
        payload: {},
        name: 'Email Lead',
        company: 'Email Co',
      })),
    });
    const body = buildInviteeCreatedBody({ email: 'fallback@example.com', utmContent: null });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 17, duplicate: false });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).toHaveBeenCalledWith(
      'fallback@example.com',
      expect.objectContaining({ provider: 'calendly', eventType: 'created' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![0]).toBe('fallback@example.com');
  });

  it('falls back to email lookup when the tracked lead id references an unknown lead', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async () => null),
      attachBookingToLead: vi.fn(async () => ({ leadId: 23, duplicate: false })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 23,
        payload: {},
        name: 'Recovered',
        company: 'Recovered Co',
      })),
    });
    const body = buildInviteeCreatedBody({ email: 'orphan@example.com', utmContent: 'lead-999999' });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 23, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(999999);
    expect(mocks.attachBookingToLead).toHaveBeenCalledWith(
      'orphan@example.com',
      expect.objectContaining({ provider: 'calendly', eventType: 'created' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('acknowledges without action when tracking id is missing AND there is no usable attendee email', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        uri: 'https://api.calendly.com/scheduled_events/e/invitees/i',
        name: 'No Email',
        scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/e' },
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
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('silently acknowledges unsupported event types (e.g. routing form submissions)', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({ event: 'routing_form_submission.created', payload: {} });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});

describe('POST /book-demo/calendly-webhook — eventType mapping', () => {
  let original: Record<string, string | undefined>;
  beforeEach(() => {
    original = snapshotEnv();
    vi.resetModules();
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    restoreEnv(original);
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('maps invitee.canceled → eventType "cancelled" and still notifies the sales team', async () => {
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
    const body = buildInviteeCanceledBody({ email: 'cancel@example.com', utmContent: 'lead-5' });
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
    const [, booking] = mocks.notifyBookingConfirmed.mock.calls[0]!;
    expect(booking).toMatchObject({ provider: 'calendly', eventType: 'cancelled' });
  });

  it('maps invitee.created with payload.rescheduled === true → eventType "rescheduled"', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'resched@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = buildInviteeCreatedBody({
      email: 'resched@example.com',
      utmContent: 'lead-8',
      rescheduled: true,
      startTime: '2026-06-01T12:00:00Z',
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ provider: 'calendly', eventType: 'rescheduled' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![1]).toMatchObject({ eventType: 'rescheduled' });
  });
});

describe('POST /book-demo/calendly-webhook — idempotency', () => {
  let original: Record<string, string | undefined>;
  beforeEach(() => {
    original = snapshotEnv();
    vi.resetModules();
    process.env.CALENDLY_WEBHOOK_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    restoreEnv(original);
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('does NOT re-send the booking-confirmed notification when storage reports a duplicate (tracking lead id path)', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'dup@example.com',
        payload: {},
        name: 'Dup',
        company: 'Dup Co',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: true })),
    });
    const body = buildInviteeCreatedBody({ email: 'dup@example.com', utmContent: 'lead-11' });
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

  it('does NOT re-send the booking-confirmed notification when storage reports a duplicate (email fallback path)', async () => {
    const { app, mocks } = await buildApp({
      attachBookingToLead: vi.fn(async () => ({ leadId: 21, duplicate: true })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 21,
        payload: {},
        name: null,
        company: null,
      })),
    });
    const body = buildInviteeCreatedBody({ email: 'dup-email@example.com', utmContent: null });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 21, duplicate: true });
    expect(mocks.attachBookingToLead).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});
