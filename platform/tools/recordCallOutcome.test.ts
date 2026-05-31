import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, releaseMock, recordConversionStageMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  recordConversionStageMock: vi.fn(),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: queryMock, release: releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

vi.mock('../analytics/ConversionFunnelService', () => ({
  recordConversionStage: recordConversionStageMock,
}));

import { recordCallOutcomeTool } from './recordCallOutcome';

const ctx = { tenantId: 'tenant-1', callLogId: 'call-1', callSid: 'CA1' };

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  recordConversionStageMock.mockReset();
  recordConversionStageMock.mockResolvedValue(undefined);
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('UPDATE call_sessions')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe('record_call_outcome tool', () => {
  it('requires a disposition', async () => {
    const r = (await recordCallOutcomeTool.handler({}, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('disposition is required');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('requires an active call session', async () => {
    const r = (await recordCallOutcomeTool.handler({ disposition: 'resolved' }, { tenantId: 't' })) as {
      success: boolean;
      message: string;
    };
    expect(r.success).toBe(false);
    expect(r.message).toContain('No active call session');
  });

  it('records the outcome and emits conversion stages for a resolved call', async () => {
    const r = (await recordCallOutcomeTool.handler({ disposition: 'resolved', notes: 'all good' }, ctx)) as {
      success: boolean;
      outcome: { disposition: string; followUpRequired: boolean };
    };
    expect(r.success).toBe(true);
    expect(r.outcome.disposition).toBe('resolved');
    expect(r.outcome.followUpRequired).toBe(false);
    // 'resolved' maps to 4 funnel stages
    expect(recordConversionStageMock).toHaveBeenCalledTimes(4);
  });

  it('defaults followUpRequired to true for callback_requested', async () => {
    const r = (await recordCallOutcomeTool.handler({ disposition: 'callback_requested' }, ctx)) as {
      outcome: { followUpRequired: boolean };
    };
    expect(r.outcome.followUpRequired).toBe(true);
  });

  it('reports when the call session was not found', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE call_sessions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const r = (await recordCallOutcomeTool.handler({ disposition: 'resolved' }, ctx)) as {
      success: boolean;
      message: string;
    };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Call session not found');
  });

  it('returns a safe error when the update throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('db down');
    });
    const r = (await recordCallOutcomeTool.handler({ disposition: 'resolved' }, ctx)) as {
      success: boolean;
      message: string;
    };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Failed to record call outcome');
  });
});
