import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { runDocsFeedbackPendingReplyAlertCycle } from '../../platform/help/DocsFeedbackAlertScheduler';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = ((await import('../../platform/db')) as any).__queryMock as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = ((await import('../../platform/email/EmailService')) as any).__sendEmailMock as ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendEmailMock.mockReset();
  queryMock.mockReset();
});

describe('runDocsFeedbackPendingReplyAlertCycle', () => {
  it('returns zero counts and never emails when no comments need attention', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await runDocsFeedbackPendingReplyAlertCycle();

    expect(result).toEqual({ pending: 0, alerted: 0, emailDelivered: false, recipients: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('emails admins and marks pending comments as alerted on successful delivery', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 11,
            article_slug: 'getting-started',
            reply_email: 'reader@example.com',
            comment: 'Where do I find my API key?',
            page_path: '/docs/getting-started',
            created_at: new Date(Date.now() - 30 * 60 * 60 * 1000),
            hours_waiting: 30,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ email: 'admin@qvo.ai' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_1' });

    const result = await runDocsFeedbackPendingReplyAlertCycle();

    expect(result.pending).toBe(1);
    expect(result.alerted).toBe(1);
    expect(result.emailDelivered).toBe(true);
    expect(result.recipients).toBe(1);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const updateCall = queryMock.mock.calls[2];
    expect(updateCall[0]).toMatch(/SET pending_reply_alerted_at = NOW\(\)/);
    expect(updateCall[1]).toEqual([[11]]);
  });

  it('does not mark comments as alerted when email delivery fails', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 22,
            article_slug: 'billing',
            reply_email: 'reader2@example.com',
            comment: 'Refund question',
            page_path: '/docs/billing',
            created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
            hours_waiting: 48,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ email: 'admin@qvo.ai' }] });

    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'smtp down' });

    const result = await runDocsFeedbackPendingReplyAlertCycle();

    expect(result.pending).toBe(1);
    expect(result.alerted).toBe(0);
    expect(result.emailDelivered).toBe(false);
    // Only the find query and the admin-emails query were issued; no UPDATE.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('marks comments as alerted even when there are no admin recipients to avoid repeat logging', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 33,
            article_slug: 'integrations',
            reply_email: 'reader3@example.com',
            comment: null,
            page_path: null,
            created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
            hours_waiting: 25,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // no admin emails
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await runDocsFeedbackPendingReplyAlertCycle();

    expect(result.alerted).toBe(1);
    expect(result.emailDelivered).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls[2][0]).toMatch(/SET pending_reply_alerted_at = NOW\(\)/);
  });

  it('uses the documented threshold and cooldown when querying pending comments', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await runDocsFeedbackPendingReplyAlertCycle();

    const findCall = queryMock.mock.calls[0];
    expect(findCall[0]).toMatch(/created_at <= NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
    expect(findCall[0]).toMatch(/pending_reply_alerted_at <= NOW\(\) - \(\$2 \|\| ' hours'\)::interval/);
    expect(findCall[1][0]).toBe('24');
    expect(findCall[1][1]).toBe('24');
  });
});
