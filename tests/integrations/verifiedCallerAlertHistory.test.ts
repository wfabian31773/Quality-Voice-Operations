import { describe, it, expect, beforeEach, vi } from 'vitest';

// All three helpers under test funnel through the same shared mock so we
// can inspect the SQL each emits without standing up a real Postgres.
const queryMock = vi.fn();
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

import {
  getLatestAlertSummariesByCaller,
  listVerifiedCallerAlertHistory,
} from '../../platform/telephony/VerifiedCallerAlertHistory';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getLatestAlertSummariesByCaller', () => {
  it('returns an empty map without hitting the DB when no callers were passed', async () => {
    const result = await getLatestAlertSummariesByCaller([]);
    expect(result.size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('flags allBounced only when every delivery attempt bounced', async () => {
    const dispatchedAt = new Date('2026-04-29T00:00:00Z');
    queryMock.mockResolvedValueOnce({
      rows: [
        // Every recipient bounced — should set allBounced = true.
        {
          caller_id: 'caller-bounced',
          dispatch_id: 'd-1',
          dispatched_at: dispatchedAt,
          health_status: 'expired',
          source: 'scheduler',
          sent_count: '0',
          bounced_count: '3',
          failed_count: '0',
          skipped_count: '0',
          total_count: '3',
        },
        // Mixed delivered+bounced — not all-bounced.
        {
          caller_id: 'caller-mixed',
          dispatch_id: 'd-2',
          dispatched_at: dispatchedAt,
          health_status: 'expiring_soon',
          source: 'scheduler',
          sent_count: '1',
          bounced_count: '1',
          failed_count: '0',
          skipped_count: '0',
          total_count: '2',
        },
        // Bounce mixed with transient failure — not all-bounced.
        {
          caller_id: 'caller-failed',
          dispatch_id: 'd-3',
          dispatched_at: dispatchedAt,
          health_status: 'revoked',
          source: 'admin_reissue',
          sent_count: '0',
          bounced_count: '1',
          failed_count: '1',
          skipped_count: '0',
          total_count: '2',
        },
        // Skipped doesn't disqualify the all-bounced flag because no
        // delivery was attempted for that recipient.
        {
          caller_id: 'caller-bounced-skipped',
          dispatch_id: 'd-4',
          dispatched_at: dispatchedAt,
          health_status: 'expired',
          source: 'scheduler',
          sent_count: '0',
          bounced_count: '1',
          failed_count: '0',
          skipped_count: '2',
          total_count: '3',
        },
      ],
    });

    const result = await getLatestAlertSummariesByCaller([
      { tenantId: 't', callerId: 'caller-bounced' },
      { tenantId: 't', callerId: 'caller-mixed' },
      { tenantId: 't', callerId: 'caller-failed' },
      { tenantId: 't', callerId: 'caller-bounced-skipped' },
    ]);

    expect(result.get('caller-bounced')?.allBounced).toBe(true);
    expect(result.get('caller-mixed')?.allBounced).toBe(false);
    expect(result.get('caller-failed')?.allBounced).toBe(false);
    expect(result.get('caller-bounced-skipped')?.allBounced).toBe(true);
    expect(result.get('caller-bounced-skipped')?.skippedCount).toBe(2);
    expect(result.get('caller-failed')?.source).toBe('admin_reissue');
  });

  it('returns an empty map when the underlying query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const result = await getLatestAlertSummariesByCaller([
      { tenantId: 't', callerId: 'c' },
    ]);
    expect(result.size).toBe(0);
  });
});

describe('listVerifiedCallerAlertHistory', () => {
  it('parses recipient rows into the typed shape', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: '42',
          dispatch_id: 'd-1',
          health_status: 'expired',
          recipient_email: 'admin@example.com',
          recipient_name: 'Ada Lovelace',
          user_id: 'u-1',
          delivery_status: 'bounced',
          delivery_error: 'mailbox full',
          permanent_failure: true,
          source: 'admin_reissue',
          triggered_by_user_id: 'u-9',
          triggered_by_email: 'support@example.com',
          triggered_by_name: 'Support User',
          dispatched_at: new Date('2026-04-29T01:00:00Z'),
        },
      ],
    });

    const rows = await listVerifiedCallerAlertHistory('t', 'c', 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientEmail).toBe('admin@example.com');
    expect(rows[0].deliveryStatus).toBe('bounced');
    expect(rows[0].permanentFailure).toBe(true);
    expect(rows[0].source).toBe('admin_reissue');
    expect(rows[0].triggeredByName).toBe('Support User');
    expect(rows[0].dispatchedAt).toBe('2026-04-29T01:00:00.000Z');
  });

  it('coerces unknown delivery_status values into "failed" so the UI does not crash', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          dispatch_id: 'd',
          health_status: 'expired',
          recipient_email: 'a@b.c',
          recipient_name: null,
          user_id: null,
          delivery_status: 'queued', // future vocabulary
          delivery_error: null,
          permanent_failure: false,
          source: 'scheduler',
          triggered_by_user_id: null,
          triggered_by_email: null,
          triggered_by_name: null,
          dispatched_at: new Date(),
        },
      ],
    });
    const rows = await listVerifiedCallerAlertHistory('t', 'c', 5);
    expect(rows[0].deliveryStatus).toBe('failed');
  });

  it('returns [] when the query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const rows = await listVerifiedCallerAlertHistory('t', 'c', 5);
    expect(rows).toEqual([]);
  });
});
