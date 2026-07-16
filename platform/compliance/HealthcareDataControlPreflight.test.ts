import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateHealthcareReadinessPreflightSha256,
  collectHealthcareDataControlPreflight,
} from './HealthcareDataControlPreflight';
import { TENANT_DATA_CONTROL_CATALOG } from './tenantDataControlCatalog';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'current-lookup-key-with-at-least-32-characters';
  process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = 'v2';
  delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
  delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('healthcare data-control preflight', () => {
  it('emits only statuses, counts, and digests while collecting parameterized proof', async () => {
    const query = vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM schema_migrations')) return { rows: [
        { filename: '114_healthcare_deployment_approvals.sql' },
        { filename: '115_healthcare_control_evidence.sql' },
        { filename: '116_healthcare_activation_readiness.sql' },
        { filename: '117_tenant_rls_remediation.sql' },
      ] };
      if (sql.includes('rls_enabled_count')) return { rows: [{ tenant_table_count: TENANT_DATA_CONTROL_CATALOG.length, rls_enabled_count: TENANT_DATA_CONTROL_CATALOG.length }] };
      if (sql.includes('referential_constraints')) return { rows: TENANT_DATA_CONTROL_CATALOG.map((entry) => ({
        table_name: entry.table, delete_rule: 'CASCADE',
      })) };
      if (sql.includes('service_role_verified')) return { rows: [{ service_role_verified: true }] };
      if (sql.includes('healthcare_control_evidence')) return { rows: [{
        verified_control_count: 11, pending_count: 0, revoked_count: 0,
      }] };
      if (sql.includes('caller_lookup_key_version')) return { rows: [{
        caller_count: 10, current_count: 10, missing_count: 0, stale_count: 0,
      }] };
      throw new Error(`unexpected safe test query with ${values?.length ?? 0} values`);
    });

    const result = await collectHealthcareDataControlPreflight(
      { query },
      {
        tenantId: 'secret-tenant-id', agentId: 'secret-agent-id',
        expectedDatabaseRole: 'postgres.project-ref',
        retention: { status: 'pass', policyDigest: 'a'.repeat(64), candidateCount: 4 },
        deletion: { status: 'pass', driftCount: 0, remainingRowCount: 0, rollbackProven: true, evidencePersisted: true },
      },
    );

    expect(result.overallStatus).toBe('pass');
    expect(result.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.schema).toMatchObject({ status: 'pass', catalogCount: TENANT_DATA_CONTROL_CATALOG.length, driftCount: 0 });
    expect(result.keyring.status).toBe('pass');
    expect(result.readiness).toMatchObject({
      overallStatus: 'pass', catalogVersion: '3.0.0',
      catalogCount: TENANT_DATA_CONTROL_CATALOG.length,
      discoveredCount: TENANT_DATA_CONTROL_CATALOG.length,
      tenantTableCount: TENANT_DATA_CONTROL_CATALOG.length,
      rlsEnabledCount: TENANT_DATA_CONTROL_CATALOG.length,
      verifiedControlCount: 11, callerMissingCount: 0, callerStaleCount: 0,
      retentionStatus: 'pass', deletionStatus: 'pass',
    });
    for (const value of [
      result.readiness.preflightSha256, result.readiness.evidenceSnapshotSha256,
      result.readiness.retentionPlanSha256, result.readiness.deletionEvidenceSha256,
    ]) expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(result.readiness.preflightSha256).toBe(
      calculateHealthcareReadinessPreflightSha256(result.readiness),
    );
    expect(JSON.stringify(result)).not.toMatch(/secret-tenant-id|secret-agent-id|current-lookup-key|artifact|locator|database_url/i);
    const evidenceCall = query.mock.calls.find(([sql]) => String(sql).includes('healthcare_control_evidence'));
    expect(evidenceCall?.[1]).toEqual(['secret-tenant-id', 'secret-agent-id']);
    const roleCall = query.mock.calls.find(([sql]) => String(sql).includes('service_role_verified'));
    expect(roleCall?.[1]).toEqual(['postgres.project-ref']);
  });

  it('fails closed when migrations, RLS, evidence, hashes, deletion, or retention proof is absent', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM schema_migrations')) return { rows: [] };
      if (sql.includes('rls_enabled_count')) return { rows: [{ tenant_table_count: 1, rls_enabled_count: 0 }] };
      if (sql.includes('referential_constraints')) return { rows: [] };
      if (sql.includes('service_role_verified')) return { rows: [{ service_role_verified: false }] };
      if (sql.includes('healthcare_control_evidence')) return { rows: [{ verified_control_count: 0, pending_count: 1, revoked_count: 0 }] };
      if (sql.includes('caller_lookup_key_version')) return { rows: [{ caller_count: 2, current_count: 0, missing_count: 1, stale_count: 1 }] };
      return { rows: [] };
    });
    delete process.env.QVO_PII_LOOKUP_HMAC_KEY;

    const result = await collectHealthcareDataControlPreflight(
      { query }, { tenantId: 't1', agentId: 'a1', expectedDatabaseRole: 'postgres.project-ref' },
    );
    expect(result.overallStatus).toBe('fail');
    expect(result.retention.status).toBe('external_required');
    expect(result.deletion.status).toBe('external_required');
    expect(result.keyring.status).toBe('fail');
  });

  it('counts only root base or partitioned relations when proving RLS coverage', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM schema_migrations')) return { rows: [] };
      if (sql.includes('referential_constraints')) return { rows: [] };
      if (sql.includes('service_role_verified')) return { rows: [{ service_role_verified: false }] };
      if (sql.includes('rls_enabled_count')) return { rows: [{ tenant_table_count: 0, rls_enabled_count: 0 }] };
      if (sql.includes('healthcare_control_evidence')) return { rows: [{}] };
      if (sql.includes('caller_lookup_key_version')) return { rows: [{}] };
      return { rows: [] };
    });
    await collectHealthcareDataControlPreflight(
      { query },
      { tenantId: 't1', agentId: 'a1', expectedDatabaseRole: 'postgres.project-ref' },
    );
    const rlsSql = String(query.mock.calls.find(([sql]) => String(sql).includes('rls_enabled_count'))?.[0]);
    expect(rlsSql).toMatch(/relkind[\s\S]*pg_inherits/);
    expect(rlsSql).toContain("relkind IN ('r', 'p')");
  });
});
