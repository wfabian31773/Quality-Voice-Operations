import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), withPrivilegedClient: vi.fn() }));
vi.mock('../db', () => ({ withPrivilegedClient: mocks.withPrivilegedClient }));

import { verifyHealthcareActivationReadinessRef } from './HealthcareActivationReadinessService';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'readiness-1', readiness_ref: 'har_abc', tenant_id: 'tenant-1', agent_id: 'agent-1',
    target_environment: 'production', core_version: '2.0.0', model: 'grok-voice-think-fast-2.0',
    role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0', recording_policy: 'disabled',
    catalog_version: '3.0.0', catalog_count: 188, discovered_count: 188,
    tenant_table_count: 188, rls_enabled_count: 188, verified_control_count: 11,
    caller_missing_count: 0, caller_stale_count: 0,
    migration_status: 'pass', schema_status: 'pass', database_status: 'pass', keyring_status: 'pass',
    evidence_status: 'pass', caller_hash_status: 'pass', retention_status: 'pass', deletion_status: 'pass',
    preflight_sha256: 'a'.repeat(64), evidence_snapshot_sha256: 'b'.repeat(64),
    retention_plan_sha256: 'c'.repeat(64), deletion_evidence_sha256: 'd'.repeat(64),
    status: 'verified', submitted_by: 'admin-1', verified_by: 'admin-2',
    verified_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-09-01T00:00:00.000Z', revoked_at: null,
    ...overrides,
  };
}

const input = {
  tenantId: 'tenant-1', agentId: 'agent-1', targetEnvironment: 'production' as const,
  approvalExpiresAt: '2099-08-01T00:00:00.000Z', readinessRef: 'har_abc',
};

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [row()] });
  mocks.withPrivilegedClient.mockReset().mockImplementation(
    async (callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => callback({ query: mocks.query }),
  );
});

describe('healthcare activation readiness repository', () => {
  it('loads one scoped reference with a parameterized query and returns no proof digests', async () => {
    const decision = await verifyHealthcareActivationReadinessRef(input);
    expect(decision).toEqual({ valid: true, code: 'readiness_verified', readinessId: 'readiness-1' });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM healthcare_activation_readiness[\s\S]*readiness_ref = \$1/),
      ['har_abc'],
    );
    expect(JSON.stringify(decision)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('fails closed without opening a privileged connection for a malformed reference', async () => {
    await expect(verifyHealthcareActivationReadinessRef({ ...input, readinessRef: 'invalid' }))
      .resolves.toEqual({ valid: false, code: 'readiness_missing' });
    expect(mocks.withPrivilegedClient).not.toHaveBeenCalled();
  });

  it('fails closed for a missing, revoked, drifted, or expired record', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(verifyHealthcareActivationReadinessRef(input))
      .resolves.toEqual({ valid: false, code: 'readiness_missing' });

    mocks.query.mockResolvedValueOnce({ rows: [row({ status: 'revoked', revoked_at: '2026-07-13T00:00:00.000Z' })] });
    await expect(verifyHealthcareActivationReadinessRef(input))
      .resolves.toEqual({ valid: false, code: 'readiness_revoked' });

    mocks.query.mockResolvedValueOnce({ rows: [row({ rls_enabled_count: 187 })] });
    await expect(verifyHealthcareActivationReadinessRef(input))
      .resolves.toEqual({ valid: false, code: 'readiness_database_mismatch' });

    mocks.query.mockResolvedValueOnce({ rows: [row({ expires_at: '2026-07-12T00:00:00.000Z' })] });
    await expect(verifyHealthcareActivationReadinessRef({ ...input, now: new Date('2026-07-13T00:00:00.000Z') }))
      .resolves.toEqual({ valid: false, code: 'readiness_expired' });
  });

  it('maps production-equivalent, pending, null, and malformed workflow metadata fail closed', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [row({
      target_environment: 'production_equivalent', status: 'pending',
      verified_by: null, verified_at: null, revoked_at: null,
    })] });
    await expect(verifyHealthcareActivationReadinessRef({
      ...input, targetEnvironment: 'production_equivalent',
    })).resolves.toEqual({ valid: false, code: 'readiness_not_verified' });

    mocks.query.mockResolvedValueOnce({ rows: [row({
      status: 'unexpected', verified_at: 'not-a-timestamp', expires_at: 'not-a-timestamp',
    })] });
    await expect(verifyHealthcareActivationReadinessRef(input))
      .resolves.toEqual({ valid: false, code: 'readiness_not_verified' });
  });
});
