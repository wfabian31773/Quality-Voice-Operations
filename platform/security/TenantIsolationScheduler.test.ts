import { describe, it, expect, vi } from 'vitest';

const a = vi.hoisted(() => ({ roleCheckScope: [] as Array<boolean>, ownerCheckScope: [] as Array<boolean> }));

vi.mock('../db', () => ({ getPrivilegedPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));
vi.mock('../core/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../email', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('../notifications/NotificationPreferences', () => ({ fanoutInAppNotification: vi.fn(async () => 0) }));
vi.mock('../audit/AuditService', () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock('./TenantIsolationService', async () => {
  const { isPrivilegedScope } = await import('../db/tenantScope');
  return {
    pickActiveTenantForIsolationTest: vi.fn(async () => null),
    runAllIsolationTests: vi.fn(),
    verifyConnectedRoleDoesNotBypassRls: vi.fn(async () => {
      a.roleCheckScope.push(isPrivilegedScope());
      return { testName: 'Connected role subject to RLS', passed: true, details: 'qvo_app' };
    }),
    verifyRestrictedRoleCannotBypassAsOwner: vi.fn(async () => {
      a.ownerCheckScope.push(isPrivilegedScope());
      return [{ testName: 'FORCE RLS on agents', passed: true, details: 'ok' }];
    }),
    verifyRLSEnabled: vi.fn(async () => []),
  };
});

import { runTenantIsolationScheduledCycle } from './TenantIsolationScheduler';
import { runWithPrivilegedScope } from '../db/tenantScope';

describe('runTenantIsolationScheduledCycle with no active tenant', () => {
  it('runs the role and FORCE/owner checks on the restricted pool, even from the scheduler scope', async () => {
    await runWithPrivilegedScope(() => runTenantIsolationScheduledCycle());
    expect(a.roleCheckScope).toEqual([false]);
    expect(a.ownerCheckScope).toEqual([false]);
  });
});
