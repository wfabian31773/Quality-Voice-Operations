import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Static contract tests --------------------------------------------------
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/DocsFeedbackReplyRetryScheduler.ts'),
  'utf8',
);
const startFile = readFileSync(
  join(process.cwd(), 'server/admin-api/start.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'migrations/072_docs_feedback_replies_retry_count.sql'),
  'utf8',
);
const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const sharedHelper = readFileSync(
  join(process.cwd(), 'platform/help/docsFeedbackReplyEmail.ts'),
  'utf8',
);

describe('DocsFeedbackReplyRetryScheduler — wiring & contract', () => {
  it('migration adds retry_count and last_retry_at columns', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS retry_count/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS last_retry_at/);
  });

  it('only retries failed replies inside the lookback window with retries remaining', () => {
    expect(schedulerFile).toMatch(/email_error IS NOT NULL/);
    expect(schedulerFile).toMatch(/retry_count < \$1/);
    expect(schedulerFile).toMatch(/created_at >= NOW\(\) - \(\$2 \|\| ' minutes'\)::interval/);
  });

  it('caps total automatic attempts so the human still sees a Failed badge eventually', () => {
    // MAX_RETRY_ATTEMPTS is derived from DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD
    // so the retry cap and the ops-alert boundary stay in lockstep.
    expect(schedulerFile).toMatch(
      /MAX_RETRY_ATTEMPTS\s*=\s*(?:\d+|DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD)/,
    );
  });

  it('updates the row in place: increments retry_count and sets last_retry_at', () => {
    expect(schedulerFile).toMatch(/UPDATE docs_feedback_replies/);
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

  it('gates every send on shouldAutoRetryFailedDocsFeedbackReply', () => {
    expect(schedulerFile).toMatch(/shouldAutoRetryFailedDocsFeedbackReply/);
  });

  it('reuses the same renderDocsFeedbackReplyEmail helper as the manual retry', () => {
    expect(schedulerFile).toMatch(/renderDocsFeedbackReplyEmail/);
    expect(schedulerFile).toMatch(/sendEmail\(/);
    expect(supportFile).toMatch(/from '\.\.\/\.\.\/\.\.\/platform\/help\/docsFeedbackReplyEmail'/);
    expect(sharedHelper).toMatch(/export function renderDocsFeedbackReplyEmail/);
  });

  it('is started and stopped alongside the admin API, next to the digest scheduler', () => {
    expect(startFile).toMatch(/startDocsFeedbackReplyRetryScheduler/);
    expect(startFile).toMatch(/stopDocsFeedbackReplyRetryScheduler/);
    // Wired right next to the digest scheduler so the two are obviously paired.
    expect(startFile).toMatch(
      /startDocsFeedbackReplyDigestScheduler\(\);\s*\n\s*startDocsFeedbackReplyRetryScheduler\(\);/,
    );
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

vi.mock('../../platform/core/observability', () => {
  const logErrorMock = vi.fn().mockResolvedValue(undefined);
  return {
    __logErrorMock: logErrorMock,
    logError: logErrorMock,
  };
});

const { runDocsFeedbackReplyRetryCycle, findFailedOutboundDocsFeedbackReplies } =
  await import('../../platform/help/DocsFeedbackReplyRetryScheduler');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = ((await import('../../platform/email/EmailService')) as any)
  .__sendEmailMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logErrorMock = ((await import('../../platform/core/observability')) as any)
  .__logErrorMock as ReturnType<typeof vi.fn>;

const FAILED_REPLY = {
  reply_id: 7,
  feedback_id: 42,
  article_slug: 'getting-started',
  to_email: 'reader@example.com',
  subject: 'Re: your feedback on getting-started',
  body: 'Thanks for the heads up — fixed in the latest deploy.',
  email_error: 'connection refused',
  retry_count: 0,
  original_comment: 'The screenshot in step 3 is out of date.',
};

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  logErrorMock.mockReset();
  logErrorMock.mockResolvedValue(undefined);
});

// Wait for any background promises (alert dispatch is fire-and-forget).
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('runDocsFeedbackReplyRetryCycle — runtime behavior', () => {
  it('returns early when no failed replies are eligible for retry', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r).toEqual({ considered: 0, delivered: 0, failed: 0, attempts: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('re-sends a failed reply, marks it delivered, and increments retry_count in place', async () => {
    queryMock
      // 1. SELECT failed outbound replies
      .mockResolvedValueOnce({ rowCount: 1, rows: [FAILED_REPLY] })
      // 2. Atomic claim: conditional UPDATE that bumps retry_count + last_retry_at
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // 3. UPDATE docs_feedback_replies recording the result (msg id / error)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // 4. UPDATE docs_feedback bumping reply_count after success
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_auto_ok' });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.attempts[0]).toMatchObject({
      reply_id: 7,
      feedback_id: 42,
      attempt: 1,
      delivered: true,
      error: null,
    });

    // Outbound email used the original recipient + subject and the rendered
    // body quoted the original feedback comment.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0][0];
    expect(emailArgs.to).toBe('reader@example.com');
    expect(emailArgs.subject).toBe('Re: your feedback on getting-started');
    expect(emailArgs.text).toContain(FAILED_REPLY.body);
    expect(emailArgs.text).toContain('The screenshot in step 3 is out of date.');
    expect(emailArgs.html).toContain('getting-started');

    // The claim UPDATE bumps retry_count and stamps last_retry_at, gated on
    // the reply still being in the same state we observed during SELECT.
    const claimCall = queryMock.mock.calls[1];
    expect(claimCall[0]).toMatch(/UPDATE docs_feedback_replies/);
    expect(claimCall[0]).toMatch(/retry_count = retry_count \+ 1/);
    expect(claimCall[0]).toMatch(/last_retry_at = NOW\(\)/);
    expect(claimCall[0]).toMatch(/AND retry_count = \$2/);
    expect(claimCall[1]).toEqual([7, 0]);

    // Result UPDATE records the message id + null error, doesn't touch retry_count.
    const resultCall = queryMock.mock.calls[2];
    expect(resultCall[0]).toMatch(/UPDATE docs_feedback_replies/);
    expect(resultCall[0]).toMatch(/SET email_message_id = \$2,\s*\n\s*email_error = \$3/);
    expect(resultCall[0]).not.toMatch(/retry_count/);
    expect(resultCall[1]).toEqual([7, 'msg_auto_ok', null]);

    // reply_count bumped on success only.
    const bumpCall = queryMock.mock.calls[3];
    expect(bumpCall[0]).toMatch(/UPDATE docs_feedback SET reply_count = reply_count \+ 1/);
    expect(bumpCall[1]).toEqual([42]);
  });

  it('records the new error and counts the attempt when the retry also fails (transient)', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...FAILED_REPLY, retry_count: 1 }] })
      // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // result UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.attempts[0]).toMatchObject({
      attempt: 2,
      delivered: false,
      error: 'still down',
    });

    // No reply_count bump on a failed send.
    expect(queryMock.mock.calls.some((c) => /reply_count/.test(c[0] as string))).toBe(false);
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

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.attempts).toEqual([]);
    // Critically: no email send and no follow-up writes after the lost claim.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('processes multiple eligible replies in a single cycle', async () => {
    const second = {
      ...FAILED_REPLY,
      reply_id: 8,
      feedback_id: 43,
      to_email: 'other@example.com',
      article_slug: 'other-doc',
    };
    queryMock
      .mockResolvedValueOnce({ rowCount: 2, rows: [FAILED_REPLY, second] })
      // reply 1: claim + result UPDATE + reply_count bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // reply 2: claim + result UPDATE  (failed send, no reply_count bump)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 8 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock
      .mockResolvedValueOnce({ success: true, messageId: 'm1' })
      .mockResolvedValueOnce({ success: false, error: 'soft bounce' });

    const r = await runDocsFeedbackReplyRetryCycle();
    expect(r.considered).toBe(2);
    expect(r.delivered).toBe(1);
    expect(r.failed).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});

describe('runDocsFeedbackReplyRetryCycle — permanent SMTP failure handling', () => {
  it('skips the send and bumps retry_count straight to MAX when the prior error is a 5xx', async () => {
    queryMock
      // 1. SELECT failed outbound replies
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '550 5.1.1 user unknown' }],
      })
      // 2. markReplyPermanentlyFailed: conditional UPDATE bumps retry_count to MAX
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] });

    const r = await runDocsFeedbackReplyRetryCycle();

    // Considered the row but did NOT count it as either delivered or failed —
    // it never went out, the human will see the existing Failed badge.
    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.attempts).toEqual([]);

    // Critically: no email send and no result UPDATE.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);

    // The exhaust UPDATE jumps retry_count straight to MAX (=3) and is gated
    // on the same observed retry_count so concurrent workers can't double-fire.
    const exhaustCall = queryMock.mock.calls[1];
    expect(exhaustCall[0]).toMatch(/UPDATE docs_feedback_replies/);
    expect(exhaustCall[0]).toMatch(/SET retry_count = \$3/);
    expect(exhaustCall[0]).toMatch(/last_retry_at = NOW\(\)/);
    expect(exhaustCall[0]).toMatch(/AND retry_count = \$2/);
    expect(exhaustCall[1]).toEqual([7, 0, 3]);

    // Boundary-cross alert fired once for the threshold transition.
    await flushMicrotasks();
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const alertCall = logErrorMock.mock.calls[0];
    expect(alertCall[1]).toBe('critical');
    expect(alertCall[2]).toMatch(/Docs feedback reply 7/);
    expect(alertCall[3].errorCode).toBe('docs_feedback_reply_delivery_failed');
  });

  it('skips the send for "mailbox not found" / "address rejected" prior failures too', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { ...FAILED_REPLY, reply_id: 9, email_error: 'Mailbox not found' },
          { ...FAILED_REPLY, reply_id: 10, email_error: 'Recipient address rejected' },
        ],
      })
      // exhaust UPDATE for reply 9
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] })
      // exhaust UPDATE for reply 10
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10 }] });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.considered).toBe(2);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Only the SELECT and the two exhaust UPDATEs — no claim/result/bump queries.
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('still retries when the prior error looks transient (4xx greylisting)', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '451 4.7.1 greylisted, try again' }],
      })
      // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // result UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      // reply_count bump
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'm-after-greylist' });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.delivered).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('on a transient retry that hard-bounces, jumps retry_count to MAX in the result UPDATE and fires the alert', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, retry_count: 0, email_error: 'connection refused' }],
      })
      // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      // result UPDATE (with retry_count = MAX)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    // The send fails permanently this time (rcpt rejected by destination).
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: '550 5.1.1 No such user here',
      permanent: true,
    });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(1);

    const resultCall = queryMock.mock.calls[2];
    expect(resultCall[0]).toMatch(/UPDATE docs_feedback_replies/);
    // The result UPDATE now also writes retry_count when the failure is permanent.
    expect(resultCall[0]).toMatch(/retry_count = \$4/);
    expect(resultCall[1]).toEqual([7, null, '550 5.1.1 No such user here', 3]);

    // Alert fires because effective retry_count crossed the threshold.
    await flushMicrotasks();
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it('does not exhaust the row when the atomic permanent-mark loses the race', async () => {
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, email_error: '550 mailbox unavailable' }],
      })
      // permanent-mark UPDATE finds 0 matching rows (concurrent worker won)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r.considered).toBe(1);
    expect(r.delivered).toBe(0);
    expect(r.failed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No further queries beyond the lost permanent-mark.
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Alert NOT fired since this worker didn't actually advance the row.
    await flushMicrotasks();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('does not re-fire the alert on subsequent failed retries (threshold-cross is a one-shot)', async () => {
    // retry_count is already at 2 (one short of threshold). A failed retry
    // takes it to 3 → alert fires once. The next cycle would observe
    // retry_count = 3 and the SELECT excludes it (retry_count < $1).
    queryMock
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...FAILED_REPLY, retry_count: 2, email_error: 'connection refused' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'still down' });

    await runDocsFeedbackReplyRetryCycle();
    await flushMicrotasks();

    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('findFailedOutboundDocsFeedbackReplies — query shape', () => {
  it('joins docs_feedback, filters by error/window, and respects the batch limit', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await findFailedOutboundDocsFeedbackReplies(3, 60, 25);

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/JOIN docs_feedback f/);
    expect(sql).toMatch(/r\.email_error IS NOT NULL/);
    expect(sql).toMatch(/r\.retry_count < \$1/);
    expect(sql).toMatch(/r\.to_email IS NOT NULL/);
    expect(sql).toMatch(/LIMIT \$3/);

    expect(queryMock.mock.calls[0][1]).toEqual([3, '60', 25]);
  });

  it('skips failed rows that already have a newer reply for the same feedback (manual retry happened)', async () => {
    // Anti-duplicate guard: the manual /retry endpoint INSERTs a new row
    // for each retry attempt, so without this NOT EXISTS the scheduler
    // would re-send the original failed row and the reader would receive
    // the same reply twice. The query must filter on "no newer reply
    // exists for this feedback_id" so a successful manual retry leaves
    // the original row alone.
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await findFailedOutboundDocsFeedbackReplies();

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/FROM docs_feedback_replies r2/);
    expect(sql).toMatch(/r2\.feedback_id = r\.feedback_id/);
    expect(sql).toMatch(/r2\.id <> r\.id/);
    expect(sql).toMatch(/r2\.created_at > r\.created_at/);
  });
});

describe('runDocsFeedbackReplyRetryCycle — manual-retry coexistence', () => {
  it('the SELECT excludes a stale failed row once a manual retry has inserted a newer reply', async () => {
    // Simulate the post-manual-retry world: the SELECT runs against the
    // real DB and the NOT EXISTS clause filters out the now-superseded
    // failed row, so the scheduler considers nothing and never sends.
    // From the scheduler's perspective this looks identical to an empty
    // failed-reply pool, which is exactly the point — no double-send.
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const r = await runDocsFeedbackReplyRetryCycle();

    expect(r).toEqual({ considered: 0, delivered: 0, failed: 0, attempts: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Only the SELECT ran — no claim, no send, no result UPDATE.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
