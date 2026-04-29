/**
 * End-to-end integration test for the booking calendar webhook.
 *
 * The sibling unit suites (`calendlyBookingWebhook.test.ts`,
 * `calcomBookingWebhook.test.ts`) mock `marketing-leads` so they only prove
 * the route + signature verifier + event mapper work in isolation. They do
 * NOT prove that:
 *
 *   1. The booking actually round-trips into the `marketing_leads.payload`
 *      JSON column (so the Sales Inbox UI sees it).
 *   2. The `bookingHistory` array is appended on lifecycle events (created
 *      → cancelled).
 *   3. The duplicate-detection inside `attachBookingTo*` actually prevents
 *      double-append on retry deliveries (Calendly / Cal.com both retry on
 *      transient failures, so this is a real production scenario).
 *   4. The sales-alert email pipeline (`sendEmail`) actually picks up the
 *      booking event and fires.
 *
 * Calendly is the riskier of the two providers because the lead-id is
 * carried via `tracking.utm_content=lead-<id>` (a string round-trip)
 * instead of a typed `metadata.leadId` field — a regression in URL
 * encoding or the regex parser would silently lose the lead<->booking
 * link. So we exercise BOTH providers in the same suite to catch
 * cross-provider regressions in the shared `dispatchBookingWebhook`
 * pipeline.
 *
 * The Postgres backend is `pg-mem` (already used by
 * `tests/security/backfillDispatchJobGeocodes.test.ts`) so the SQL in
 * `marketing-leads.ts` is exercised exactly as it ships, not re-mocked
 * through a stub client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { newDb } from 'pg-mem';

const WEBHOOK_PATH = '/book-demo/calendar-webhook';
const CALENDLY_SECRET = 'test_calendly_secret_integration';
const CALCOM_SECRET = 'test_calcom_secret_integration';

// ---------------------------------------------------------------------------
// Signature helpers — copied verbatim from the unit-level suites so the test
// is self-contained and doesn't drift if we ever refactor the verifier.
// ---------------------------------------------------------------------------
function signCalendly(body: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac('sha256', CALENDLY_SECRET)
    .update(`${ts}.${body}`)
    .digest('hex');
  return `t=${ts},v1=${sig}`;
}

function signCalcom(body: string, ts: number = Math.floor(Date.now() / 1000)): { sig: string; ts: number } {
  const sig = crypto.createHmac('sha256', CALCOM_SECRET).update(`${ts}.${body}`).digest('hex');
  return { sig, ts };
}

// ---------------------------------------------------------------------------
// Test fixture: spin up an in-process Postgres via pg-mem, mock the
// platform-db getter so the real `marketing-leads` service runs against it,
// pre-seed the schema and the sales-alert settings, and stub the email +
// slack sinks so we can assert what the alert pipeline tried to send.
// ---------------------------------------------------------------------------

interface Fixture {
  app: express.Express;
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  sendEmailMock: ReturnType<typeof vi.fn>;
  postSlackMock: ReturnType<typeof vi.fn>;
  fetchLead: (id: number) => Promise<{
    id: number;
    payload: Record<string, unknown>;
    notified: boolean;
  } | null>;
  insertLead: (lead: { name: string; email: string; company: string }) => Promise<number>;
  teardown: () => Promise<void>;
}

const activeFixtures: Fixture[] = [];

async function buildFixture(): Promise<Fixture> {
  // ---- 1. Build the in-memory Postgres + schema --------------------------
  const mem = newDb();

  // Mirror the production schema exactly — the marketing-leads service
  // creates these lazily via `ensureTable()` on first call, but pg-mem can
  // be picky about multi-clause `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  // so we pre-create the tables with the final shape and let the service's
  // `CREATE TABLE IF NOT EXISTS` short-circuit harmlessly.
  mem.public.none(`
    CREATE TABLE marketing_leads (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      company TEXT,
      phone TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      notified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'new',
      status_notes TEXT,
      status_updated_at TIMESTAMPTZ,
      status_updated_by TEXT
    );
    CREATE TABLE marketing_lead_events (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT,
      notes TEXT,
      author TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    );
  `);

  // Seed sales-alert settings with a real recipient so the email pipeline
  // actually fires (the default settings have no recipients, which would
  // make `sendEmail` a no-op and defeat the purpose of asserting it ran).
  mem.public.none(`
    INSERT INTO platform_settings (key, value)
    VALUES ('sales_alert_settings', '{
      "channels": { "email": true, "slack": false },
      "emailRecipients": ["sales-inbox@qvo.test"],
      "slackWebhookUrl": null,
      "notifyOnNewLead": true,
      "notifyOnBookingCreated": true,
      "notifyOnBookingRescheduled": true,
      "notifyOnBookingCancelled": true
    }'::jsonb);
  `);

  const { Pool } = mem.adapters.createPg();
  const rawPool = new Pool();

  // pg-mem rejects parts of the production `ensureTable` DDL with
  // "Not supported" because it doesn't fully model multi-statement DDL
  // when a CHECK constraint references columns. Since we already created
  // the schema above, intercept that one bootstrap query and treat it as
  // a no-op. All other queries (the ones we actually want to exercise)
  // pass through unchanged.
  const ENSURE_TABLE_MARKER = 'CREATE TABLE IF NOT EXISTS marketing_leads';
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(ENSURE_TABLE_MARKER)) {
        return { rows: [], rowCount: 0 };
      }
      return rawPool.query(sql, params);
    },
    end: () => rawPool.end(),
  };

  // ---- 2. Mock the platform infrastructure --------------------------------
  // Replace `platform/db` so the marketing-leads service's `getPlatformPool`
  // returns our pg-mem-backed Pool. Both `marketing-leads.ts` and
  // `sales-alert-settings.ts` import from this module.
  vi.doMock('../../platform/db', () => ({
    getPlatformPool: () => pool,
  }));

  // Capture every email the alert pipeline tries to send so we can assert
  // the booking actually triggered the sales-alert email (the second
  // gap the integration test is supposed to close).
  const sendEmailMock = vi.fn(async () => ({ success: true, messageId: 'mock-message-id' }));
  vi.doMock('../../platform/email/EmailService', () => ({
    sendEmail: sendEmailMock,
  }));

  // Slack channel is disabled in our seed settings, but mock the notifier
  // anyway so an accidental real fetch can't escape during the test run.
  const postSlackMock = vi.fn(async () => ({ success: false, skipped: true }));
  vi.doMock('../../platform/messaging/SlackWebhookNotifier', () => ({
    postToOpsSlackWebhook: postSlackMock,
    getOpsSlackWebhookUrl: () => null,
  }));

  // ---- 3. Mount the real router against the mocked pool ------------------
  const router = (await import('../../server/admin-api/routes/contact')).default;
  const app = express();
  // Mirror the production mount in server/admin-api/app.ts — the webhook
  // path needs the raw body for HMAC verification, the rest of the router
  // takes JSON.
  app.use(WEBHOOK_PATH, express.raw({ type: 'application/json' }));
  app.use('/book-demo/calendly-webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/', router);

  async function fetchLead(id: number) {
    const r = await pool.query(
      `SELECT id, payload, notified FROM marketing_leads WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      payload: (row.payload as Record<string, unknown>) ?? {},
      notified: Boolean(row.notified),
    };
  }

  async function insertLead(lead: { name: string; email: string; company: string }): Promise<number> {
    const r = await pool.query(
      `INSERT INTO marketing_leads (source, name, email, company, payload)
       VALUES ('book_demo', $1, $2, $3, '{}'::jsonb) RETURNING id`,
      [lead.name, lead.email, lead.company],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  const fixture: Fixture = {
    app,
    pool: pool as unknown as Fixture['pool'],
    sendEmailMock,
    postSlackMock,
    fetchLead,
    insertLead,
    teardown: async () => {
      try {
        await rawPool.end();
      } catch {
        // pg-mem's end() is idempotent in practice, but swallow any
        // double-end errors so test cleanup never masks a real failure.
      }
    },
  };
  activeFixtures.push(fixture);
  return fixture;
}

// ---------------------------------------------------------------------------
// Calendly payload helpers
// ---------------------------------------------------------------------------
function calendlyInviteeCreatedBody(opts: {
  leadId: number;
  email: string;
  name?: string;
  inviteeUri?: string;
  scheduledEventUri?: string;
  startTime?: string;
  endTime?: string;
}): string {
  return JSON.stringify({
    event: 'invitee.created',
    payload: {
      email: opts.email,
      name: opts.name ?? 'Integration Tester',
      uri: opts.inviteeUri ?? 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-CREATED',
      cancel_url: 'https://calendly.com/cancellations/INV-CREATED',
      reschedule_url: 'https://calendly.com/reschedulings/INV-CREATED',
      timezone: 'America/Los_Angeles',
      tracking: { utm_content: `lead-${opts.leadId}` },
      scheduled_event: {
        uri: opts.scheduledEventUri ?? 'https://api.calendly.com/scheduled_events/EVT',
        name: '30 Minute Demo',
        start_time: opts.startTime ?? '2026-05-01T10:00:00Z',
        end_time: opts.endTime ?? '2026-05-01T10:30:00Z',
        location: { type: 'zoom', join_url: 'https://zoom.us/j/integration' },
      },
    },
  });
}

function calendlyInviteeCanceledBody(opts: {
  leadId: number;
  email: string;
  inviteeUri?: string;
  scheduledEventUri?: string;
}): string {
  return JSON.stringify({
    event: 'invitee.canceled',
    payload: {
      email: opts.email,
      name: 'Integration Tester',
      uri: opts.inviteeUri ?? 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-CANCELED',
      cancel_url: 'https://calendly.com/cancellations/INV-CANCELED',
      reschedule_url: 'https://calendly.com/reschedulings/INV-CANCELED',
      timezone: 'America/Los_Angeles',
      tracking: { utm_content: `lead-${opts.leadId}` },
      cancellation: { canceled_by: 'invitee', reason: 'Schedule conflict' },
      scheduled_event: {
        uri: opts.scheduledEventUri ?? 'https://api.calendly.com/scheduled_events/EVT',
        name: '30 Minute Demo',
        start_time: '2026-05-01T10:00:00Z',
        end_time: '2026-05-01T10:30:00Z',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Cal.com payload helpers
// ---------------------------------------------------------------------------
function calcomBookingBody(opts: {
  triggerEvent: 'BOOKING_CREATED' | 'BOOKING_CANCELLED' | 'BOOKING_RESCHEDULED';
  leadId: number;
  email: string;
  uid?: string;
  bookingId?: string;
}): string {
  return JSON.stringify({
    triggerEvent: opts.triggerEvent,
    payload: {
      uid: opts.uid ?? `uid-${opts.triggerEvent.toLowerCase()}`,
      bookingId: opts.bookingId ?? `bid-${opts.triggerEvent.toLowerCase()}`,
      startTime: '2026-05-02T15:00:00Z',
      endTime: '2026-05-02T15:30:00Z',
      attendees: [{ email: opts.email, name: 'Cal.com Integration Tester', timeZone: 'UTC' }],
      videoCallData: { url: 'https://meet.cal.com/integration' },
      metadata: { leadId: opts.leadId },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /book-demo/calendar-webhook — end-to-end integration (Postgres + email)', () => {
  const ORIGINAL_ENV = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    SALES_NOTIFICATION_EMAIL: process.env.SALES_NOTIFICATION_EMAIL,
    SALES_EMAIL: process.env.SALES_EMAIL,
    OPS_SLACK_WEBHOOK_URL: process.env.OPS_SLACK_WEBHOOK_URL,
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
    SLACK_WEBHOOK: process.env.SLACK_WEBHOOK,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.CALENDLY_WEBHOOK_SECRET = CALENDLY_SECRET;
    process.env.CALCOM_WEBHOOK_SECRET = CALCOM_SECRET;
    // Clear env-var fallbacks so the only email recipient comes from our
    // seeded `platform_settings.sales_alert_settings` row — that's what we
    // want to prove the alert pipeline actually reads.
    delete process.env.SALES_NOTIFICATION_EMAIL;
    delete process.env.SALES_EMAIL;
    delete process.env.OPS_SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK;
  });

  afterEach(async () => {
    // Tear down every fixture this test created so the underlying pg-mem
    // Pool releases its handles — important once this suite is run inside
    // a larger CI batch where leaked handles can keep vitest's worker alive.
    while (activeFixtures.length) {
      const f = activeFixtures.pop()!;
      await f.teardown();
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
    vi.doUnmock('../../platform/email/EmailService');
    vi.doUnmock('../../platform/messaging/SlackWebhookNotifier');
  });

  it('Calendly: round-trips invitee.created into payload.booking, appends bookingHistory on cancel, and is idempotent on retry', async () => {
    const fx = await buildFixture();
    const leadId = await fx.insertLead({
      name: 'Calendly Lead',
      email: 'calendly-lead@example.com',
      company: 'Calendly Co',
    });

    // ---- 1. invitee.created → booking persisted, alert email sent --------
    const createdBody = calendlyInviteeCreatedBody({
      leadId,
      // Deliberately use a different invitee email than the lead row to
      // prove the route really resolves via tracking.utm_content (the
      // string round-trip the task highlights as risky), not via email.
      email: 'invitee-different@example.com',
    });
    const createdRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(createdBody))
      .send(createdBody);

    expect(createdRes.status).toBe(200);
    expect(createdRes.body).toMatchObject({ ok: true, leadId, duplicate: false });

    let lead = await fx.fetchLead(leadId);
    expect(lead).not.toBeNull();
    const booking = (lead!.payload as { booking?: Record<string, unknown> }).booking;
    expect(booking).toBeDefined();
    expect(booking).toMatchObject({
      provider: 'calendly',
      eventType: 'created',
      bookingUid: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-CREATED',
      bookingId: 'https://api.calendly.com/scheduled_events/EVT',
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T10:30:00Z',
      timezone: 'America/Los_Angeles',
      meetingUrl: 'https://zoom.us/j/integration',
      attendeeEmail: 'invitee-different@example.com',
    });
    let history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    expect(Array.isArray(history)).toBe(true);
    expect(history!).toHaveLength(1);

    // The sales-alert email pipeline should have fired exactly once, using
    // the *lead's* email as the reply-to (not the invitee's), and the
    // recipient should be the one we seeded in `platform_settings`.
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(1);
    const firstSend = fx.sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      replyTo?: string;
    };
    expect(firstSend.to).toBe('sales-inbox@qvo.test');
    expect(firstSend.subject).toMatch(/Demo booked/i);
    expect(firstSend.replyTo).toBe('calendly-lead@example.com');
    // After a successful send the lead is flagged as notified so a second
    // booking-created event can't re-spam the inbox.
    expect(lead!.notified).toBe(true);

    // ---- 2. invitee.canceled → bookingHistory appended (length 2) -------
    const cancelBody = calendlyInviteeCanceledBody({
      leadId,
      email: 'invitee-different@example.com',
    });
    const cancelRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(cancelBody))
      .send(cancelBody);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toMatchObject({ ok: true, leadId, duplicate: false });

    lead = await fx.fetchLead(leadId);
    history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    expect(history).toHaveLength(2);
    const lastEntry = history![1] as { eventType?: string; bookingUid?: string };
    expect(lastEntry.eventType).toBe('cancelled');
    expect(lastEntry.bookingUid).toBe(
      'https://api.calendly.com/scheduled_events/EVT/invitees/INV-CANCELED',
    );
    // The "current booking" pointer also advances to the cancellation row
    // so the Sales Inbox shows the latest lifecycle state.
    expect((lead!.payload as { booking?: { eventType?: string } }).booking?.eventType).toBe('cancelled');

    // Cancellation also fires its own alert email (so reps know the meeting
    // isn't happening). This brings the total to 2 sends.
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(2);
    expect((fx.sendEmailMock.mock.calls[1]![0] as { subject: string }).subject).toMatch(/Demo cancelled/i);

    // ---- 3. Retry the SAME invitee.canceled → duplicate, no double-append
    // Calendly retries the same event on transient errors; the
    // attachBookingToLeadById dedupe path must collapse the retry.
    const retryRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(cancelBody))
      .send(cancelBody);

    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toMatchObject({ ok: true, leadId, duplicate: true });

    lead = await fx.fetchLead(leadId);
    history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    // Critical assertion: history length is still 2, not 3.
    expect(history).toHaveLength(2);
    // No additional email was sent for the duplicate retry.
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it('Calendly: when utm_content is missing, falls back to invitee email lookup and still persists the booking', async () => {
    const fx = await buildFixture();
    // Pre-existing lead row with a known email; invitee will match by email.
    const leadId = await fx.insertLead({
      name: 'Email Fallback Lead',
      email: 'fallback@example.com',
      company: 'Fallback Co',
    });

    const body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        email: 'fallback@example.com', // matches the seeded lead
        name: 'Fallback Tester',
        uri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-FB',
        cancel_url: 'https://calendly.com/cancellations/INV-FB',
        reschedule_url: 'https://calendly.com/reschedulings/INV-FB',
        timezone: 'UTC',
        tracking: {}, // no utm_content → falls back to email path
        scheduled_event: {
          uri: 'https://api.calendly.com/scheduled_events/EVT-FB',
          name: '30 Minute Demo',
          start_time: '2026-05-03T09:00:00Z',
          end_time: '2026-05-03T09:30:00Z',
          location: { type: 'physical', location: 'On-site' },
        },
      },
    });

    const r = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', signCalendly(body))
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId, duplicate: false });

    const lead = await fx.fetchLead(leadId);
    expect(
      (lead!.payload as { booking?: { provider?: string; bookingUid?: string } }).booking,
    ).toMatchObject({
      provider: 'calendly',
      bookingUid: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV-FB',
    });
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('Cal.com: round-trips BOOKING_CREATED, appends BOOKING_CANCELLED, and is idempotent on retry', async () => {
    const fx = await buildFixture();
    const leadId = await fx.insertLead({
      name: 'Cal.com Lead',
      email: 'calcom-lead@example.com',
      company: 'Cal.com Co',
    });

    // ---- 1. BOOKING_CREATED → booking persisted ---------------------------
    const createdBody = calcomBookingBody({
      triggerEvent: 'BOOKING_CREATED',
      leadId,
      email: 'calcom-attendee@example.com',
      uid: 'uid-calcom-created',
      bookingId: 'bid-calcom-created',
    });
    const createdSig = signCalcom(createdBody);
    const createdRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', createdSig.sig)
      .set('x-cal-timestamp', String(createdSig.ts))
      .send(createdBody);

    expect(createdRes.status).toBe(200);
    expect(createdRes.body).toMatchObject({ ok: true, leadId, duplicate: false });

    let lead = await fx.fetchLead(leadId);
    expect((lead!.payload as { booking?: Record<string, unknown> }).booking).toMatchObject({
      provider: 'cal.com',
      eventType: 'created',
      bookingUid: 'uid-calcom-created',
      bookingId: 'bid-calcom-created',
      meetingUrl: 'https://meet.cal.com/integration',
    });
    let history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    expect(history).toHaveLength(1);
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(1);

    // ---- 2. BOOKING_CANCELLED → appended, alert fires --------------------
    const cancelBody = calcomBookingBody({
      triggerEvent: 'BOOKING_CANCELLED',
      leadId,
      email: 'calcom-attendee@example.com',
      uid: 'uid-calcom-cancelled',
      bookingId: 'bid-calcom-cancelled',
    });
    const cancelSig = signCalcom(cancelBody);
    const cancelRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', cancelSig.sig)
      .set('x-cal-timestamp', String(cancelSig.ts))
      .send(cancelBody);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toMatchObject({ ok: true, leadId, duplicate: false });

    lead = await fx.fetchLead(leadId);
    history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    expect(history).toHaveLength(2);
    expect((history![1] as { eventType?: string }).eventType).toBe('cancelled');
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(2);

    // ---- 3. Retry of the SAME BOOKING_CANCELLED → duplicate, no append ---
    // Re-sign with a fresh timestamp (replay window guard) but the same
    // payload — the dedupe key is (eventType + bookingUid/bookingId) so
    // marketing-leads must still recognise it.
    const retrySig = signCalcom(cancelBody);
    const retryRes = await request(fx.app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', retrySig.sig)
      .set('x-cal-timestamp', String(retrySig.ts))
      .send(cancelBody);

    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toMatchObject({ ok: true, leadId, duplicate: true });

    lead = await fx.fetchLead(leadId);
    history = (lead!.payload as { bookingHistory?: unknown[] }).bookingHistory;
    expect(history).toHaveLength(2);
    expect(fx.sendEmailMock).toHaveBeenCalledTimes(2);
  });
});
