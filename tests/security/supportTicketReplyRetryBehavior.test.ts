import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../platform/db', () => {
  const queryMock = vi.fn();
  return {
    __queryMock: queryMock,
    getPlatformPool: () => ({ query: queryMock }),
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

// Bypass auth + RBAC so we can exercise the retry handler directly.
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

// The retry-rate limiter now talks to the shared `retry_attempts` Postgres
// table, which would consume one of the queryMock responses below and shift
// every subsequent expectation. These tests are about the post-limiter
// behavior of the route, so short-circuit the limiter to always allow.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logErrorMock = ((await import('../../platform/core/observability')) as any)
  .logError as ReturnType<typeof vi.fn>;
const { __resetForTesting: __resetSupportReplyLimiterForTesting } = await import(
  '../../platform/help/supportReplyRetryLimiter'
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const RETRY_PATH = '/support/tickets/tkt_abc123/replies/42/retry';

const FAILED_REPLY_ROW = {
  id: 42,
  ticket_id: 'tkt_abc123',
  direction: 'outbound',
  body: 'Sorry for the delay — the fix is rolling out tonight.',
  email_message_id: null,
  email_error: 'connection refused',
  retry_count: 0,
  // Retry-skip reason starts null; permanent-failure paths stamp
  // 'permanent_smtp_failure' onto it. The result UPDATE on a successful
  // retry clears it back to null.
  retry_skipped_reason: null,
};

const TICKET_ROW = {
  id: 'tkt_abc123',
  user_email: 'customer@example.com',
  topic: 'bug',
  inbound_token: 'a'.repeat(24),
  tenant_id: '00000000-0000-0000-0000-000000000099',
};

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  logErrorMock.mockReset();
  // Wipe the per-reply cooldown map so each test starts from a clean slate
  // — otherwise the second test that hits replyId=42 would 429 instead of
  // exercising the handler.
  __resetSupportReplyLimiterForTesting();
});

describe('POST /support/tickets/:id/replies/:replyId/retry — runtime behavior', () => {
  it('flips the badge to Sent on a successful re-send and updates the row in place', async () => {
    queryMock
      // 1. Load the failed outbound reply
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] })
      // 2. Load the ticket
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      // 3. UPDATE ... RETURNING the refreshed reply row
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          email_message_id: 'msg_retry_ok',
          email_error: null,
        }],
      })
      // 4. UPDATE support_tickets bumping updated_at
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_retry_ok' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.email_delivered).toBe(true);
    expect(r.body.reply.email_message_id).toBe('msg_retry_ok');
    expect(r.body.reply.email_error).toBe(null);

    // Sent through the existing SMTP path to the original recipient.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [emailArgs] = sendEmailMock.mock.calls[0];
    expect(emailArgs.to).toBe('customer@example.com');
    expect(emailArgs.subject).toMatch(/\(tkt_abc123\)/);
    expect(emailArgs.text).toContain(FAILED_REPLY_ROW.body);
    expect(emailArgs.replyTo).toMatch(/^support\+a{24}@/);

    // The third query is the in-place UPDATE of the existing reply row.
    const updateCall = queryMock.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(updateCall[0]).toMatch(/SET email_message_id = \$2, email_error = \$3/);
    // retry_skipped_reason is cleared on a successful retry so the badge goes away.
    expect(updateCall[0]).toMatch(/retry_skipped_reason = \$4/);
    expect(updateCall[1]).toEqual([42, 'msg_retry_ok', null, null]);
  });

  it('records the new delivery error when the retry also fails', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          email_message_id: null,
          email_error: 'still down',
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});

    expect(r.status).toBe(200);
    expect(r.body.email_delivered).toBe(false);
    expect(r.body.reply.email_error).toBe('still down');
    expect(r.body.reply.email_message_id).toBe(null);

    const updateCall = queryMock.mock.calls[2];
    // Transient failure: retry_skipped_reason carries the prior row's value
    // (null here) since we only stamp the column on permanent failures.
    expect(updateCall[1]).toEqual([42, null, 'still down', null]);
  });

  it('refuses to retry an inbound reply', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...FAILED_REPLY_ROW, direction: 'inbound', email_error: 'irrelevant' }],
    });

    const r = await request(buildApp()).post(RETRY_PATH).send({});

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/outbound/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('refuses to retry a reply that already sent successfully (no email_error)', async () => {
    queryMock.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...FAILED_REPLY_ROW, email_message_id: 'msg_already_sent', email_error: null }],
    });

    const r = await request(buildApp()).post(RETRY_PATH).send({});

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nothing to retry/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the reply does not belong to the ticket', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await request(buildApp()).post(RETRY_PATH).send({});

    expect(r.status).toBe(404);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rejects malformed reply ids without touching the database', async () => {
    const r = await request(buildApp())
      .post('/support/tickets/tkt_abc123/replies/not-a-number/retry')
      .send({});

    expect(r.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects partially-numeric reply ids (e.g. "42abc") instead of silently parsing', async () => {
    const r = await request(buildApp())
      .post('/support/tickets/tkt_abc123/replies/42abc/retry')
      .send({});

    expect(r.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('POST /support/tickets/:id/replies/:replyId/retry — hard-bounce skip', () => {
  // Test matrix of obviously-permanent SMTP error strings the classifier
  // should catch. Each one should refuse the retry without contacting SMTP.
  const PERMANENT_ERRORS = [
    '550 5.1.1 No such user here',
    '551 user unknown',
    'recipient address rejected: invalid recipient',
    'mailbox is full',
    'user does not exist',
  ];

  for (const err of PERMANENT_ERRORS) {
    it(`refuses to re-send when the prior error is permanent ("${err}")`, async () => {
      queryMock
        // 1. Load the failed outbound reply with the permanent error
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ ...FAILED_REPLY_ROW, email_error: err, retry_count: 0 }],
        })
        // 2. Load the ticket (we still need it for the alert metadata)
        .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
        // 3. UPDATE support_ticket_replies SET retry_count = MAX
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // 4. UPDATE support_tickets SET updated_at = NOW()
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // 5. INSERT operations_alerts (threshold-cross alert)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const r = await request(buildApp()).post(RETRY_PATH).send({});

      expect(r.status).toBe(409);
      expect(r.body.permanent).toBe(true);
      expect(r.body.error).toMatch(/permanent/i);
      // The whole point: we must NOT hit SMTP for a known-bad recipient.
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  }

  it('jumps retry_count to the auto-retry ceiling so the row leaves the auto-retry pool', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: '550 5.1.1 user unknown', retry_count: 1 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(409);
    // REPLY_DELIVERY_ALERT_THRESHOLD doubles as MAX_RETRY_ATTEMPTS in the
    // scheduler, so we expect retry_count to be jumped to that value (3).
    expect(r.body.retry_count).toBe(3);

    // Find the conditional-bump UPDATE: it must (a) target the ceiling
    // (parameter $2 = 3) and (b) be guarded by `retry_count < $2` so a
    // double-click can't push retry_count past MAX.
    const bumpCall = queryMock.mock.calls.find((c) => {
      const sql = typeof c[0] === 'string' ? c[0] : '';
      return (
        sql.includes('UPDATE support_ticket_replies') &&
        sql.includes('SET retry_count = $2') &&
        sql.includes('retry_count < $2')
      );
    });
    expect(bumpCall).toBeTruthy();
    expect(bumpCall![1]).toEqual([42, 3]);
  });

  it('fires the threshold-cross delivery alert exactly once on a permanent failure', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: '550 mailbox not found', retry_count: 0 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(409);

    // Wait a microtask for the fire-and-forget alert to settle.
    await new Promise((resolve) => setImmediate(resolve));

    // Critical error_log written through the shared helper.
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const [tenantArg, severityArg, messageArg, contextArg] = logErrorMock.mock.calls[0];
    expect(tenantArg).toBe(TICKET_ROW.tenant_id);
    expect(severityArg).toBe('critical');
    expect(messageArg).toMatch(/Support reply 42 on ticket tkt_abc123/);
    expect(contextArg.errorCode).toBe('support_reply_delivery_failed');
    expect(contextArg.extra).toMatchObject({
      reply_id: 42,
      ticket_id: 'tkt_abc123',
      attempts: 3,
    });

    // operations_alerts row inserted for the in-product alert feed.
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeTruthy();
    expect(alertCall![1][1]).toBe('support_reply_delivery_failed');
    expect(alertCall![1][2]).toBe('high');
  });

  it('does NOT re-fire the alert or re-bump the row when retry_count is already at MAX', async () => {
    // The auto-retry scheduler has already short-circuited this row — it
    // jumped retry_count to MAX and fired the alert on its threshold cross.
    // A subsequent admin click must be a complete no-op aside from the 409.
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: '550 user unknown', retry_count: 3 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(409);
    expect(r.body.permanent).toBe(true);
    expect(r.body.retry_count).toBe(3);

    expect(sendEmailMock).not.toHaveBeenCalled();
    // Only the two SELECTs should have run — no UPDATEs, no INSERT alert.
    expect(queryMock).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('still allows retry when the prior error is transient (e.g. connection refused)', async () => {
    // Sanity: a transient failure must continue to flow through the existing
    // retry path; the hard-bounce skip should only short-circuit permanent
    // failures.
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: 'connection refused', retry_count: 0 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          email_message_id: 'msg_ok',
          email_error: null,
          retry_count: 1,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_ok' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(r.body.email_delivered).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('treats a transient 4yz code as retryable even when keywords look permanent', async () => {
    // The classifier prioritises the numeric SMTP code: a 4yz code means
    // "try again later" even when the human-readable portion mentions
    // "address rejected" or "mailbox full". We must not short-circuit.
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          email_error: '450 4.2.1 mailbox temporarily unavailable, address rejected',
          retry_count: 0,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          ...FAILED_REPLY_ROW,
          email_message_id: 'msg_ok',
          email_error: null,
          retry_count: 1,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_ok' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /support/tickets/:id/replies — permanent_failure flag', () => {
  it('flags outbound replies whose error matches the permanent classifier', async () => {
    const REPLIES_PATH = '/support/tickets/tkt_abc123/replies';
    queryMock.mockResolvedValueOnce({
      rowCount: 4,
      rows: [
        // Hard bounce: should be flagged.
        {
          id: 1, ticket_id: 'tkt_abc123', direction: 'outbound',
          author_user_id: null, author_email: 'admin@qvo.ai',
          body: 'reply 1', email_message_id: null,
          email_error: '550 5.1.1 No such user', source: 'admin_console',
          created_at: '2026-04-26T10:00:00Z',
        },
        // Transient failure: should NOT be flagged.
        {
          id: 2, ticket_id: 'tkt_abc123', direction: 'outbound',
          author_user_id: null, author_email: 'admin@qvo.ai',
          body: 'reply 2', email_message_id: null,
          email_error: 'connection refused', source: 'admin_console',
          created_at: '2026-04-26T10:01:00Z',
        },
        // Successful send: no error, should NOT be flagged.
        {
          id: 3, ticket_id: 'tkt_abc123', direction: 'outbound',
          author_user_id: null, author_email: 'admin@qvo.ai',
          body: 'reply 3', email_message_id: 'msg_ok', email_error: null,
          source: 'admin_console', created_at: '2026-04-26T10:02:00Z',
        },
        // Inbound message (even with a "permanent"-looking string): not outbound,
        // so it must NOT be flagged — the flag only gates the outbound retry button.
        {
          id: 4, ticket_id: 'tkt_abc123', direction: 'inbound',
          author_user_id: null, author_email: 'customer@example.com',
          body: 'reply 4', email_message_id: null,
          email_error: '550 user unknown', source: 'email_webhook',
          created_at: '2026-04-26T10:03:00Z',
        },
      ],
    });

    const r = await request(buildApp()).get(REPLIES_PATH).send();
    expect(r.status).toBe(200);
    expect(r.body.replies).toHaveLength(4);
    expect(r.body.replies[0]).toMatchObject({ id: 1, permanent_failure: true });
    expect(r.body.replies[1]).toMatchObject({ id: 2, permanent_failure: false });
    expect(r.body.replies[2]).toMatchObject({ id: 3, permanent_failure: false });
    expect(r.body.replies[3]).toMatchObject({ id: 4, permanent_failure: false });
  });
});
