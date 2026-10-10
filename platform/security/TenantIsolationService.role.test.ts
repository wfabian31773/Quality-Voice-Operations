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
