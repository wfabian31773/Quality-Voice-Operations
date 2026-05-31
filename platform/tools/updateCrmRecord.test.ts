import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, releaseMock } = vi.hoisted(() => ({ queryMock: vi.fn(), releaseMock: vi.fn() }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: queryMock, release: releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

import { updateCrmRecordTool } from './updateCrmRecord';

const ctx = { tenantId: 'tenant-1', callLogId: 'call-1' };

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('update_crm_record tool', () => {
  it('requires a phone number', async () => {
    const r = (await updateCrmRecordTool.handler({}, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('phoneNumber is required');
  });

  it('marks the record updated when the name change affects a row', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE campaign_contacts') && sql.includes('SET name')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = (await updateCrmRecordTool.handler({ phoneNumber: '+15551234567', name: 'Ada' }, ctx)) as {
      success: boolean;
      updated: boolean;
    };
    expect(r.success).toBe(true);
    expect(r.updated).toBe(true);
  });

  it('updates call-session and contact context when notes/tags are provided', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE call_sessions')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = (await updateCrmRecordTool.handler(
      { phoneNumber: '+15551234567', notes: 'called back', tags: ['vip'] },
      ctx,
    )) as { updated: boolean };
    expect(r.updated).toBe(true);
  });

  it('reports no matching records when nothing was updated', async () => {
    const r = (await updateCrmRecordTool.handler({ phoneNumber: '+15551234567', name: 'Nobody' }, ctx)) as {
      success: boolean;
      updated: boolean;
      message: string;
    };
    expect(r.success).toBe(true);
    expect(r.updated).toBe(false);
    expect(r.message).toContain('No existing customer records');
  });

  it('returns a safe error when a query throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error('db down');
    });
    const r = (await updateCrmRecordTool.handler({ phoneNumber: '+15551234567', name: 'Ada' }, ctx)) as {
      success: boolean;
      message: string;
    };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Failed to update customer record');
  });
});
