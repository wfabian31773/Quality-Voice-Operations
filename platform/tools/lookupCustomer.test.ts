import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the platform DB layer so the tool handler can be exercised without a
// live Postgres. queryMock dispatches on the SQL text.
const { queryMock, releaseMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({ query: queryMock, release: releaseMock }),
  }),
  withTenantContext: async (_client: unknown, _tenantId: string, cb: () => Promise<void>) => cb(),
}));

import { lookupCustomerTool } from './lookupCustomer';

const ctx = { tenantId: 'tenant-1' };

function defaultQuery(sql: string): { rows: Record<string, unknown>[] } {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
  if (sql.includes('COUNT(*)')) return { rows: [{ total: 0 }] };
  return { rows: [] };
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => defaultQuery(sql));
});

describe('lookup_customer tool', () => {
  it('requires either a phone number or a name', async () => {
    const result = (await lookupCustomerTool.handler({}, ctx)) as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain('phoneNumber or name');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reports not-found when a phone has no calls or campaign contacts', async () => {
    const result = (await lookupCustomerTool.handler({ phoneNumber: '+15551234567' }, ctx)) as {
      success: boolean;
      found: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.found).toBe(false);
  });

  it('returns a profile when call history exists for the phone', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 2 }] };
      if (sql.includes('FROM call_sessions')) {
        return { rows: [{ id: 'c1', agent_id: 'a1', direction: 'inbound', duration_seconds: 60, lifecycle_state: 'completed', created_at: '2026-05-01T10:00:00Z' }] };
      }
      if (sql.includes('campaign_contacts')) {
        return { rows: [{ campaign_id: 'camp1', name: 'Ada', status: 'contacted', outcome: null, campaign_name: 'Spring' }] };
      }
      return { rows: [] };
    });
    const result = (await lookupCustomerTool.handler({ phoneNumber: '+15551234567' }, ctx)) as {
      success: boolean;
      found: boolean;
      customer: { totalCalls: number; name: string | null; recentCalls: unknown[] };
    };
    expect(result.found).toBe(true);
    expect(result.customer.totalCalls).toBe(2);
    expect(result.customer.name).toBe('Ada');
    expect(result.customer.recentCalls).toHaveLength(1);
  });

  it('returns a safe error message when the query throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db exploded');
    });
    const result = (await lookupCustomerTool.handler({ phoneNumber: '+15551234567' }, ctx)) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to look up customer');
  });

  it('reports not-found by name when no contacts match', async () => {
    const result = (await lookupCustomerTool.handler({ name: 'Nobody' }, ctx)) as {
      success: boolean;
      found: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.found).toBe(false);
  });
});
