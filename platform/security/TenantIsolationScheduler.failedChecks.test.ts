import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('../db', () => ({ getPrivilegedPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));
vi.mock('../core/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.error }) }));
vi.mock('../email', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('../notifications/NotificationPreferences', () => ({ fanoutInAppNotification: vi.fn(async () => 0) }));
vi.mock('../audit/AuditService', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('./TenantIsolationService', () => ({
  pickActiveTenantForIsolationTest: vi.fn(async () => null),
  runAllIsolationTests: vi.fn(),
  verifyConnectedRoleDoesNotBypassRls: vi.fn(async () => ({
    testName: 'Connected role subject to RLS',
    passed: false,
    details: 'CONNECTED ROLE BYPASSES RLS: "postgres" has rolbypassrls=true',
  })),
  verifyRestrictedRoleCannotBypassAsOwner: vi.fn(async () => [
    { testName: 'FORCE RLS on agents', passed: true, details: 'ok' },
  ]),
  verifyRLSEnabled: vi.fn(async () => [
    { testName: 'RLS enabled on bookings', passed: false, details: 'RLS not enabled or table not found' },
  ]),
}));

import { runTenantIsolationScheduledCycle } from './TenantIsolationScheduler';
import { pickActiveTenantForIsolationTest, runAllIsolationTests } from './TenantIsolationService';

function failureLogPayload(): Record<string, unknown> {
  const call = h.error.mock.calls.find(([msg]) => msg === 'Scheduled tenant isolation tests detected failures');
  expect(call, 'failure log line').toBeDefined();
  return call![1] as Record<string, unknown>;
}

beforeEach(() => h.error.mockClear());

describe('scheduled isolation failure log', () => {
  it('names the failing checks on the normal (active tenant) path, without details or tenant ids', async () => {
    vi.mocked(pickActiveTenantForIsolationTest).mockResolvedValueOnce('tenant-abc');
    vi.mocked(runAllIsolationTests).mockResolvedValueOnce({
      passed: 1,
      failed: 2,
      runId: 'run-1',
      source: 'scheduled',
      results: [
        { testName: 'Connected role subject to RLS', passed: false, details: 'CONNECTED ROLE BYPASSES RLS' },
        { testName: 'RLS enabled on agents', passed: true, details: 'Row Level Security is active' },
        { testName: 'Cross-tenant read blocked on agents', passed: false, details: 'VIOLATION: 15 rows from other tenants visible' },
      ],
    });

    const cycle = await runTenantIsolationScheduledCycle();

    const payload = failureLogPayload();
    expect(payload.failedChecks).toEqual(['Connected role subject to RLS', 'Cross-tenant read blocked on agents']);
    expect(payload).toMatchObject({ runId: 'run-1', failed: 2, passed: 1 });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('VIOLATION');
    expect(serialized).not.toContain('BYPASSES');
    expect(serialized).not.toContain('tenant-abc');
    expect(cycle.skippedReason).toBeUndefined();
  });

  it('names the failing checks on the no-active-tenant path', async () => {
    const cycle = await runTenantIsolationScheduledCycle();

    const payload = failureLogPayload();
    expect(payload.failedChecks).toEqual(['Connected role subject to RLS', 'RLS enabled on bookings']);
    expect(JSON.stringify(payload)).not.toContain('rolbypassrls');
    expect(cycle).toMatchObject({ ranTests: true, failed: 2, passed: 1 });
    expect(cycle.skippedReason).toBeUndefined();
  });
});
