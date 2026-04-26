import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ----- Mocks (mirrors the pattern used by supportTicketReplyRetryBehavior.test.ts) -----

vi.mock('../../platform/db', () => {
  const queryMock = vi.fn();
  // The /cancel-retries endpoint never touches the suppression / unsubscribe
  // tables (it just flips a column on an already-failed reply), but we keep
  // the same short-circuit wrapper as the sibling retry test so that any
  // future change which adds a pre-check doesn't silently consume a mocked
  // response and shift every index assertion below.
  const SUPPRESSION_TABLE_RE = /support_email_(unsubscribes|suppressions)/i;
  const wrappedQuery = (sql: unknown, ...rest: unknown[]) => {
    const sqlText = typeof sql === 'string' ? sql : String(sql ?? '');
    if (SUPPRESSION_TABLE_RE.test(sqlText)) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    return (queryMock as (...a: unknown[]) => unknown)(sql, ...rest);
  };
  return {
    __queryMock: queryMock,
    getPlatformPool: () => ({ query: wrappedQuery }),
  };
});

vi.mock('../../platform/email/EmailService', () => {
  const sendEmailMock = vi.fn();
  return {
    __sendEmailMock: sendEmailMock,
    sendEmail: sendEmailMock,
  };
});

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Bypass auth + RBAC so we can exercise the handler directly.
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

// Stub the docs-feedback schedulers to avoid pulling their full transitive
// graph (we only care about the support router here).
vi.mock('../../platform/help/DocsFeedbackAlertScheduler', () => ({
  runDocsFeedbackAlertCycle: vi.fn(),
  runDocsFeedbackPendingReplyAlertCycle: vi.fn(),
}));
vi.mock('../../platform/help/DocsFeedbackReplyDigestScheduler', () => ({
  runDocsFeedbackReplyDigestCycle: vi.fn(),
}));
vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

// Cancel-retries doesn't go through the retry rate limiter, but the route
// module imports it at the top level so we still need a stub to avoid
// reaching into Postgres at import time.
vi.mock('../../platform/help/supportReplyRetryLimiter', () => ({
  tryReserveSupportReplyRetrySlot: async () => ({ allowed: true as const }),
  __setCooldownSecondsForTesting: () => {},
  __reloadCooldownFromEnvForTesting: () => {},
  __resetForTesting: async () => {},
  getSupportReplyRetryCooldownSeconds: () => 0,
}));

const router = (await import('../../server/admin-api/routes/support')).default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = ((await import('../../platform/email/EmailService')) as any).__sendEmailMock as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const CANCEL_PATH = '/support/tickets/tkt_abc123/replies/42/cancel-retries';

const FAILED_REPLY_ROW = {
  id: 42,
  ticket_id: 'tkt_abc123',
  direction: 'outbound',
  email_error: 'connection refused',
  retry_skipped_reason: null,
  retry_count: 1,
};

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
});

describe('POST /support/tickets/:id/replies/:replyId/cancel-retries', () => {
  it('200 — flips retry_skipped_reason to manual_cancel and parks retry_count at the alert threshold', async () => {
    // Mock sequence:
    //  1. SELECT the failed outbound reply (eligible — has email_error, no skip reason)
    //  2. UPDATE support_ticket_replies ... RETURNING the refreshed row
    //  3. UPDATE support_tickets SET updated_at = NOW()
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          retry_skipped_reason: 'manual_cancel',
          retry_count: 3,
          last_retry_at: '2026-04-26T12:00:00Z',
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const r = await request(buildApp()).post(CANCEL_PATH).send({});

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.already_skipped).toBeUndefined();
    expect(r.body.reply.retry_skipped_reason).toBe('manual_cancel');
    expect(r.body.reply.retry_count).toBe(3);

    // The route must NOT touch SMTP — this is a metadata-only flip.
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Inspect the UPDATE statement on support_ticket_replies. It must:
    //   - stamp 'manual_cancel' as the skip reason
    //   - park retry_count at GREATEST(retry_count, $2) where $2 is the
    //     REPLY_DELIVERY_ALERT_THRESHOLD (3) — this is what removes the row
    //     from the auto-retry pool.
    //   - guard the write on `retry_skipped_reason IS NULL` so a concurrent
    //     write that already stamped a reason isn't clobbered.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(updateCall[0]).toMatch(/retry_skipped_reason\s*=\s*'manual_cancel'/);
    expect(updateCall[0]).toMatch(/retry_count\s*=\s*GREATEST\(retry_count,\s*\$2\)/);
    expect(updateCall[0]).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+retry_skipped_reason\s+IS\s+NULL/);
    // $1 = reply id, $2 = parked retry_count (= REPLY_DELIVERY_ALERT_THRESHOLD = 3)
    expect(updateCall[1]).toEqual([42, 3]);

    // And the ticket's updated_at is bumped so the inbox row floats to the top.
    const ticketTouchCall = queryMock.mock.calls[2];
    expect(ticketTouchCall[0]).toMatch(/UPDATE support_tickets SET updated_at = NOW\(\)/);
    expect(ticketTouchCall[1]).toEqual(['tkt_abc123']);
  });

  it('409 — refuses to cancel a reply that did not fail to send (no email_error)', async () => {
    // The button is only meaningful for failed sends; trying to "stop
    // auto-retries" on a successfully-delivered reply must surface a
    // 409 instead of silently writing manual_cancel onto a healthy row.
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...FAILED_REPLY_ROW, email_error: null }],
    });

    const r = await request(buildApp()).post(CANCEL_PATH).send({});

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nothing to cancel/i);
    // Only the SELECT should have run — no UPDATE, no ticket touch.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('200 idempotent — already-skipped reply is returned untouched and preserves permanent_smtp_failure', async () => {
    // A hard-bounce row already has retry_skipped_reason='permanent_smtp_failure'
    // stamped by the scheduler. Clicking "Stop auto-retries" on it must NOT
    // downgrade that more-specific reason to 'manual_cancel'; the response
    // is a successful no-op that surfaces the existing state.
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        ...FAILED_REPLY_ROW,
        email_error: '550 5.1.1 No such user here',
        retry_skipped_reason: 'permanent_smtp_failure',
        retry_count: 3,
      }],
    });

    const r = await request(buildApp()).post(CANCEL_PATH).send({});

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.already_skipped).toBe(true);
    // Critical: the existing reason is preserved verbatim.
    expect(r.body.reply.retry_skipped_reason).toBe('permanent_smtp_failure');

    // Only the SELECT should have run — no UPDATE on either table.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('404 — replyId that does not belong to the URL ticket returns Not Found', async () => {
    // The SELECT is keyed on `id = $1 AND ticket_id = $2`, so a reply that
    // exists under a DIFFERENT ticket comes back rowCount=0 and the route
    // must 404 instead of leaking that the reply id exists elsewhere.
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await request(buildApp()).post(CANCEL_PATH).send({});

    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/reply not found/i);

    // The SELECT must have been issued with BOTH the reply id and the
    // ticket id from the URL — otherwise the wrong-ticket guard isn't
    // really being tested.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const selectCall = queryMock.mock.calls[0];
    expect(selectCall[0]).toMatch(/FROM support_ticket_replies/);
    expect(selectCall[0]).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+ticket_id\s*=\s*\$2/);
    expect(selectCall[1]).toEqual([42, 'tkt_abc123']);

    // No SMTP traffic, no UPDATEs.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
