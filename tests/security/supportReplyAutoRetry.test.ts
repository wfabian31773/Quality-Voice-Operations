import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPermanentSmtpError } from '../../platform/email/smtpErrorClass';

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
    // MAX_RETRY_ATTEMPTS is derived from REPLY_DELIVERY_ALERT_THRESHOLD so the
    // retry cap and the ops-alert boundary stay in lockstep.
    expect(schedulerFile).toMatch(
      /MAX_RETRY_ATTEMPTS\s*=\s*(?:\d+|REPLY_DELIVERY_ALERT_THRESHOLD)/,
    );
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
  // Wrapper transparently swallows the new suppression / unsubscribe pre-
  // checks and the auto-add INSERT so they never enter `queryMock.mock.calls`
  // — that keeps the existing index/count assertions in this file (e.g.
  // `mock.calls[3][0]`, `toHaveBeenCalledTimes(2)`) accurate to the
  // scheduler queries the tests actually care about.
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

// Tests in this file enqueue per-call DB responses in execution order. The
// scheduler now also runs a suppression / unsubscribe pre-check on every
// reply (and may auto-add an entry on a hard bounce) — those queries are
// orthogonal to the runtime contract being tested here, so we intercept
// them transparently below and let the per-test queue cover the original
// scheduler queries unchanged.
type MockResult = { rowCount: number; rows: unknown[] };
const pendingResults: MockResult[] = [];

function enqueue(...results: MockResult[]): void {
  pendingResults.push(...results);
}

const SUPPRESSION_TABLE_RE =
  /support_email_(unsubscribes|suppressions)/i;

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  pendingResults.length = 0;
  queryMock.mockImplementation(async (sql: unknown) => {
    const sqlText = typeof sql === 'string' ? sql : String(sql ?? '');
    // Suppression / unsubscribe pre-check + auto-add: never on the test's
    // intended timeline, always return a "no match / no-op" answer.
    if (SUPPRESSION_TABLE_RE.test(sqlText)) {
      return { rowCount: 0, rows: [] };
    }
    if (pendingResults.length === 0) {
      throw new Error(
        `Unmocked DB query in test (no enqueue() result available): ${sqlText.slice(0, 120)}`,
      );
    }
    return pendingResults.shift()!;
  });
});

describe('runSupportReplyRetryCycle — runtime behavior', () => {
  it('returns early when no failed replies are eligible for retry', async () => {
    enqueue({ rowCount: 0, rows: [] });

    const r = await runSupportReplyRetryCycle();

    expect(r).toEqual({ considered: 0, delivered: 0, failed: 0, attempts: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('re-sends a failed reply, marks it delivered, and increments retry_count in place', async () => {
      // 1. SELECT failed outbound replies
    enqueue({ rowCount: 1, rows: [FAILED_REPLY] });
      // 2. Atomic claim: conditional UPDATE that bumps retry_count + last_retry_at
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
      // 3. UPDATE support_ticket_replies recording the result (msg id / error)
    enqueue({ rowCount: 1, rows: [] });
      // 4. UPDATE support_tickets bumping updated_at
    enqueue({ rowCount: 1, rows: [] });

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
    enqueue({ rowCount: 1, rows: [{ ...FAILED_REPLY, retry_count: 1 }] });
      // claim
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
      // result UPDATE
    enqueue({ rowCount: 1, rows: [] });
      // ticket bump
    enqueue({ rowCount: 1, rows: [] });

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
    enqueue({ rowCount: 1, rows: [FAILED_REPLY] });
      // Lost claim — another worker bumped retry_count first, so 0 rows match.
    enqueue({ rowCount: 0, rows: [] });

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
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, inbound_token: null }],
      });
      // claim
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
      // UPDATE support_tickets SET inbound_token = ...
    enqueue({ rowCount: 1, rows: [] });
      // result UPDATE
    enqueue({ rowCount: 1, rows: [] });
      // ticket updated_at bump
    enqueue({ rowCount: 1, rows: [] });

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
    enqueue({ rowCount: 2, rows: [FAILED_REPLY, second] });
      // reply 1: claim + result UPDATE + ticket bump
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
    enqueue({ rowCount: 1, rows: [] });
    enqueue({ rowCount: 1, rows: [] });
      // reply 2: claim + result UPDATE + ticket bump
    enqueue({ rowCount: 1, rows: [{ id: 8 }] });
    enqueue({ rowCount: 1, rows: [] });
    enqueue({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'm1' });
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'soft bounce' });

    const r = await runSupportReplyRetryCycle();
    expect(r.considered).toBe(2);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});

describe('isPermanentSmtpError — classifier', () => {
  it.each([
    ['550 5.1.1 The email account that you tried to reach does not exist'],
    ['Message failed: 550 No such user here'],
    ['SMTP code 553: mailbox name not allowed'],
    ['554 5.7.1 Recipient address rejected: Access denied'],
    ['501 5.1.3 Bad recipient address syntax'],
    ['Mailbox unavailable'],
    ['mailbox is full'],
    ['Mailbox not found'],
    ['User unknown in virtual mailbox table'],
    ['Recipient rejected by remote server'],
    ['551 User not local; please try forwarding'],
    ['552 5.2.2 Over quota'],
    ['Quota exceeded for that recipient'],
    ['Permanent failure: address rejected'],
    ['Relay access denied'],
    ['Sender address rejected: Domain not found'],
    ['EENVELOPE: Invalid envelope address'],
    ['No mailbox here by that name'],
  ])('classifies as permanent: %s', (msg) => {
    expect(isPermanentSmtpError(msg)).toBe(true);
  });

  it.each([
    ['connection refused'],
    ['ETIMEDOUT'],
    ['ECONNRESET'],
    ['ECONNREFUSED'],
    ['ENOTFOUND smtp.example.com'],
    ['EAI_AGAIN: temporary failure in name resolution'],
    ['421 Service not available, closing transmission channel'],
    ['450 4.7.1 greylisted, please try again later'],
    ['451 4.3.0 Temporary local problem - please try again later'],
    ['452 4.2.2 Insufficient system storage; try again later'],
    ['Greylisted, retry later'],
    ['still down'],
    ['soft bounce'],
    ['unknown'],
    [''],
    [null],
    [undefined],
  ])('classifies as transient: %s', (msg) => {
    expect(isPermanentSmtpError(msg)).toBe(false);
  });

  it('lets a 4xx numeric code override a permanent-looking phrase later in the string', () => {
    // Real-world example: provider returns "451 4.3.0 try again, mailbox not
    // found right now" — the 4xx code is authoritative; this is transient.
    expect(isPermanentSmtpError('451 4.3.0 try again, mailbox not found right now')).toBe(false);
  });
});

describe('runSupportReplyRetryCycle — permanent SMTP failure handling', () => {
  it('skips the send and bumps retry_count straight to MAX when the prior error is a 5xx', async () => {
      // 1. SELECT failed outbound replies
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '550 5.1.1 user unknown', tenant_id: null }],
      });
      // 2. markReplyPermanentlyFailed: conditional UPDATE bumps retry_count to MAX
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });

    const r = await runSupportReplyRetryCycle();

    // Considered the row but did NOT count it as either delivered or failed —
    // it never went out, the human will see the existing Failed badge.
    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.attempts).toEqual([]);

    // Critically: no email send, no result UPDATE, no ticket bump.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);

    // The exhaust UPDATE jumps retry_count straight to MAX (=3) and is gated
    // on the same observed retry_count so concurrent workers can't double-fire.
    const exhaustCall = queryMock.mock.calls[1];
    expect(exhaustCall[0]).toMatch(/UPDATE support_ticket_replies/);
    expect(exhaustCall[0]).toMatch(/SET retry_count = \$3/);
    expect(exhaustCall[0]).toMatch(/last_retry_at = NOW\(\)/);
    expect(exhaustCall[0]).toMatch(/AND retry_count = \$2/);
    expect(exhaustCall[1]).toEqual([7, 0, 3]);
  });

  it('skips the send for "mailbox not found" / "address rejected" prior failures too', async () => {
      enqueue({
        rowCount: 2,
        rows: [
          { ...FAILED_REPLY, reply_id: 9, email_error: 'Mailbox not found', tenant_id: null },
          { ...FAILED_REPLY, reply_id: 10, email_error: 'Recipient address rejected', tenant_id: null },
        ],
      });
      // exhaust UPDATE for reply 9
    enqueue({ rowCount: 1, rows: [{ id: 9 }] });
      // exhaust UPDATE for reply 10
    enqueue({ rowCount: 1, rows: [{ id: 10 }] });

    const r = await runSupportReplyRetryCycle();

    expect(r.considered).toBe(2);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Only the SELECT and the two exhaust UPDATEs — no claim/result/ticket queries.
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('still retries when the prior error looks transient (connection refused, 4xx, timeout)', async () => {
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '451 4.7.1 greylisted, try again' }],
      });
      // claim
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
      // result UPDATE
    enqueue({ rowCount: 1, rows: [] });
      // ticket bump
    enqueue({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'm-after-greylist' });

    const r = await runSupportReplyRetryCycle();

    expect(r.delivered).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('on a transient retry that hard-bounces, jumps retry_count to MAX in the result UPDATE', async () => {
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, retry_count: 0, email_error: 'connection refused' }],
      });
      // claim
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
      // result UPDATE (with retry_count = MAX)
    enqueue({ rowCount: 1, rows: [] });
      // ticket bump
    enqueue({ rowCount: 1, rows: [] });

    // The send fails permanently this time (rcpt rejected by destination).
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: '550 5.1.1 No such user here',
      permanent: true,
    });

    const r = await runSupportReplyRetryCycle();

    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(1);

    const resultCall = queryMock.mock.calls[2];
    expect(resultCall[0]).toMatch(/UPDATE support_ticket_replies/);
    // The result UPDATE now also writes retry_count when the failure is permanent.
    expect(resultCall[0]).toMatch(/retry_count = \$4/);
    expect(resultCall[1]).toEqual([7, null, '550 5.1.1 No such user here', 3]);
  });

  it('respects EmailService.permanent=true even when the error string alone looks transient', async () => {
    // Belt-and-suspenders: structured permanent flag from EmailService wins
    // even if the human-readable message doesn't match a known keyword.
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, retry_count: 0, email_error: 'connection refused' }],
      });
    enqueue({ rowCount: 1, rows: [{ id: 7 }] });
    enqueue({ rowCount: 1, rows: [] });
    enqueue({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'unusual provider message',
      permanent: true,
    });

    await runSupportReplyRetryCycle();

    // retry_count gets set to MAX because permanent=true.
    expect(queryMock.mock.calls[2][1]).toEqual([7, null, 'unusual provider message', 3]);
  });

  it('does not exhaust the row when the atomic permanent-mark loses the race', async () => {
      enqueue({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '550 mailbox unavailable', tenant_id: null }],
      });
      // permanent-mark UPDATE finds 0 matching rows (concurrent worker won)
    enqueue({ rowCount: 0, rows: [] });

    const r = await runSupportReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No further queries beyond the lost permanent-mark.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('findFailedOutboundReplies — query shape', () => {
  it('joins support_tickets, filters by direction/error/window, and respects the batch limit', async () => {
    enqueue({ rowCount: 0, rows: [] });

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
