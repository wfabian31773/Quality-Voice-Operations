import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, poolQueryMock, releaseMock, recordTraceMock, recordActivationEventMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  recordTraceMock: vi.fn(),
  recordActivationEventMock: vi.fn(),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({ query: queryMock, release: releaseMock }),
    query: poolQueryMock,
  }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

vi.mock('../core/observability/traceLogger', () => ({ recordTrace: recordTraceMock }));
vi.mock('../activation/ActivationService', () => ({ recordActivationEvent: recordActivationEventMock }));

import {
  createToolExecution,
  completeToolExecution,
  getToolExecution,
  listToolExecutions,
  getToolExecutionStats,
} from './ToolExecutionService';

beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  releaseMock.mockReset();
  recordTraceMock.mockReset();
  recordActivationEventMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  poolQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  recordTraceMock.mockResolvedValue(undefined);
  recordActivationEventMock.mockResolvedValue(undefined);
});

// completeToolExecution fires a dynamic import('../activation/...') without
// awaiting it; drain microtasks + a timer so it resolves before the test ends
// (otherwise it leaks into the next test's assertions).
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 25));
};

describe('createToolExecution', () => {
  it('inserts a running record, returns an id, and traces when a call session is present', async () => {
    const id = await createToolExecution({
      tenantId: 'tenant-1',
      callSessionId: 'cs-1',
      toolName: 'lookup_customer',
      parameters: { phone: '555-123-4567' },
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO tool_invocations'))).toBe(true);
    expect(recordTraceMock).toHaveBeenCalledWith(expect.objectContaining({ traceType: 'tool_invoked' }));
  });

  it('does not trace when there is no call session', async () => {
    await createToolExecution({ tenantId: 'tenant-1', toolName: 'lookup_customer', parameters: {} });
    expect(recordTraceMock).not.toHaveBeenCalled();
  });

  it('still returns an id when the insert fails', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('insert failed');
    });
    const id = await createToolExecution({ tenantId: 'tenant-1', toolName: 'x', parameters: {} });
    expect(id).toBeTruthy();
  });
});

describe('completeToolExecution', () => {
  it('updates the record and records an activation event on success', async () => {
    await completeToolExecution({
      tenantId: 'tenant-1',
      executionId: 'exec-1',
      result: { ok: true },
      status: 'success',
      durationMs: 42,
    });
    await flush();
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE tool_invocations'))).toBe(true);
    expect(recordActivationEventMock).toHaveBeenCalledWith('tenant-1', 'tenant_first_workflow_execution', expect.any(Object));
  });

  it('flags the call session on failure', async () => {
    await completeToolExecution({
      tenantId: 'tenant-1',
      executionId: 'exec-1',
      callSessionId: 'cs-1',
      result: null,
      status: 'failed',
      errorMessage: 'boom',
      durationMs: 10,
    });
    await flush();
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('has_tool_failure'))).toBe(true);
    expect(recordActivationEventMock).not.toHaveBeenCalled();
  });
});

describe('getToolExecution', () => {
  it('returns null when no row matches', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM tool_invocations') ? { rows: [] } : { rows: [], rowCount: 1 },
    );
    expect(await getToolExecution('tenant-1', 'missing')).toBeNull();
  });

  it('maps a row into a ToolExecutionRecord', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tool_invocations')) {
        return {
          rows: [{
            id: 'exec-1', tenant_id: 'tenant-1', call_session_id: 'cs-1', agent_id: null,
            agent_slug: 'sales', tool_name: 'lookup_customer', parameters_redacted: { a: 1 },
            result: { ok: true }, status: 'success', error_message: null, recovery_action: null,
            duration_ms: 12, invoked_at: new Date('2026-05-01T00:00:00Z'), completed_at: null,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const rec = await getToolExecution('tenant-1', 'exec-1');
    expect(rec).toMatchObject({ id: 'exec-1', toolName: 'lookup_customer', status: 'success', agentSlug: 'sales' });
    expect(rec?.invokedAt).toContain('2026-05-01');
  });
});

describe('listToolExecutions', () => {
  it('applies filters and returns a paged result with a total', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '2' }] };
      if (sql.includes('ORDER BY invoked_at DESC')) {
        return { rows: [
          { id: 'e1', tenant_id: 't', tool_name: 'a', status: 'success', parameters_redacted: {}, invoked_at: null, completed_at: null },
          { id: 'e2', tenant_id: 't', tool_name: 'b', status: 'failed', parameters_redacted: {}, invoked_at: null, completed_at: null },
        ] };
      }
      return { rows: [], rowCount: 1 };
    });
    const out = await listToolExecutions({
      tenantId: 'tenant-1', callSessionId: 'cs-1', agentId: 'ag', toolName: 'a', status: 'success',
      startDate: '2026-01-01', endDate: '2026-12-31', limit: 10, offset: 0,
    });
    expect(out.total).toBe(2);
    expect(out.executions).toHaveLength(2);
  });
});

describe('getToolExecutionStats', () => {
  it('aggregates summary, top tools and a daily breakdown', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) FILTER') && sql.includes('avg_duration')) {
        return { rows: [{ total: '10', success_count: '7', failure_count: '3', avg_duration: '123.4' }] };
      }
      if (sql.includes('GROUP BY tool_name')) {
        return { rows: [{ tool_name: 'lookup_customer', cnt: '5', avg_dur: '100.6' }] };
      }
      if (sql.includes('DATE(invoked_at)')) {
        return { rows: [{ day: '2026-05-01', total: '4', success: '3', failed: '1' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const stats = await getToolExecutionStats('tenant-1', 7);
    expect(stats.totalExecutions).toBe(10);
    expect(stats.successCount).toBe(7);
    expect(stats.avgDurationMs).toBe(123);
    expect(stats.topTools[0]).toEqual({ toolName: 'lookup_customer', count: 5, avgDuration: 101 });
    expect(stats.dailyBreakdown[0]).toEqual({ date: '2026-05-01', total: 4, success: 3, failed: 1 });
  });
});
