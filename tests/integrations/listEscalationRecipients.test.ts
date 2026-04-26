import { describe, it, expect, beforeEach, vi } from 'vitest';

type QueryResult = { rows: unknown[]; rowCount?: number };

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
}));

function mockSelectRows(rows: unknown[]) {
  queryMock.mockImplementation(async (sql: string) => {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('BEGIN') || trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (trimmed.startsWith('SELECT')) {
      return { rows };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockClear();
  releaseMock.mockClear();
});

describe('listEscalationRecipients', () => {
  it('returns admins/owners with escalation prefs and flags fully-silenced users', async () => {
    mockSelectRows([
      {
        id: 'u-owner',
        email: 'owner@example.com',
        first_name: 'Olivia',
        last_name: 'Owner',
        role: 'owner',
        in_app_enabled: true,
        email_enabled: true,
      },
      {
        id: 'u-admin-silent',
        email: 'silent@example.com',
        first_name: null,
        last_name: null,
        role: 'admin',
        in_app_enabled: false,
        email_enabled: false,
      },
      {
        id: 'u-admin-partial',
        email: 'partial@example.com',
        first_name: 'Pam',
        last_name: 'Partial',
        role: 'admin',
        in_app_enabled: true,
        email_enabled: false,
      },
    ]);

    const { listEscalationRecipients } = await import('../../platform/tools/HumanEscalationService');
    const result = await listEscalationRecipients('tenant-1');

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: 'u-owner',
      role: 'owner',
      name: 'Olivia Owner',
      optedOut: false,
      prefs: { inApp: true, email: true },
    });
    expect(result[1]).toMatchObject({
      id: 'u-admin-silent',
      role: 'admin',
      name: null,
      optedOut: true,
      prefs: { inApp: false, email: false },
    });
    expect(result[2]).toMatchObject({
      id: 'u-admin-partial',
      role: 'admin',
      name: 'Pam Partial',
      optedOut: false,
      prefs: { inApp: true, email: false },
    });

    const selectCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.trim().toUpperCase().startsWith('SELECT'),
    );
    expect(selectCall).toBeDefined();
    const sql = selectCall![0] as string;
    expect(sql).toMatch(/role IN \('admin', 'owner'\)/);
    expect(sql).toMatch(/category = 'escalation'/);
    expect(sql).toMatch(/channel\s+= 'in_app'/);
    expect(sql).toMatch(/channel\s+= 'email'/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('returns an empty list when the tenant has no admin/owner users', async () => {
    mockSelectRows([]);

    const { listEscalationRecipients } = await import('../../platform/tools/HumanEscalationService');
    const result = await listEscalationRecipients('tenant-empty');
    expect(result).toEqual([]);
  });
});
