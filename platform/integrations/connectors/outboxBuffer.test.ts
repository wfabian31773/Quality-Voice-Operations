import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withPrivilegedClientMock, queryMock } = vi.hoisted(() => ({
  withPrivilegedClientMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  withPrivilegedClient: withPrivilegedClientMock,
}));

import {
  bufferOutboxEvent,
  deriveOutboxIdempotencyKey,
  markOutboxRowDelivered,
  markOutboxRowPendingAfterInlineFailure,
} from './outboxBuffer';

function withClient<T>(fn: (client: { query: typeof queryMock }) => Promise<T>): Promise<T> {
  return fn({ query: queryMock });
}

describe('deriveOutboxIdempotencyKey', () => {
  it('returns a stable key when the payload has an appointmentId', () => {
    const k1 = deriveOutboxIdempotencyKey('appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-1',
    });
    const k2 = deriveOutboxIdempotencyKey('appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-1',
    });
    expect(k1).toBe(k2);
    expect(k1).toContain('appointment.booked');
    expect(k1).toContain('appt-1');
  });

  it('produces different keys for different event types on the same appointmentId', () => {
    const booked = deriveOutboxIdempotencyKey('appointment.booked', {
      type: 'appointment.booked',
      appointmentId: 'appt-1',
    });
    const cancelled = deriveOutboxIdempotencyKey('appointment.cancelled', {
      type: 'appointment.cancelled',
      appointmentId: 'appt-1',
    });
    expect(booked).not.toBe(cancelled);
  });

  it('combines multiple identifiers when present so unrelated events do not collide', () => {
    const a = deriveOutboxIdempotencyKey('call.completed', {
      type: 'call.completed',
      callSessionId: 'sess-1',
      callSid: 'CA-1',
    });
    const b = deriveOutboxIdempotencyKey('call.completed', {
      type: 'call.completed',
      callSessionId: 'sess-2',
      callSid: 'CA-1',
    });
    expect(a).not.toBe(b);
    expect(a).toContain('callSessionId=sess-1');
    expect(a).toContain('callSid=CA-1');
  });

  it('falls back to a random UUID when no stable identifier is available', () => {
    const a = deriveOutboxIdempotencyKey('sms.sent', { type: 'sms.sent' });
    const b = deriveOutboxIdempotencyKey('sms.sent', { type: 'sms.sent' });
    expect(a).not.toBe(b);
    expect(a).toContain('random=');
  });

  it('truncates to the column limit of 200 characters', () => {
    const longId = 'x'.repeat(500);
    const key = deriveOutboxIdempotencyKey('call.completed', {
      type: 'call.completed',
      callSessionId: longId,
    });
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe('bufferOutboxEvent', () => {
  beforeEach(() => {
    withPrivilegedClientMock.mockReset();
    queryMock.mockReset();
    withPrivilegedClientMock.mockImplementation(withClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a pending row and returns the new rowId on first fire', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'outbox-row-1' }] });

    const result = await bufferOutboxEvent(
      'tenant-1' as never,
      'call.completed',
      'evt:call.completed:callSessionId=sess-1',
      { type: 'call.completed', callSessionId: 'sess-1' },
    );

    expect(result.rowId).toBe('outbox-row-1');
    expect(result.alreadyDelivered).toBe(false);
    const insertCall = queryMock.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO outbox_events');
    expect(insertCall[0]).toContain("ON CONFLICT");
    expect(insertCall[0]).toContain("'pending'");
    expect(insertCall[1]).toEqual([
      'tenant-1',
      'evt:call.completed:callSessionId=sess-1',
      'call.completed',
      JSON.stringify({ type: 'call.completed', callSessionId: 'sess-1' }),
      expect.any(String),
    ]);
  });

  it('returns alreadyDelivered=true when the existing row is delivered', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'outbox-row-1', status: 'delivered' }],
    });

    const result = await bufferOutboxEvent(
      'tenant-1' as never,
      'appointment.booked',
      'evt:appointment.booked:appointmentId=appt-1',
      { type: 'appointment.booked', appointmentId: 'appt-1' },
    );

    expect(result).toEqual({ rowId: 'outbox-row-1', alreadyDelivered: true });
  });

  it('returns the existing row in pending state when the insert is a no-op', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'outbox-row-2', status: 'pending' }],
    });

    const result = await bufferOutboxEvent(
      'tenant-1' as never,
      'appointment.booked',
      'evt:appointment.booked:appointmentId=appt-2',
      { type: 'appointment.booked', appointmentId: 'appt-2' },
    );

    expect(result).toEqual({ rowId: 'outbox-row-2', alreadyDelivered: false });
  });

  it('degrades to a null rowId when the DB layer throws', async () => {
    withPrivilegedClientMock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    const result = await bufferOutboxEvent(
      'tenant-1' as never,
      'call.completed',
      'evt:call.completed:random=abc',
      { type: 'call.completed' },
    );

    expect(result).toEqual({ rowId: null, alreadyDelivered: false });
  });

  it('degrades to a null rowId when withPrivilegedClient returns nothing', async () => {
    withPrivilegedClientMock.mockResolvedValueOnce(undefined);

    const result = await bufferOutboxEvent(
      'tenant-1' as never,
      'call.completed',
      'evt:call.completed:random=abc',
      { type: 'call.completed' },
    );

    expect(result).toEqual({ rowId: null, alreadyDelivered: false });
  });
});

describe('markOutboxRowDelivered', () => {
  beforeEach(() => {
    withPrivilegedClientMock.mockReset();
    queryMock.mockReset();
    withPrivilegedClientMock.mockImplementation(withClient);
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('marks a row as delivered without overwriting terminal states', async () => {
    await markOutboxRowDelivered('outbox-row-1');
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'delivered'");
    expect(sql).toContain("delivered_at = NOW()");
    expect(sql).toContain("status IN ('pending', 'processing', 'failed')");
    expect(queryMock.mock.calls[0][1]).toEqual(['outbox-row-1']);
  });

  it('swallows DB errors so dispatch callers do not see secondary failures', async () => {
    withPrivilegedClientMock.mockImplementationOnce(async () => {
      throw new Error('write failed');
    });
    await expect(markOutboxRowDelivered('outbox-row-1')).resolves.toBeUndefined();
  });
});

describe('markOutboxRowPendingAfterInlineFailure', () => {
  beforeEach(() => {
    withPrivilegedClientMock.mockReset();
    queryMock.mockReset();
    withPrivilegedClientMock.mockImplementation(withClient);
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('resets next_attempt_at so the drain picks the row up immediately', async () => {
    await markOutboxRowPendingAfterInlineFailure('outbox-row-1', 'hubspot down');
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('next_attempt_at = NOW()');
    expect(sql).toContain("status NOT IN ('delivered', 'dead_letter')");
    expect(queryMock.mock.calls[0][1]).toEqual(['outbox-row-1', 'hubspot down']);
  });

  it('truncates excessively long error messages to avoid blowing up the row', async () => {
    const huge = 'x'.repeat(5000);
    await markOutboxRowPendingAfterInlineFailure('outbox-row-1', huge);
    const value = queryMock.mock.calls[0][1] as unknown[];
    expect((value[1] as string).length).toBeLessThanOrEqual(4001);
    expect(value[1]).toMatch(/…$/);
  });
});
