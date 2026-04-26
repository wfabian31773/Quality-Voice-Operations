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
        rbac_role: null,
        in_app_enabled: true,
        email_enabled: true,
      },
      {
        id: 'u-admin-silent',
        email: 'silent@example.com',
        first_name: null,
        last_name: null,
        role: 'admin',
        rbac_role: null,
        in_app_enabled: false,
        email_enabled: false,
      },
      {
        id: 'u-admin-partial',
        email: 'partial@example.com',
        first_name: 'Pam',
        last_name: 'Partial',
        role: 'admin',
        rbac_role: null,
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
      ([sql]) =>
        typeof sql === 'string' &&
        sql.trim().toUpperCase().startsWith('SELECT') &&
        sql.includes('FROM users u'),
    );
    expect(selectCall).toBeDefined();
    const sql = selectCall![0] as string;
    // Roster lookup must mirror the dispatch lookup: legacy `users.role`
    // values *and* tenant_owner / operations_manager users who only carry
    // the role through the canonical `user_roles` join.
    expect(sql).toContain('LEFT JOIN user_roles ur');
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
    expect(sql).toMatch(/category = 'escalation'/);
    expect(sql).toMatch(/channel\s+= 'in_app'/);
    expect(sql).toMatch(/channel\s+= 'email'/);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('returns an empty list when the tenant has no leadership users', async () => {
    mockSelectRows([]);

    const { listEscalationRecipients } = await import('../../platform/tools/HumanEscalationService');
    const result = await listEscalationRecipients('tenant-empty');
    expect(result).toEqual([]);
  });

  it('surfaces a tenant_owner whose role only lives in user_roles, not users.role', async () => {
    // Regression for task #420: the original query gated on
    // `users.role IN ('admin', 'owner')`, which silently dropped tenant
    // owners promoted via the canonical `user_roles` table. The roster
    // panel is the user-facing preview of who gets paged, so it must
    // include them too — otherwise the panel and the dispatcher disagree.
    mockSelectRows([
      {
        id: 'u-rbac-owner',
        email: 'rbac-owner@example.com',
        first_name: 'Rachel',
        last_name: 'RBAC',
        // legacy column is a non-leadership value — only user_roles makes
        // this person a tenant owner. The query's rbac_role subquery is
        // what surfaces the canonical role for the UI badge.
        role: 'member',
        rbac_role: 'tenant_owner',
        in_app_enabled: true,
        email_enabled: true,
      },
    ]);

    const { listEscalationRecipients } = await import('../../platform/tools/HumanEscalationService');
    const result = await listEscalationRecipients('tenant-rbac');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'u-rbac-owner',
      email: 'rbac-owner@example.com',
      name: 'Rachel RBAC',
      optedOut: false,
      // The roster panel must label this user as a tenant_owner — the
      // canonical RBAC role from user_roles — not as 'member' (the
      // benign legacy value in users.role). Otherwise the on-call badge
      // would be misleading and the EscalationRecipientRole TS contract
      // would lie.
      role: 'tenant_owner',
    });

    // The query must include a subquery that pulls the canonical RBAC
    // role for users who only qualify through user_roles. If this
    // assertion regresses, the mapper will silently fall through to the
    // defensive default and we lose the per-user role distinction
    // between tenant_owner and operations_manager.
    const selectCall = queryMock.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.trim().toUpperCase().startsWith('SELECT') &&
        sql.includes('FROM users u'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall![0]).toContain('AS rbac_role');
  });

  it('falls back to operations_manager when that is the only canonical RBAC role', async () => {
    // Sanity-check the deterministic ordering inside the rbac_role
    // subquery: when the only matching user_roles entry is
    // operations_manager, that's what the badge should read.
    mockSelectRows([
      {
        id: 'u-ops-mgr',
        email: 'ops@example.com',
        first_name: null,
        last_name: null,
        role: 'member',
        rbac_role: 'operations_manager',
        in_app_enabled: true,
        email_enabled: true,
      },
    ]);

    const { listEscalationRecipients } = await import('../../platform/tools/HumanEscalationService');
    const result = await listEscalationRecipients('tenant-ops');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('operations_manager');
  });
});
