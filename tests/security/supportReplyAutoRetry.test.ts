import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Static contract tests --------------------------------------------------
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);
const startFile = readFileSync(
  join(process.cwd(), 'server/admin-api/start.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'migrations/069_support_ticket_replies_retry_count.sql'),
  'utf8',
);
const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const sharedHelper = readFileSync(
  join(process.cwd(), 'platform/help/supportReplyEmail.ts'),
  'utf8',
);

describe('SupportReplyRetryScheduler — wiring & contract', () => {
  it('migration adds retry_count and last_retry_at columns', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS retry_count/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS last_retry_at/);
  });

  it('only retries outbound failed replies inside the lookback window with retries remaining', () => {
    expect(schedulerFile).toMatch(/direction = 'outbound'/);
    expect(schedulerFile).toMatch(/email_error IS NOT NULL/);
    expect(schedulerFile).toMatch(/retry_count < \$1/);
    expect(schedulerFile).toMatch(/created_at >= NOW\(\) - \(\$2 \|\| ' minutes'\)::interval/);
  });

  it('caps total automatic attempts so the human still sees a Failed badge eventually', () => {
    expect(schedulerFile).toMatch(/MAX_RETRY_ATTEMPTS\s*=\s*\d+/);
  });

  it('updates the row in place: increments retry_count and sets last_retry_at', () => {
    expect(schedulerFile).toMatch(/UPDATE support_ticket_replies/);
    expect(schedulerFile).toMatch(/retry_count = retry_count \+ 1/);
    expect(schedulerFile).toMatch(/last_retry_at = NOW\(\)/);
  });

  it('claims rows atomically before sending so concurrent workers cannot double-send', () => {
    // The claim is a conditional UPDATE that only matches when retry_count
    // still equals what we observed in the SELECT — losing the race is a
    // 0-row update and the worker simply skips that reply.
    expect(schedulerFile).toMatch(/AND retry_count = \$2/);
    expect(schedulerFile).toMatch(/RETURNING id/);
    expect(schedulerFile).toMatch(/claim lost to concurrent worker/);
  });

  it('reuses the same renderOutboundTicketReplyEmail + sendEmail path as the manual retry', () => {
    expect(schedulerFile).toMatch(/renderOutboundTicketReplyEmail/);
    expect(schedulerFile).toMatch(/sendEmail\(/);
    // The manual retry handler also imports the shared renderer.
    expect(supportFile).toMatch(/from '\.\.\/\.\.\/\.\.\/platform\/help\/supportReplyEmail'/);
    expect(sharedHelper).toMatch(/export function renderOutboundTicketReplyEmail/);
  });

  it('is started and stopped alongside the admin API', () => {
    expect(startFile).toMatch(/startSupportReplyRetryScheduler/);
    expect(startFile).toMatch(/stopSupportReplyRetryScheduler/);
  });
});

// ---- Runtime behavior tests -------------------------------------------------

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

const { runSupportReplyRetryCycle, findFailedOutboundReplies } = await import(
  '../../platform/help/SupportReplyRetryScheduler'
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = ((await import('../../platform/email/EmailService')) as any)
  .__sendEmailMock as ReturnType<typeof vi.fn>;

const FAILED_REPLY = {
  reply_id: 7,
  ticket_id: 'tkt_abc',
  body: 'Sorry, the fix is rolling out tonight.',
  email_error: 'connection refused',
  retry_count: 0,
  user_email: 'customer@example.com',
  topic: 'bug',
  inbound_token: 'b'.repeat(24),
};

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
});

describe('runSupportReplyRetryCycle — runtime behavior', () => {
  it('returns early when no failed replies are eligible for retry', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await runSupportReplyRetryCycle();

    expect(r).toEqual({ considered: 0, delivered: 0, failed: 0, attempts: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('re-sends a failed reply, marks it delivered, and increments retry_count in place', async () => {
    queryMock
      // 1. SELECT failed outbound replies
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY] })
      // 2. Atomic claim: conditional UPDATE that bumps retry_count + last_retry_at
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // 3. UPDATE support_ticket_replies recording the result (msg id / error)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 4. UPDATE support_tickets bumping updated_at
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_auto_ok' });

    const r = await runSupportReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.attempts[0]).toMatchObject({
      reply_id: 7,
      ticket_id: 'tkt_abc',
      attempt: 1,
      delivered: true,
      error: null,
    });

    // Outbound email was rendered through the shared path with the right
    // recipient, subject, and reply-to address.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0][0];
    expect(emailArgs.to).toBe('customer@example.com');
    expect(emailArgs.subject).toMatch(/\(tkt_abc\)/);
    expect(emailArgs.text).toContain(FAILED_REPLY.body);
    expect(emailArgs.replyTo).toMatch(/^support\+b{24}@/);

    // The claim UPDATE bumps retry_count and stamps last_retry_at, gated on
    // the reply still being in the same state we observed during SELECT.
    const claimCall = queryMock.mock.calls[1];
    expect(claimCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(claimCall[0]).toMatch(/retry_count = retry_count \+ 1/);
    expect(claimCall[0]).toMatch(/last_retry_at = NOW\(\)/);
    expect(claimCall[0]).toMatch(/AND retry_count = \$2/);
    expect(claimCall[1]).toEqual([7, 0]);

    // The result UPDATE records the message id + error (no longer touches
    // retry_count, since the claim already did).
    const resultCall = queryMock.mock.calls[2];
    expect(resultCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(resultCall[0]).toMatch(/SET email_message_id = \$2,\s*\n\s*email_error = \$3/);
    expect(resultCall[0]).not.toMatch(/retry_count/);
    expect(resultCall[1]).toEqual([7, 'msg_auto_ok', null]);
  });

  it('records the new error and counts the attempt when the retry also fails', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...FAILED_REPLY, retry_count: 1 }] })
      // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // result UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // ticket bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await runSupportReplyRetryCycle();

    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.attempts[0]).toMatchObject({
      attempt: 2,
      delivered: false,
      error: 'still down',
    });

    // Claim was issued with the observed retry_count = 1 so a concurrent
    // worker that already bumped it to 2 cannot double-send.
    expect(queryMock.mock.calls[1][1]).toEqual([7, 1]);
    expect(queryMock.mock.calls[2][1]).toEqual([7, null, 'still down']);
  });

  it('skips a row (no send, no result update) when the atomic claim is lost to a concurrent worker', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY] })
      // Lost claim — another worker bumped retry_count first, so 0 rows match.
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await runSupportReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.attempts).toEqual([]);
    // Critically: no email send and no follow-up writes after the lost claim.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('generates and persists an inbound token when the ticket is missing one', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, inbound_token: null }],
      })
      // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // UPDATE support_tickets SET inbound_token = ...
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // result UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // ticket updated_at bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg' });

    const r = await runSupportReplyRetryCycle();
    expect(r.delivered).toBe(1);

    const tokenUpdate = queryMock.mock.calls[2];
    expect(tokenUpdate[0]).toMatch(/UPDATE support_tickets SET inbound_token = \$2/);
    expect(tokenUpdate[1][0]).toBe('tkt_abc');
    // 24-hex-char token
    expect(tokenUpdate[1][1]).toMatch(/^[0-9a-f]{24}$/);
  });

  it('processes multiple eligible replies in a single cycle', async () => {
    const second = { ...FAILED_REPLY, reply_id: 8, ticket_id: 'tkt_def', user_email: 'other@example.com' };
    queryMock
      .mockResolvedValueOnce({ rowCount: 2, rows: [FAILED_REPLY, second] })
      // reply 1: claim + result UPDATE + ticket bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // reply 2: claim + result UPDATE + ticket bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 8 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock
      .mockResolvedValueOnce({ success: true, messageId: 'm1' })
      .mockResolvedValueOnce({ success: false, error: 'soft bounce' });

    const r = await runSupportReplyRetryCycle();
    expect(r.considered).toBe(2);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});

describe('findFailedOutboundReplies — query shape', () => {
  it('joins support_tickets, filters by direction/error/window, and respects the batch limit', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await findFailedOutboundReplies(3, 60, 25);

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/JOIN support_tickets t/);
    expect(sql).toMatch(/r\.direction = 'outbound'/);
    expect(sql).toMatch(/r\.email_error IS NOT NULL/);
    expect(sql).toMatch(/r\.retry_count < \$1/);
    expect(sql).toMatch(/t\.user_email IS NOT NULL/);
    expect(sql).toMatch(/LIMIT \$3/);

    expect(queryMock.mock.calls[0][1]).toEqual([3, '60', 25]);
  });
});
