import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, releaseMock } = vi.hoisted(() => ({ queryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: queryMock, release: releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

import {
  recordToolFailureEvent,
  getToolHealthMetrics,
  initToolHealthTracking,
} from './ToolHealthService';
import type { ToolFailureEvent } from './RetryOrchestrator';

const event = (over: Partial<ToolFailureEvent> = {}): ToolFailureEvent => ({
  tenantId: 'tenant-1',
  toolName: 'lookup_customer',
  callSessionId: 'cs-1',
  error: 'boom',
  retryCount: 1,
  maxRetries: 2,
  timestamp: new Date(),
  finalFailure: true,
  fallbackAttempted: false,
  fallbackSuccess: false,
  ...over,
});

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('recordToolFailureEvent', () => {
  it('inserts a failure-event row', async () => {
    await recordToolFailureEvent(event());
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO tool_failure_events'))).toBe(true);
  });

  it('swallows DB errors', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('insert failed');
    });
    await expect(recordToolFailureEvent(event())).resolves.toBeUndefined();
  });
});

describe('getToolHealthMetrics', () => {
  it('computes per-tool success rates, retries, recent failures and call completion', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tool_invocations')) {
        return { rows: [{ tool_name: 'lookup_customer', total: 10, success_count: 8, failure_count: 2, avg_duration: '50.4' }] };
      }
      if (sql.includes('total_retries')) {
        return { rows: [{ tool_name: 'lookup_customer', total_retries: 3 }] };
      }
      if (sql.includes('final_failure = true')) {
        return { rows: [{ id: 'f1', tool_name: 'lookup_customer', error: 'timeout', call_session_id: 'cs-9', retry_count: 2, fallback_attempted: true, fallback_success: false, created_at: new Date('2026-05-01T00:00:00Z') }] };
      }
      if (sql.includes('FROM call_logs')) {
        return { rows: [{ total_calls: 4, completed_calls: 3 }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const m = await getToolHealthMetrics('tenant-1', 7);
    expect(m.totalExecutions).toBe(10);
    expect(m.totalFailures).toBe(2);
    expect(m.overallSuccessRate).toBe(80);
    expect(m.callCompletionRate).toBe(75);
    const tool = m.tools[0];
    expect(tool.successRate).toBe(80);
    expect(tool.retryCount).toBe(3);
    expect(tool.avgDurationMs).toBe(50);
    expect(tool.recentFailures[0]).toMatchObject({ id: 'f1', error: 'timeout', fallbackAttempted: true });
  });

  it('defaults rates to 100 when there is no activity', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM call_logs')) return { rows: [{ total_calls: 0, completed_calls: 0 }] };
      return { rows: [] };
    });
    const m = await getToolHealthMetrics('tenant-1');
    expect(m.overallSuccessRate).toBe(100);
    expect(m.callCompletionRate).toBe(100);
    expect(m.tools).toHaveLength(0);
  });
});

describe('initToolHealthTracking', () => {
  it('is idempotent', () => {
    expect(() => {
      initToolHealthTracking();
      initToolHealthTracking();
    }).not.toThrow();
  });
});
