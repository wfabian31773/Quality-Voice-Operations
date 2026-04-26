import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract checks -------------------------------------------------
//
// Lock down the POST/DELETE manual-suppression admin endpoints, the audit
// columns on the migration, and the "Suppress / Unsuppress" UI controls so
// future refactors can't silently drop pieces of the feature.

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);
const suppressionHelper = readFileSync(
  join(process.cwd(), 'platform/email/SupportEmailSuppression.ts'),
  'utf8',
);
const auditMigration = readFileSync(
  join(process.cwd(), 'migrations/074_support_email_suppressions_audit.sql'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);

describe('support_email_suppressions audit migration', () => {
  it('adds added_by_user_id and notes columns idempotently', () => {
    expect(auditMigration).toMatch(/ALTER TABLE support_email_suppressions/);
    expect(auditMigration).toMatch(/ADD COLUMN IF NOT EXISTS added_by_user_id TEXT/);
    expect(auditMigration).toMatch(/ADD COLUMN IF NOT EXISTS notes TEXT/);
  });
});

describe('SupportEmailSuppression helpers', () => {
  it('exposes a remove helper distinct from the unsubscribe table', () => {
    expect(suppressionHelper).toMatch(/export async function removeSupportEmailSuppression/);
    // Must NOT touch the unsubscribe table — it's intentionally durable.
    const removeBlock = suppressionHelper.slice(
      suppressionHelper.indexOf('removeSupportEmailSuppression'),
      suppressionHelper.indexOf('removeSupportEmailSuppression') + 800,
    );
    expect(removeBlock).not.toMatch(/support_email_unsubscribes/);
  });

  it('exposes strict admin-only variants that surface DB errors', () => {
    // The admin endpoints need a non-swallowing variant so a real DB
    // failure can become a 5xx instead of a misleading 200/404.
    expect(suppressionHelper).toMatch(/export async function addSupportEmailSuppressionStrict/);
    expect(suppressionHelper).toMatch(/export async function removeSupportEmailSuppressionStrict/);
    // The strict remove distinguishes "absent" from "removed" so DB errors
    // can't masquerade as a legitimate 404.
    expect(suppressionHelper).toMatch(/'removed'|'absent'/);
  });

  it('exposes a bulk lookup helper used by the bounced-recipients enrichment', () => {
    expect(suppressionHelper).toMatch(/export async function getSupportEmailSuppressionsByEmails/);
    expect(suppressionHelper).toMatch(/email_lower = ANY\(\$1::text\[\]\)/);
  });

  it('preserves earlier admin attribution when an automated re-bounce refreshes the row', () => {
    // The COALESCE on the ON CONFLICT branch keeps the manual added_by_user_id /
    // notes if a later automated insert doesn't bring its own.
    expect(suppressionHelper).toMatch(
      /added_by_user_id = COALESCE\(EXCLUDED\.added_by_user_id, support_email_suppressions\.added_by_user_id\)/,
    );
    expect(suppressionHelper).toMatch(
      /notes = COALESCE\(EXCLUDED\.notes, support_email_suppressions\.notes\)/,
    );
  });
});

describe('admin suppression endpoints — static contract', () => {
  it('mounts POST /support/email-suppressions guarded by requireAuth + requirePlatformAdmin', () => {
    expect(supportFile).toMatch(
      /router\.post\(\s*\n?\s*['"]\/support\/email-suppressions['"][\s\S]*?requireAuth[\s\S]*?requirePlatformAdmin/,
    );
  });

  it('mounts DELETE /support/email-suppressions/:emailLower guarded by requireAuth + requirePlatformAdmin', () => {
    expect(supportFile).toMatch(
      /router\.delete\(\s*\n?\s*['"]\/support\/email-suppressions\/:emailLower['"][\s\S]*?requireAuth[\s\S]*?requirePlatformAdmin/,
    );
  });

  it('records the admin user id + manual_admin reason on suppress', () => {
    const start = supportFile.indexOf("'/support/email-suppressions'");
    const block = supportFile.slice(start, start + 4000);
    expect(block).toMatch(/addedByUserId:\s*user\.userId/);
    expect(block).toMatch(/reason:\s*'manual_admin'/);
    expect(block).toMatch(/source:\s*'platform_admin_ui'/);
  });

  it('enriches the bounced-recipients response with per-row suppression info', () => {
    expect(supportFile).toMatch(/getSupportEmailSuppressionsByEmails\(/);
    expect(supportFile).toMatch(/suppression: suppressionMap\.get/);
  });

  it('returns the recipient suppression entry from the ticket replies endpoint', () => {
    expect(supportFile).toMatch(/getSupportEmailSuppression\(t\.rows\[0\]\.user_email\)/);
    expect(supportFile).toMatch(/res\.json\(\{ replies, suppression \}\)/);
  });
});

describe('PlatformAdmin UI — Suppress / Unsuppress controls', () => {
  it('renders a Suppress action in the Bounced recipients panel', () => {
    expect(adminUiFile).toMatch(/Suppress recipient|>Suppress</);
    // Cancel button on the note prompt
    expect(adminUiFile).toMatch(/Confirm suppress|>Confirm</);
  });

  it('renders an Unsuppress button when the row is already on the list', () => {
    expect(adminUiFile).toMatch(/Unsuppress/);
  });

  it('shows a Suppressed badge for rows on the list', () => {
    expect(adminUiFile).toMatch(/function SuppressedBadge/);
    expect(adminUiFile).toMatch(/Suppressed{wasManual \? ' by ops' : ''}/);
  });

  it('renders the Suppressed badge inside the ticket thread view', () => {
    // The TicketThread reads suppression off the replies query and feeds it
    // to the same SuppressedBadge.
    expect(adminUiFile).toMatch(
      /suppression && <SuppressedBadge suppression={suppression}/,
    );
  });

  it('targets the new admin endpoints from both the panel and the thread', () => {
    // POST + DELETE used by the panel
    expect(adminUiFile).toMatch(/api\.post[^(]*\([^)]*\/support\/email-suppressions/);
    expect(adminUiFile).toMatch(
      /api\.delete[^(]*\([^)]*\/support\/email-suppressions\/\$\{encodeURIComponent/,
    );
  });
});

describe('SupportReplyRetryScheduler — pre-check stays in place', () => {
  it('still consults the address-scoped suppression list before sending', () => {
    expect(schedulerFile).toMatch(/checkSupportEmailSkip\(reply\.user_email\)/);
    expect(schedulerFile).toMatch(/markReplySkippedByList\(reply, skipDecision\.reason\)/);
  });
});

// ---- Runtime behavior -------------------------------------------------------
//
// Mock the platform DB and stub auth/RBAC so we can exercise the route
// directly. Verifies:
//   1. POST upserts an entry with the admin user id + notes
//   2. POST validates the email + notes payload
//   3. DELETE 404s when the address isn't on the list
//   4. DELETE accepts the lowercased path param and removes the row
//   5. The bounced-recipients endpoint now joins suppression info via the
//      bulk helper

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
      userId: '00000000-0000-0000-0000-000000000abc',
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

beforeEach(() => {
  queryMock.mockReset();
});

describe('POST /support/email-suppressions — runtime', () => {
  it('400s when email is missing', async () => {
    const r = await request(buildApp()).post('/support/email-suppressions').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/email is required/);
  });

  it('400s on a malformed email', async () => {
    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid email/);
  });

  it('400s when notes exceed the soft cap', async () => {
    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'ok@example.com', notes: 'x'.repeat(1001) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/notes/);
  });

  it('upserts the entry attributed to the admin and returns the row', async () => {
    // Two queries inside the helper: the INSERT … ON CONFLICT, then the
    // SELECT inside getSupportEmailSuppression. Both routed through the same
    // mocked pool.
    queryMock
      // INSERT ... ON CONFLICT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // SELECT for getSupportEmailSuppressionsByEmails
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            email_lower: 'badge@example.com',
            reason: 'manual_admin',
            source: 'platform_admin_ui',
            last_error: null,
            added_at: '2026-04-26T10:00:00Z',
            added_by_user_id: '00000000-0000-0000-0000-000000000abc',
            notes: 'moved to new email per ticket #1234',
          },
        ],
      });

    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'Badge@Example.COM', notes: 'moved to new email per ticket #1234' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.suppression.email_lower).toBe('badge@example.com');
    expect(r.body.suppression.added_by_user_id).toBe('00000000-0000-0000-0000-000000000abc');
    expect(r.body.suppression.notes).toMatch(/ticket #1234/);

    // First call should be the INSERT … ON CONFLICT with the lowercased
    // address as the PK and the admin id in the audit column.
    const insert = queryMock.mock.calls[0];
    expect(insert[0]).toMatch(/INSERT INTO support_email_suppressions/);
    expect(insert[1][0]).toBe('badge@example.com');
    expect(insert[1][1]).toBe('manual_admin');
    expect(insert[1][2]).toBe('platform_admin_ui');
    // last_error
    expect(insert[1][3]).toBeNull();
    // added_by_user_id
    expect(insert[1][4]).toBe('00000000-0000-0000-0000-000000000abc');
    // notes
    expect(insert[1][5]).toBe('moved to new email per ticket #1234');
  });

  it('accepts a missing notes field and stores NULL', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            email_lower: 'no-notes@example.com',
            reason: 'manual_admin',
            source: 'platform_admin_ui',
            last_error: null,
            added_at: '2026-04-26T10:00:00Z',
            added_by_user_id: '00000000-0000-0000-0000-000000000abc',
            notes: null,
          },
        ],
      });

    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'no-notes@example.com' });
    expect(r.status).toBe(200);
    const insert = queryMock.mock.calls[0];
    expect(insert[1][5]).toBeNull();
    expect(r.body.suppression.notes).toBeNull();
  });

  it('5xxs when the underlying DB write fails (no false success)', async () => {
    // The strict variant must surface DB errors as a 500 — admins should
    // never see a green confirmation for a write that didn't land.
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'broken@example.com' });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Failed to suppress/);
  });

  it('5xxs when the upsert succeeds but the read-back returns nothing', async () => {
    // Defensive belt-and-braces — if the row appears to insert but the
    // follow-up read can't find it (replica lag, race, etc.), don't
    // pretend the suppression took effect.
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r = await request(buildApp())
      .post('/support/email-suppressions')
      .send({ email: 'ghost@example.com' });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/could not be re-read/);
  });
});

describe('DELETE /support/email-suppressions/:emailLower — runtime', () => {
  it('404s when the row does not exist (helper returned 0 rows)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r = await request(buildApp())
      .delete(`/support/email-suppressions/${encodeURIComponent('gone@example.com')}`)
      .send();
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/No suppression entry/);
  });

  it('lowercases the path param and removes the row', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ email_lower: 'badge@example.com' }] });
    const r = await request(buildApp())
      .delete(`/support/email-suppressions/${encodeURIComponent('Badge@Example.COM')}`)
      .send();
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const del = queryMock.mock.calls[0];
    expect(del[0]).toMatch(/DELETE FROM support_email_suppressions/);
    expect(del[1][0]).toBe('badge@example.com');
  });

  it('400s on a malformed email path param', async () => {
    const r = await request(buildApp())
      .delete(`/support/email-suppressions/${encodeURIComponent('not-an-email')}`)
      .send();
    expect(r.status).toBe(400);
  });

  it('5xxs when the DELETE itself fails (no false 404)', async () => {
    // The strict variant throws on DB errors so we can distinguish a real
    // "row missing" from a transient infrastructure problem. Mishandling
    // this would silently report "already cleared" to admins after an
    // outage when the row is in fact still active.
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const r = await request(buildApp())
      .delete(`/support/email-suppressions/${encodeURIComponent('still-here@example.com')}`)
      .send();
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Failed to unsuppress/);
  });
});

describe('GET /support/replies/bounced-recipients — suppression enrichment', () => {
  it('annotates each visible row with its current suppression entry (or null)', async () => {
    // Three queries in order:
    //   1. candidate replies
    //   2. support_recipient_bounce_alerts lookup (added by the alerted_at
    //      feature on the base branch — returned empty here)
    //   3. suppression bulk lookup (this task's enrichment)
    queryMock
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          {
            reply_id: 1,
            ticket_id: 'tkt_x',
            ticket_status: 'open',
            user_email: 'alice@example.com',
            email_error: '550 5.1.1 No such user',
            reply_created_at: '2026-04-26T10:00:00Z',
          },
          {
            reply_id: 2,
            ticket_id: 'tkt_y',
            ticket_status: 'open',
            user_email: 'bob@example.com',
            email_error: 'mailbox is full',
            reply_created_at: '2026-04-26T09:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            email_lower: 'alice@example.com',
            reason: 'permanent_smtp_failure',
            source: 'support_reply_retry_scheduler',
            last_error: '550 5.1.1 No such user',
            added_at: '2026-04-26T10:01:00Z',
            added_by_user_id: null,
            notes: null,
          },
        ],
      });

    const r = await request(buildApp())
      .get('/support/replies/bounced-recipients')
      .send();
    expect(r.status).toBe(200);
    const byEmail = Object.fromEntries(
      r.body.recipients.map((row: { user_email: string; suppression: unknown }) => [
        row.user_email,
        row.suppression,
      ]),
    );
    expect(byEmail['alice@example.com']).toMatchObject({
      reason: 'permanent_smtp_failure',
      source: 'support_reply_retry_scheduler',
    });
    expect(byEmail['bob@example.com']).toBeNull();

    // Bulk lookup must hit the suppression table with both lowercased
    // addresses (in some order) — proves no N+1. Index isn't fixed because
    // the alerted_at lookup may or may not run depending on the recipient
    // count, so we search by SQL fingerprint instead.
    const suppressionCall = queryMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && /FROM support_email_suppressions/.test(c[0] as string),
    );
    expect(suppressionCall).toBeDefined();
    const params = (suppressionCall as unknown[])[1] as unknown[];
    expect(new Set(params[0] as string[])).toEqual(
      new Set(['alice@example.com', 'bob@example.com']),
    );
  });
});

describe('GET /support/tickets/:id/replies — recipient suppression', () => {
  it('returns the ticket recipient suppression alongside replies', async () => {
    queryMock
      // replies query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // SELECT user_email FROM support_tickets
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_email: 'recipient@example.com' }],
      })
      // suppression bulk lookup
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            email_lower: 'recipient@example.com',
            reason: 'manual_admin',
            source: 'platform_admin_ui',
            last_error: null,
            added_at: '2026-04-26T11:00:00Z',
            added_by_user_id: '00000000-0000-0000-0000-000000000abc',
            notes: null,
          },
        ],
      });

    const r = await request(buildApp())
      .get('/support/tickets/tkt_abc/replies')
      .send();
    expect(r.status).toBe(200);
    expect(r.body.replies).toEqual([]);
    expect(r.body.suppression).toMatchObject({
      email_lower: 'recipient@example.com',
      reason: 'manual_admin',
      added_by_user_id: '00000000-0000-0000-0000-000000000abc',
    });
  });

  it('returns suppression: null when the ticket recipient is not on the list', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_email: 'fine@example.com' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const r = await request(buildApp())
      .get('/support/tickets/tkt_def/replies')
      .send();
    expect(r.status).toBe(200);
    expect(r.body.suppression).toBeNull();
  });
});
