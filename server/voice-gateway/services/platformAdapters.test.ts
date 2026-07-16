import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({
  clientQueryMock: vi.fn(), releaseMock: vi.fn(),
  executeByPayloadMock: vi.fn(), isStandardEventMock: vi.fn(), dispatchEventMock: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/integrations/connectors', () => ({
  connectorService: {
    executeByPayload: a.executeByPayloadMock,
    isStandardEvent: a.isStandardEventMock,
    dispatchEvent: a.dispatchEventMock,
  },
}));

import { createCallerMemoryStorage, createOutboxAdapters } from './platformAdapters';

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.executeByPayloadMock.mockReset().mockResolvedValue({ success: true, ticketNumber: 'TK-1', externalId: 'ext1' });
  a.isStandardEventMock.mockReset().mockReturnValue(false);
  a.dispatchEventMock.mockReset().mockResolvedValue(undefined);
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
  process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = 'v2';
  process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY = 'a-previous-lookup-key-with-at-least-32-characters';
  process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION = 'v1';
});

describe('createCallerMemoryStorage.getCallHistoryByPhone', () => {
  it('queries by tenant-scoped caller HMAC without sending plaintext phone variants to PostgreSQL', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => sql.includes('FROM call_sessions') ? { rows: [{ createdAt: 'd', callReason: 'billing' }] } : { rows: [] });
    const storage = createCallerMemoryStorage();
    const res = await storage.getCallHistoryByPhone('t1' as never, '2125550123', 5);
    expect(res ?? []).toHaveLength(1);
    const call = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('FROM call_sessions'));
    expect(String(call?.[0])).toContain('caller_lookup_hash = ANY($2::text[])');
    expect(call?.[1]).toEqual(['t1', [
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ], 5]);
    expect(JSON.stringify(call?.[1])).not.toContain('2125550123');
  });

  it('returns no history and performs no PHI query when the lookup key is unavailable', async () => {
    delete process.env.QVO_PII_LOOKUP_HMAC_KEY;
    const storage = createCallerMemoryStorage();
    await expect(storage.getCallHistoryByPhone('t1' as never, '2125550123', 5)).resolves.toEqual([]);
    expect(a.clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('FROM call_sessions'))).toBe(false);
  });
});

describe('createOutboxAdapters.persistence', () => {
  it('insert returns a generated id', async () => {
    const { persistence } = createOutboxAdapters();
    const res = await persistence.insert({ tenantId: 't1' as never, payload: { type: 'create_ticket' }, status: 'pending', maxRetries: 3, nextRetryAt: new Date() } as never);
    expect(typeof res?.id).toBe('string');
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO outbox_messages'))).toBe(true);
  });
  it('findByIdempotencyKey returns null when absent, mapped row when present', async () => {
    const { persistence } = createOutboxAdapters();
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    expect(await persistence.findByIdempotencyKey('t1' as never, 'k')).toBeNull();
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'o1', status: 'pending', ticketNumber: 'TK-9' }] });
    expect(await persistence.findByIdempotencyKey('t1' as never, 'k')).toMatchObject({ id: 'o1', status: 'pending', ticketNumber: 'TK-9' });
  });
  it('claimForSending returns null when nothing is claimable and a parsed payload otherwise', async () => {
    const { persistence } = createOutboxAdapters();
    a.clientQueryMock.mockResolvedValue({ rows: [] });
    expect(await persistence.claimForSending('t1' as never, 'o1', 1000)).toBeNull();
    a.clientQueryMock.mockResolvedValue({ rows: [{ id: 'o1', retryCount: 2, payload: '{"type":"send_sms"}' }] });
    expect(await persistence.claimForSending('t1' as never, 'o1', 1000)).toMatchObject({ id: 'o1', retryCount: 2, payload: { type: 'send_sms' } });
  });
  it('getStats folds retry into failed and defaults missing buckets to 0', async () => {
    const { persistence } = createOutboxAdapters();
    a.clientQueryMock.mockResolvedValue({ rows: [{ status: 'sent', count: 3 }, { status: 'retry', count: 2 }, { status: 'failed', count: 1 }] });
    expect(await persistence.getStats('t1' as never)).toEqual({ pending: 0, sending: 0, sent: 3, failed: 3, deadLetter: 0 });
  });
  it('markSent and markFailed issue updates', async () => {
    const { persistence } = createOutboxAdapters();
    await persistence.markSent('t1' as never, 'o1', 'TK-1', 'ext1');
    await persistence.markFailed('t1' as never, 'o1', 1, 'boom', new Date(), false);
    const sqls = a.clientQueryMock.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.includes("status = 'sent'"))).toBe(true);
    expect(sqls.some((s) => s.includes('last_error ='))).toBe(true);
  });
});

describe('createOutboxAdapters.integration.send', () => {
  it('rejects a payload without a type', async () => {
    const { integration } = createOutboxAdapters();
    expect(await integration.send('t1' as never, {})).toEqual({ success: false, error: 'Payload missing type field' });
  });
  it('executes the connector and maps a non-standard event to a standard one for fan-out', async () => {
    const { integration } = createOutboxAdapters();
    const res = await integration.send('t1' as never, { type: 'create_ticket' });
    expect(res).toMatchObject({ success: true, ticketNumber: 'TK-1', externalId: 'ext1' });
    expect(a.dispatchEventMock).toHaveBeenCalledWith('t1', 'ticket.created', expect.objectContaining({ type: 'ticket.created' }));
  });
  it('dispatches a standard event directly', async () => {
    a.isStandardEventMock.mockReturnValue(true);
    const { integration } = createOutboxAdapters();
    await integration.send('t1' as never, { type: 'ticket.created' });
    expect(a.dispatchEventMock).toHaveBeenCalledWith('t1', 'ticket.created', expect.any(Object));
  });
  it('returns an error result when the connector throws', async () => {
    a.executeByPayloadMock.mockRejectedValue(new Error('connector down'));
    const { integration } = createOutboxAdapters();
    expect(await integration.send('t1' as never, { type: 'send_sms' })).toEqual({ success: false, error: 'connector down' });
  });
});
