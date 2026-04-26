import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract checks -------------------------------------------------
//
// Lock down the wire shape between the new "Bounced recipients" panel in
// PlatformAdmin and the admin API. The endpoint reuses the shared
// isPermanentSmtpError() classifier (same one the manual /retry handler and
// the SupportReplyRetryScheduler use) so the panel always agrees with the
// per-reply badge admins already see inside a ticket.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('/support/replies/bounced-recipients — endpoint contract', () => {
  it('mounts the new GET endpoint guarded by requireAuth + requirePlatformAdmin', () => {
    expect(supportFile).toMatch(
      /router\.get\(\s*['"]\/support\/replies\/bounced-recipients['"][\s\S]*?requireAuth[\s\S]*?requirePlatformAdmin/,
    );
  });

  it('reuses the shared isPermanentSmtpError classifier rather than reimplementing it', () => {
    // Find the bounced-recipients handler block and assert the classifier is
    // called inside it.
    const start = supportFile.indexOf("'/support/replies/bounced-recipients'");
    expect(start).toBeGreaterThan(-1);
    const after = supportFile.slice(start, start + 4000);
    expect(after).toMatch(/isPermanentSmtpError\(/);
  });

  it('joins support_ticket_replies to support_tickets to surface the recipient email per failure', () => {
    expect(supportFile).toMatch(/FROM support_ticket_replies r[\s\S]*?JOIN support_tickets t/);
  });

  it('only considers outbound replies that actually recorded a delivery error', () => {
    const start = supportFile.indexOf("'/support/replies/bounced-recipients'");
    const after = supportFile.slice(start, start + 4000);
    expect(after).toMatch(/r\.direction = 'outbound'/);
    expect(after).toMatch(/r\.email_error IS NOT NULL/);
  });
});

describe('PlatformAdmin SupportInboxTab — bounced recipients panel', () => {
  it('renders a Bounced recipients panel inside the support inbox', () => {
    expect(adminUiFile).toMatch(/BouncedRecipientsPanel/);
    expect(adminUiFile).toMatch(/Bounced recipients/);
  });

  it('fetches /support/replies/bounced-recipients to populate the panel', () => {
    expect(adminUiFile).toMatch(
      /\/support\/replies\/bounced-recipients/,
    );
  });

  it('lets the admin jump from a bounced row back to the affected ticket', () => {
    expect(adminUiFile).toMatch(/onOpenTicket/);
    expect(adminUiFile).toMatch(/Open ticket/);
  });

  it('exposes a Clear alert button in the panel that hits the new DELETE endpoint', () => {
    // The button is what lets ops re-arm the per-recipient first-bounce
    // alert after they've fixed the underlying issue. Without it, a once-
    // bounced + recovered address would silently miss future bounces.
    expect(adminUiFile).toMatch(/Clear alert/);
    expect(adminUiFile).toMatch(
      /api\.delete[\s\S]{0,160}\/support\/replies\/bounced-recipients\/\$\{encodeURIComponent\([^)]+\)\}\/alert/,
    );
  });

  it('clears the Alerted badge optimistically without requiring a full refetch', () => {
    // Done looks like: "Clearing the alert removes the badge from the
    // panel without a full reload". Implementation pins the cached query
    // entry through setQueryData and flips alerted_at to null in place.
    expect(adminUiFile).toMatch(
      /setQueryData<BouncedRecipientsResponse>\([\s\S]*?'support-bounced-recipients'/,
    );
    expect(adminUiFile).toMatch(/alerted_at:\s*null/);
  });
});

describe('DELETE /support/replies/bounced-recipients/:email/alert — endpoint contract', () => {
  it('mounts a DELETE endpoint guarded by requireAuth + requirePlatformAdmin', () => {
    expect(supportFile).toMatch(
      /router\.delete\(\s*['"]\/support\/replies\/bounced-recipients\/:email\/alert['"][\s\S]*?requireAuth[\s\S]*?requirePlatformAdmin/,
    );
  });

  it('deletes from support_recipient_bounce_alerts keyed on lowercased email', () => {
    // Lowercasing has to match the dedup table's primary-key casing
    // (migration 074 stores email_lower). A future refactor that drops
    // the toLowerCase() would let mixed-case clears miss the row.
    const start = supportFile.indexOf(
      "'/support/replies/bounced-recipients/:email/alert'",
    );
    expect(start).toBeGreaterThan(-1);
    const after = supportFile.slice(start, start + 2000);
    expect(after).toMatch(/toLowerCase\(\)/);
    expect(after).toMatch(
      /DELETE FROM support_recipient_bounce_alerts[\s\S]*?WHERE email_lower = \$1/,
    );
  });
});

// ---- Runtime behavior -------------------------------------------------------
//
// Mock the platform DB and stub auth/RBAC so we can exercise the route
// directly. Verifies:
//   1. Permanent failures are aggregated by user_email
//   2. Transient failures (4yz / "connection refused") are excluded
//   3. Multiple failures on the same ticket roll up under one ticket entry
//   4. Auth + RBAC guards are wired correctly

vi.mock('../../platform/db', () => {
  const queryMock = vi.fn();
  return {
    __queryMock: queryMock,
    getPlatformPool: () => ({ query: queryMock }),
  };
});

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = {
      userId: '00000000-0000-0000-0000-000000000001',
      email: 'admin@qvo.ai',
      tenantId: null,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock('../../platform/help/DocsFeedbackAlertScheduler', () => ({
  runDocsFeedbackAlertCycle: vi.fn(),
  runDocsFeedbackPendingReplyAlertCycle: vi.fn(),
}));
vi.mock('../../platform/help/DocsFeedbackReplyDigestScheduler', () => ({
  runDocsFeedbackReplyDigestCycle: vi.fn(),
}));
vi.mock('../../platform/help/supportReplyRetryLimiter', () => ({
  tryReserveSupportReplyRetrySlot: async () => ({ allowed: true as const }),
  __setCooldownSecondsForTesting: () => {},
  __reloadCooldownFromEnvForTesting: () => {},
  __resetForTesting: async () => {},
  getSupportReplyRetryCooldownSeconds: () => 0,
}));

const router = (await import('../../server/admin-api/routes/support')).default;
const queryMock = (
  (await import('../../platform/db')) as unknown as {
    __queryMock: ReturnType<typeof vi.fn>;
  }
).__queryMock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const PATH = '/support/replies/bounced-recipients';

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /support/replies/bounced-recipients — runtime behavior', () => {
  it('aggregates permanent-failure replies by recipient email, newest first', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 4,
      rows: [
        // Two hard bounces for alice on the same ticket — should roll up under
        // one ticket entry with occurrence_count=2.
        {
          reply_id: 11,
          ticket_id: 'tkt_alice1',
          ticket_status: 'open',
          user_email: 'alice@example.com',
          email_error: '550 5.1.1 No such user',
          reply_created_at: '2026-04-26T11:00:00Z',
        },
        {
          reply_id: 10,
          ticket_id: 'tkt_alice1',
          ticket_status: 'open',
          user_email: 'alice@example.com',
          email_error: '550 mailbox not found',
          reply_created_at: '2026-04-26T10:30:00Z',
        },
        // One hard bounce for bob, on a different ticket — separate recipient
        // entry, more recent than alice so should sort first.
        {
          reply_id: 9,
          ticket_id: 'tkt_bob1',
          ticket_status: 'in_progress',
          user_email: 'bob@example.com',
          email_error: 'mailbox is full',
          reply_created_at: '2026-04-26T12:00:00Z',
        },
        // Transient (4yz) failure — must be excluded by the classifier even
        // though it mentions "address rejected".
        {
          reply_id: 8,
          ticket_id: 'tkt_carol1',
          ticket_status: 'open',
          user_email: 'carol@example.com',
          email_error: '450 4.2.1 mailbox temporarily unavailable, address rejected',
          reply_created_at: '2026-04-26T09:00:00Z',
        },
      ],
    });

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.recipients).toHaveLength(2);

    // Newest hard bounce first — bob (12:00) before alice (11:00).
    expect(r.body.recipients[0].user_email).toBe('bob@example.com');
    expect(r.body.recipients[0].occurrence_count).toBe(1);
    expect(r.body.recipients[0].ticket_count).toBe(1);
    expect(r.body.recipients[0].last_failure_at).toBe('2026-04-26T12:00:00Z');

    expect(r.body.recipients[1].user_email).toBe('alice@example.com');
    // Two failures rolled up.
    expect(r.body.recipients[1].occurrence_count).toBe(2);
    expect(r.body.recipients[1].ticket_count).toBe(1);
    expect(r.body.recipients[1].last_failure_at).toBe('2026-04-26T11:00:00Z');
    // The most recent of the two errors wins for last_error.
    expect(r.body.recipients[1].last_error).toBe('550 5.1.1 No such user');
    expect(r.body.recipients[1].tickets[0].ticket_id).toBe('tkt_alice1');
    expect(r.body.recipients[1].tickets[0].occurrence_count).toBe(2);

    // Carol should not appear at all — her failure was transient.
    const emails = r.body.recipients.map((rec: { user_email: string }) => rec.user_email);
    expect(emails).not.toContain('carol@example.com');

    expect(r.body.total).toBe(2);
    expect(r.body.truncated).toBe(false);
  });

  it('groups multiple tickets per recipient and lists them newest failure first', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 3,
      rows: [
        {
          reply_id: 21,
          ticket_id: 'tkt_dave1',
          ticket_status: 'open',
          user_email: 'dave@example.com',
          email_error: '550 user unknown',
          reply_created_at: '2026-04-26T10:00:00Z',
        },
        {
          reply_id: 22,
          ticket_id: 'tkt_dave2',
          ticket_status: 'in_progress',
          user_email: 'dave@example.com',
          email_error: '550 mailbox does not exist',
          reply_created_at: '2026-04-26T13:00:00Z',
        },
        {
          reply_id: 23,
          ticket_id: 'tkt_dave2',
          ticket_status: 'in_progress',
          user_email: 'dave@example.com',
          email_error: '550 user unknown',
          reply_created_at: '2026-04-26T12:00:00Z',
        },
      ],
    });

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.recipients).toHaveLength(1);

    const dave = r.body.recipients[0];
    expect(dave.user_email).toBe('dave@example.com');
    expect(dave.occurrence_count).toBe(3);
    expect(dave.ticket_count).toBe(2);
    // tkt_dave2 has the more recent failure (13:00) so it should sort first.
    expect(dave.tickets[0].ticket_id).toBe('tkt_dave2');
    expect(dave.tickets[0].occurrence_count).toBe(2);
    expect(dave.tickets[1].ticket_id).toBe('tkt_dave1');
    expect(dave.tickets[1].occurrence_count).toBe(1);
    expect(dave.tickets[0].last_failure_at).toBe('2026-04-26T13:00:00Z');
  });

  it('returns an empty list (not an error) when there are no permanent failures', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.recipients).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.body.truncated).toBe(false);
  });

  it('respects the limit query param and flags truncation when results exceed it', async () => {
    // Build a synthetic batch of 5 distinct recipients, all permanent.
    const rows = Array.from({ length: 5 }).map((_, i) => ({
      reply_id: 100 + i,
      ticket_id: `tkt_${i}`,
      ticket_status: 'open',
      user_email: `user${i}@example.com`,
      email_error: '550 user unknown',
      // Ensure stable ordering by varying timestamps.
      reply_created_at: `2026-04-26T1${i}:00:00Z`,
    }));
    queryMock.mockResolvedValueOnce({ rowCount: rows.length, rows });

    const r = await request(buildApp()).get(`${PATH}?limit=3`).send();
    expect(r.status).toBe(200);
    expect(r.body.recipients).toHaveLength(3);
    expect(r.body.total).toBe(5);
    expect(r.body.truncated).toBe(true);
  });

  it('returns 500 with a detail message when the database query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));

    const r = await request(buildApp()).get(PATH).send();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Failed to load bounced recipients/);
    expect(r.body.detail).toContain('boom');
  });
});

describe('DELETE /support/replies/bounced-recipients/:email/alert — runtime behavior', () => {
  it('deletes the dedup row by lowercased email and reports cleared=true on success', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ email_lower: 'alice@example.com' }],
    });

    // Path includes mixed casing — the route must lowercase before
    // hitting the dedup table whose primary key is email_lower.
    const r = await request(buildApp())
      .delete('/support/replies/bounced-recipients/Alice%40Example.COM/alert')
      .send();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cleared: true, email_lower: 'alice@example.com' });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(
      /DELETE FROM support_recipient_bounce_alerts[\s\S]*?WHERE email_lower = \$1/,
    );
    expect(params).toEqual(['alice@example.com']);
  });

  it('reports cleared=false when no dedup row existed for the address', async () => {
    // Idempotent: clearing an alert that was never set should not error.
    // The next bounce on that address would still re-claim and fire the
    // alert via the same INSERT ... ON CONFLICT DO NOTHING path.
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await request(buildApp())
      .delete('/support/replies/bounced-recipients/never-alerted%40example.com/alert')
      .send();

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      cleared: false,
      email_lower: 'never-alerted@example.com',
    });
  });

  it('returns 500 with a detail message when the DELETE query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection lost'));

    const r = await request(buildApp())
      .delete('/support/replies/bounced-recipients/x%40example.com/alert')
      .send();

    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Failed to clear recipient bounce alert/);
    expect(r.body.detail).toContain('connection lost');
  });
});
