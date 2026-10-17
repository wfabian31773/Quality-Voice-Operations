import { describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  getPrivilegedPool: () => ({ query: queryMock }),
  withPrivilegedClient: async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('verifyConnectedRoleDoesNotBypassRls', () => {
  it('fails loudly when the restricted pool is postgres / BYPASSRLS', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ rolname: 'postgres', rolbypassrls: true, rolsuper: true }],
    });
    const { verifyConnectedRoleDoesNotBypassRls } = await import('./TenantIsolationService');
    const result = await verifyConnectedRoleDoesNotBypassRls();
    expect(result.passed).toBe(false);
    expect(result.details).toContain('CONNECTED ROLE BYPASSES RLS');
    expect(result.details).toContain('postgres');
  });

  it('passes when the restricted pool is qvo_app without BYPASSRLS', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ rolname: 'qvo_app', rolbypassrls: false, rolsuper: false }],
    });
    const { verifyConnectedRoleDoesNotBypassRls } = await import('./TenantIsolationService');
    const result = await verifyConnectedRoleDoesNotBypassRls();
    expect(result.passed).toBe(true);
    expect(result.details).toContain('qvo_app');
  });
});

describe('verifyRestrictedRoleCannotBypassAsOwner', () => {
  it('fails when the connected role owns a table without FORCE RLS', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { relname: 'agents', relforcerowsecurity: true, owned_by_current_role: false },
        { relname: 'api_keys', relforcerowsecurity: false, owned_by_current_role: true },
      ],
    });
    const { verifyRestrictedRoleCannotBypassAsOwner } = await import('./TenantIsolationService');
    const results = await verifyRestrictedRoleCannotBypassAsOwner();
    expect(results.map((r) => [r.testName, r.passed])).toEqual([
      ['FORCE RLS on agents', true],
      ['FORCE RLS on api_keys', false],
    ]);
    expect(results[1].details).toContain('CONNECTED ROLE OWNS api_keys');
  });

  it('fails when FORCE RLS is missing even if the role owns nothing', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ relname: 'agents', relforcerowsecurity: false, owned_by_current_role: false }],
    });
    const { verifyRestrictedRoleCannotBypassAsOwner } = await import('./TenantIsolationService');
    const [result] = await verifyRestrictedRoleCannotBypassAsOwner();
    expect(result.passed).toBe(false);
    expect(result.details).toContain('FORCE ROW LEVEL SECURITY missing');
  });

  it('fails closed when the catalog query errors', async () => {
    queryMock.mockRejectedValueOnce(new Error('permission denied for pg_class'));
    const { verifyRestrictedRoleCannotBypassAsOwner } = await import('./TenantIsolationService');
    const [result] = await verifyRestrictedRoleCannotBypassAsOwner();
    expect(result.passed).toBe(false);
    expect(result.details).toContain('permission denied');
  });
});
