import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const WEBHOOK_PATH = '/book-demo/calendar-webhook';
const TEST_SECRET = 'test_calcom_webhook_secret_value_123';

function signBody(body: string, secret: string = TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
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

describe('POST /book-demo/calendar-webhook — signature verification', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALCOM_WEBHOOK_ALLOW_UNSIGNED: process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.CALCOM_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('accepts a valid signature and processes the event', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'attendee@example.com',
        payload: {},
        name: 'Attendee',
        company: 'Acme',
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-1',
        bookingId: 'bid-1',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T10:30:00Z',
        attendees: [{ email: 'attendee@example.com', name: 'Attendee', timeZone: 'UTC' }],
        metadata: { leadId: 42 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 42, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(42);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('also accepts the sha256= prefixed signature header form', async () => {
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
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-2',
        bookingId: 'bid-2',
        attendees: [{ email: 'attendee@example.com' }],
        metadata: { leadId: 7 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', `sha256=${signBody(body)}`)
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when the signature header is missing', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: { attendees: [{ email: 'a@example.com' }], metadata: { leadId: 1 } },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Missing signature' });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature is malformed', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: { attendees: [{ email: 'a@example.com' }], metadata: { leadId: 1 } },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', 'not-a-hex-string')
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid signature format' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature does not match the body', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: { attendees: [{ email: 'a@example.com' }], metadata: { leadId: 1 } },
    });
    const wrongSig = signBody(body, 'a-different-secret-entirely');
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', wrongSig)
      .send(body);

    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Invalid signature' });
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
  });
});

describe('POST /book-demo/calendar-webhook — lead resolution', () => {
  const ORIGINAL = {
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALCOM_WEBHOOK_ALLOW_UNSIGNED: process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_WEBHOOK_SECRET = TEST_SECRET;
    delete process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('BOOKING_CREATED resolves the lead via metadata.leadId without falling back to email', async () => {
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
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-meta',
        bookingId: 'bid-meta',
        startTime: '2026-05-01T10:00:00Z',
        attendees: [{ email: 'attendee-different@example.com', name: 'Different', timeZone: 'UTC' }],
        metadata: { leadId: '99' },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 99, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(99);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ eventType: 'created', bookingUid: 'uid-meta' }),
    );
    // Email fallback path should not run when metadata.leadId resolved.
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.findLatestLeadByEmail).not.toHaveBeenCalled();
    // Notification still fires using the resolved lead's email.
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    const [notifyEmail] = mocks.notifyBookingConfirmed.mock.calls[0]!;
    expect(notifyEmail).toBe('lead@example.com');
  });

  it('falls back to email lookup when metadata.leadId is missing entirely', async () => {
    const { app, mocks } = await buildApp({
      attachBookingToLead: vi.fn(async () => ({ leadId: 17, duplicate: false })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 17,
        payload: {},
        name: 'Email Lead',
        company: 'Email Co',
      })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-email',
        bookingId: 'bid-email',
        attendees: [{ email: 'fallback@example.com', name: 'Fallback', timeZone: 'UTC' }],
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 17, duplicate: false });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).toHaveBeenCalledWith(
      'fallback@example.com',
      expect.objectContaining({ eventType: 'created' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![0]).toBe('fallback@example.com');
  });

  it('falls back to email lookup when metadata.leadId references an unknown lead', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async () => null), // metadata id does not match any lead
      attachBookingToLead: vi.fn(async () => ({ leadId: 23, duplicate: false })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 23,
        payload: {},
        name: 'Recovered',
        company: 'Recovered Co',
      })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-orphan',
        bookingId: 'bid-orphan',
        attendees: [{ email: 'orphan@example.com', name: 'Orphan' }],
        metadata: { leadId: 999999 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 23, duplicate: false });
    expect(mocks.findLeadById).toHaveBeenCalledWith(999999);
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).toHaveBeenCalledWith(
      'orphan@example.com',
      expect.objectContaining({ eventType: 'created' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('acknowledges without action when metadata.leadId is missing AND there is no usable attendee email', async () => {
    const { app, mocks } = await buildApp();
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-empty',
        bookingId: 'bid-empty',
        attendees: [{ name: 'No Email' }],
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true });
    expect(mocks.findLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.attachBookingToLead).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});

describe('POST /book-demo/calendar-webhook — eventType mapping', () => {
  const ORIGINAL = {
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('maps BOOKING_CANCELLED → eventType "cancelled" and still notifies the sales team', async () => {
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
      triggerEvent: 'BOOKING_CANCELLED',
      payload: {
        uid: 'uid-cancel',
        bookingId: 'bid-cancel',
        attendees: [{ email: 'cancel@example.com' }],
        metadata: { leadId: 5 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ eventType: 'cancelled' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    const [, booking] = mocks.notifyBookingConfirmed.mock.calls[0]!;
    expect(booking).toMatchObject({ eventType: 'cancelled' });
  });

  it('maps BOOKING_REJECTED → eventType "cancelled"', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'reject@example.com',
        payload: {},
        name: null,
        company: null,
      })),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_REJECTED',
      payload: {
        uid: 'uid-reject',
        bookingId: 'bid-reject',
        attendees: [{ email: 'reject@example.com' }],
        metadata: { leadId: 6 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      6,
      expect.objectContaining({ eventType: 'cancelled' }),
    );
  });

  it('maps BOOKING_RESCHEDULED → eventType "rescheduled"', async () => {
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
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_RESCHEDULED',
      payload: {
        uid: 'uid-resched',
        bookingId: 'bid-resched',
        startTime: '2026-06-01T12:00:00Z',
        attendees: [{ email: 'resched@example.com' }],
        metadata: { leadId: 8 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledWith(
      8,
      expect.objectContaining({ eventType: 'rescheduled' }),
    );
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed.mock.calls[0]![1]).toMatchObject({ eventType: 'rescheduled' });
  });
});

describe('POST /book-demo/calendar-webhook — idempotency', () => {
  const ORIGINAL = {
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.CALCOM_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('does NOT re-send the booking-confirmed notification when the storage layer reports a duplicate (metadata.leadId path)', async () => {
    const { app, mocks } = await buildApp({
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'dup@example.com',
        payload: {},
        name: 'Dup',
        company: 'Dup Co',
      })),
      // Service signals it has already recorded this exact booking event.
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: true })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-dup',
        bookingId: 'bid-dup',
        attendees: [{ email: 'dup@example.com' }],
        metadata: { leadId: 11 },
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 11, duplicate: true });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('does NOT re-send the booking-confirmed notification when the storage layer reports a duplicate (email fallback path)', async () => {
    const { app, mocks } = await buildApp({
      attachBookingToLead: vi.fn(async () => ({ leadId: 21, duplicate: true })),
      findLatestLeadByEmail: vi.fn(async () => ({
        id: 21,
        payload: {},
        name: null,
        company: null,
      })),
    });
    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-dup-email',
        bookingId: 'bid-dup-email',
        attendees: [{ email: 'dup-email@example.com' }],
      },
    });
    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', signBody(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 21, duplicate: true });
    expect(mocks.attachBookingToLead).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});
