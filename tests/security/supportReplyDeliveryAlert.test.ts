import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

// ---- Static contract checks -------------------------------------------------
const helperFile = readFileSync(
  join(process.cwd(), 'platform/help/supportReplyDeliveryAlert.ts'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);
const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('supportReplyDeliveryAlert helper — static contract', () => {
  it('exports the threshold constant + helper used by both retry paths', () => {
    expect(helperFile).toMatch(/export const REPLY_DELIVERY_ALERT_THRESHOLD\s*=\s*3/);
    expect(helperFile).toMatch(/export async function raiseReplyDeliveryFailureAlert/);
  });

  it('writes a critical error_log via the shared logError helper', () => {
    expect(helperFile).toMatch(/logError\(\s*tenantId,\s*'critical'/);
    expect(helperFile).toMatch(/errorCode:\s*'support_reply_delivery_failed'/);
  });

  it('inserts an operations_alerts row of the documented type and severity', () => {
    expect(helperFile).toMatch(/INSERT INTO operations_alerts/);
    expect(helperFile).toMatch(/'support_reply_delivery_failed'/);
    expect(helperFile).toMatch(/'high'/);
  });

  it('skips operations_alerts when the ticket has no tenant (NOT NULL constraint)', () => {
    // operations_alerts.tenant_id is NOT NULL — anonymous tickets can only
    // get the critical error_log, not the in-product alert feed entry.
    expect(helperFile).toMatch(/if \(!tenantId\)/);
  });
});

describe('SupportReplyRetryScheduler — wires the alert in at the threshold', () => {
  it('imports the shared threshold + helper', () => {
    expect(schedulerFile).toMatch(/REPLY_DELIVERY_ALERT_THRESHOLD/);
    expect(schedulerFile).toMatch(/raiseReplyDeliveryFailureAlert/);
  });

  it('fires the alert exactly when the failed attempt crosses the threshold (boundary cross)', () => {
    // retry_count is monotonic so the threshold is crossed exactly once per
    // reply, naturally deduping the alert across both paths. The check is a
    // strict crossing (previous < threshold && new >= threshold) instead of a
    // raw equality so a permanent SMTP failure that jumps retry_count straight
    // to MAX in a single step (skipping the equality boundary) still fires
    // the alert exactly once.
    expect(schedulerFile).toMatch(/previousRetryCount < REPLY_DELIVERY_ALERT_THRESHOLD/);
    expect(schedulerFile).toMatch(
      /effectiveRetryCount >= REPLY_DELIVERY_ALERT_THRESHOLD|MAX_RETRY_ATTEMPTS >= REPLY_DELIVERY_ALERT_THRESHOLD/,
    );
  });

  it('selects tenant_id from support_tickets so the alert can be tenant-scoped', () => {
    expect(schedulerFile).toMatch(/t\.tenant_id\s+AS tenant_id/);
  });
});

describe('manual /retry endpoint — wires the alert in at the threshold', () => {
  it('imports the shared threshold + helper', () => {
    expect(supportFile).toMatch(/REPLY_DELIVERY_ALERT_THRESHOLD/);
    expect(supportFile).toMatch(/raiseReplyDeliveryFailureAlert/);
  });

  it('bumps retry_count and last_retry_at in the same UPDATE that records the result', () => {
    // Both retry paths share the same counter so the threshold check works
    // regardless of who triggered the send.
    expect(supportFile).toMatch(/retry_count = retry_count \+ 1/);
    expect(supportFile).toMatch(/last_retry_at = NOW\(\)/);
  });

  it('only fires the alert on a still-failed retry that crosses the threshold', () => {
    expect(supportFile).toMatch(
      /!result\.success && newRetryCount === REPLY_DELIVERY_ALERT_THRESHOLD/,
    );
  });

  it('selects tenant_id when loading the ticket so the alert can be tenant-scoped', () => {
    expect(supportFile).toMatch(/SELECT id, user_email, topic, inbound_token, tenant_id/);
  });
});

describe('/support/tickets/stats — exposes reply-level failure counts', () => {
  it('returns reply_email_failed and reply_email_failed_open alongside the existing fields', () => {
    expect(supportFile).toMatch(/reply_email_failed/);
    expect(supportFile).toMatch(/reply_email_failed_open/);
    expect(supportFile).toMatch(/FROM support_ticket_replies/);
    expect(supportFile).toMatch(/r\.direction = 'outbound'/);
  });
});

describe('PlatformAdmin SupportInboxTab — calls out reply-level failures', () => {
  it('reads the new reply_email_failed fields from the stats payload', () => {
    expect(adminUiFile).toMatch(/reply_email_failed:\s*number/);
    expect(adminUiFile).toMatch(/reply_email_failed_open:\s*number/);
  });

  it('renders a separate banner for failed admin reply deliveries', () => {
    expect(adminUiFile).toMatch(/admin reply delivery errors/);
  });
});

// ---- Runtime behavior -------------------------------------------------------

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

vi.mock('../../platform/core/observability', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}));

// Auth + RBAC bypass so we can hit the retry route directly.
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

// Stub schedulers we don't exercise here.
vi.mock('../../platform/help/DocsFeedbackAlertScheduler', () => ({
  runDocsFeedbackAlertCycle: vi.fn(),
  runDocsFeedbackPendingReplyAlertCycle: vi.fn(),
}));
vi.mock('../../platform/help/DocsFeedbackReplyDigestScheduler', () => ({
  runDocsFeedbackReplyDigestCycle: vi.fn(),
}));

const router = (await import('../../server/admin-api/routes/support')).default;
const { runSupportReplyRetryCycle } = await import(
  '../../platform/help/SupportReplyRetryScheduler'
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = ((await import('../../platform/email/EmailService')) as any)
  .__sendEmailMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logErrorMock = ((await import('../../platform/core/observability')) as any)
  .logError as ReturnType<typeof vi.fn>;

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
  body: 'Sorry — still investigating.',
  email_message_id: null,
  email_error: 'connection refused',
  retry_count: 2, // next failed attempt will land on retry_count = 3 (threshold)
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
});

describe('manual /retry — alert firing behavior', () => {
  it('fires both error_log + operations_alerts on the failure that crosses the threshold', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] }) // load reply
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })       // load ticket
      .mockResolvedValueOnce({                                           // UPDATE returning new retry_count
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: 'still down', retry_count: 3 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                 // UPDATE support_tickets bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                // INSERT operations_alerts

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(r.body.email_delivered).toBe(false);

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
      customer_email: 'customer@example.com',
      attempts: 3,
    });

    // operations_alerts row inserted with the documented type/severity.
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeTruthy();
    expect(alertCall![1][0]).toBe(TICKET_ROW.tenant_id);
    expect(alertCall![1][1]).toBe('support_reply_delivery_failed');
    expect(alertCall![1][2]).toBe('high');
    expect(alertCall![1][3]).toMatch(/Support reply 42 on ticket tkt_abc123/);
  });

  it('does NOT fire the alert when the retry succeeds (no persistent failure)', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_message_id: 'msg_ok', email_error: null, retry_count: 3 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_ok' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(r.body.email_delivered).toBe(true);
    expect(logErrorMock).not.toHaveBeenCalled();
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeUndefined();
  });

  it('does NOT fire the alert when a failed retry has not yet reached the threshold', async () => {
    // First failure: retry_count goes from 0 -> 1, well under the threshold.
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...FAILED_REPLY_ROW, retry_count: 0 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [TICKET_ROW] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: 'still down', retry_count: 1 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(logErrorMock).not.toHaveBeenCalled();
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeUndefined();
  });

  it('fires only the critical error_log (no operations_alerts insert) when the ticket has no tenant', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...TICKET_ROW, tenant_id: null }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY_ROW, email_error: 'still down', retry_count: 3 }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await request(buildApp()).post(RETRY_PATH).send({});
    expect(r.status).toBe(200);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeUndefined();
  });
});

const SCHEDULER_FAILED_REPLY = {
  reply_id: 7,
  ticket_id: 'tkt_xyz',
  body: 'Sorry, the fix is rolling out tonight.',
  email_error: 'connection refused',
  retry_count: 2, // next failed attempt becomes 3 — the threshold
  user_email: 'customer@example.com',
  topic: 'bug',
  inbound_token: 'b'.repeat(24),
  tenant_id: '00000000-0000-0000-0000-000000000099',
};

describe('background scheduler — alert firing behavior', () => {
  it('fires the alert when an automatic retry is the one that crosses the threshold', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [SCHEDULER_FAILED_REPLY] }) // SELECT
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })             // claim UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                      // result UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                      // ticket bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });                     // INSERT operations_alerts

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await runSupportReplyRetryCycle();
    expect(r.failed).toBe(1);
    expect(r.attempts[0]).toMatchObject({ attempt: 3, delivered: false });

    // Wait a microtask for the fire-and-forget alert to settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0][0]).toBe(SCHEDULER_FAILED_REPLY.tenant_id);
    expect(logErrorMock.mock.calls[0][1]).toBe('critical');
    expect(logErrorMock.mock.calls[0][3].errorCode).toBe('support_reply_delivery_failed');
    expect(logErrorMock.mock.calls[0][3].extra).toMatchObject({
      reply_id: 7,
      ticket_id: 'tkt_xyz',
      attempts: 3,
    });

    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeTruthy();
    expect(alertCall![1][1]).toBe('support_reply_delivery_failed');
    expect(alertCall![1][2]).toBe('high');
  });

  it('does NOT fire the alert on a successful auto-retry', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [SCHEDULER_FAILED_REPLY] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_auto_ok' });

    const r = await runSupportReplyRetryCycle();
    expect(r.delivered).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logErrorMock).not.toHaveBeenCalled();
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeUndefined();
  });

  it('does NOT fire the alert on a failed auto-retry that has not yet reached the threshold', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...SCHEDULER_FAILED_REPLY, retry_count: 0 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await runSupportReplyRetryCycle();
    expect(r.failed).toBe(1);
    expect(r.attempts[0]).toMatchObject({ attempt: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logErrorMock).not.toHaveBeenCalled();
    const alertCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO operations_alerts'),
    );
    expect(alertCall).toBeUndefined();
  });
});
