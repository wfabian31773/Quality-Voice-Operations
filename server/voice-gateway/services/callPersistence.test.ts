import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ clientQueryMock: vi.fn(), releaseMock: vi.fn(), recordStageMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/analytics/ConversionFunnelService', () => ({ recordConversionStage: a.recordStageMock }));
vi.mock('../../../platform/security/FieldEncryption', () => ({
  encryptTranscript: vi.fn(async (_t: string, v: string) => `enc:${v}`),
  encryptSensitiveField: vi.fn(async (_t: string, v: string) => `enc:${v}`),
  decryptSensitiveField: vi.fn(async (_t: string, v: string) => v.replace(/^enc:/, '')),
}));

import { createCallSession, writeCallEvent, updateCallState, finalizeCallSession } from './callPersistence';

beforeEach(() => {
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.recordStageMock.mockReset().mockResolvedValue(undefined);
});

describe('createCallSession', () => {
  it('inserts an encrypted caller number and records the conversion stage', async () => {
    const id = await createCallSession({ tenantId: 't1', agentId: 'ag1', callSid: 'CA1', direction: 'inbound', callerNumber: '+15551230000', calledNumber: '+15559990000', language: 'en' });
    expect(typeof id).toBe('string');
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_sessions'));
    expect(insert).toBeTruthy();
    expect(insert?.[1]).toContain('enc:+15551230000');
    expect(a.recordStageMock).toHaveBeenCalledWith('t1', id, 'call_received', expect.objectContaining({ direction: 'inbound' }));
  });
  it('stores a null caller number when none is given', async () => {
    await createCallSession({ tenantId: 't1', agentId: 'ag1', callSid: 'CA1', direction: 'outbound', callerNumber: '', calledNumber: '+1' });
    const insert = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO call_sessions'));
    expect(insert?.[1]?.[6]).toBeNull();
  });
});

describe('writeCallEvent', () => {
  it('inserts a call event row', async () => {
    await writeCallEvent('t1', 'cs1', 'state_change', 'CALL_RECEIVED', 'ESCALATED', { reason: 'x' });
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO call_events'))).toBe(true);
  });
});

describe('updateCallState', () => {
  it('assembles the SET clause for the provided extras', async () => {
    await updateCallState('t1', 'cs1', 'IN_PROGRESS', { workflowId: 'wf1', context: { a: 1 }, agentId: 'ag2' });
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(String(upd?.[0])).toContain('workflow_id =');
    expect(String(upd?.[0])).toContain('context =');
    expect(String(upd?.[0])).toContain('agent_id =');
  });
  it('auto-creates a ticket on escalation when none exists', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM tickets')) return { rows: [] };
      return { rows: [] };
    });
    await updateCallState('t1', 'cs1', 'ESCALATED', { escalationReason: 'angry caller' });
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO tickets'))).toBe(true);
  });
  it('does not create a duplicate ticket when one already exists', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM tickets')) return { rows: [{ id: 'tk1' }] };
      return { rows: [] };
    });
    await updateCallState('t1', 'cs1', 'ESCALATED');
    expect(a.clientQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO tickets'))).toBe(false);
  });
});

describe('finalizeCallSession', () => {
  it('maps a failed status to CALL_FAILED', async () => {
    await finalizeCallSession('t1', 'cs1', 'failed', 30, 100);
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(upd?.[1]).toContain('CALL_FAILED');
  });
  it('maps any other status to CALL_COMPLETED', async () => {
    await finalizeCallSession('t1', 'cs1', 'completed');
    const upd = a.clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE call_sessions SET'));
    expect(upd?.[1]).toContain('CALL_COMPLETED');
  });
});
