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

const RETRY_PATH = '/support/tickets/tkt_abc123/replies/42/retry';

const FAILED_REPLY_ROW = {
  id: 42,
  ticket_id: 'tkt_abc123',
  direction: 'outbound',
  body: 'Sorry for the delay — the fix is rolling out tonight.',
  email_message_id: null,
  email_error: 'connection refused',
};

const TICKET_ROW = {
  id: 'tkt_abc123',
  user_email: 'customer@example.com',
  topic: 'bug',
  inbound_token: 'a'.repeat(24),
};

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
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
    expect(updateCall[1]).toEqual([42, 'msg_retry_ok', null]);
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
    expect(updateCall[1]).toEqual([42, null, 'still down']);
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
