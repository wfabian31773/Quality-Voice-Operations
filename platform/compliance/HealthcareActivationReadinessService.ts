import { withPrivilegedClient } from '../db';
import {
  evaluateHealthcareActivationReadiness,
  type HealthcareActivationReadinessDecision,
  type HealthcareActivationReadinessRecord,
} from '../../shared/compliance/healthcareActivationReadiness';

const READINESS_REF_PATTERN = /^har_[a-f0-9]{3,36}$/;

function timestamp(value: unknown): string {
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function mapReadiness(row: Record<string, unknown>): HealthcareActivationReadinessRecord {
  const check = (value: unknown) => String(value) as 'pass' | 'fail' | 'external_required';
  return {
    id: String(row.id),
    readinessRef: String(row.readiness_ref),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    targetEnvironment: row.target_environment === 'production' ? 'production' : 'production_equivalent',
    coreVersion: String(row.core_version),
    model: String(row.model),
    rolePackageId: String(row.role_package_id),
    rolePackageVersion: String(row.role_package_version),
    recordingPolicy: String(row.recording_policy),
    catalogVersion: String(row.catalog_version),
    catalogCount: Number(row.catalog_count),
    discoveredCount: Number(row.discovered_count),
    tenantTableCount: Number(row.tenant_table_count),
    rlsEnabledCount: Number(row.rls_enabled_count),
    verifiedControlCount: Number(row.verified_control_count),
    callerMissingCount: Number(row.caller_missing_count),
    callerStaleCount: Number(row.caller_stale_count),
    migrationStatus: check(row.migration_status),
    schemaStatus: check(row.schema_status),
    databaseStatus: check(row.database_status),
    keyringStatus: check(row.keyring_status),
    evidenceStatus: check(row.evidence_status),
    callerHashStatus: check(row.caller_hash_status),
    retentionStatus: check(row.retention_status),
    deletionStatus: check(row.deletion_status),
    preflightSha256: String(row.preflight_sha256),
    evidenceSnapshotSha256: String(row.evidence_snapshot_sha256),
    retentionPlanSha256: String(row.retention_plan_sha256),
    deletionEvidenceSha256: String(row.deletion_evidence_sha256),
    submittedBy: String(row.submitted_by),
    verifiedBy: row.verified_by ? String(row.verified_by) : null,
    verifiedAt: row.verified_at ? timestamp(row.verified_at) : null,
    expiresAt: timestamp(row.expires_at),
    status: row.status === 'verified' ? 'verified' : row.status === 'revoked' ? 'revoked' : 'pending',
    revokedAt: row.revoked_at ? timestamp(row.revoked_at) : null,
  };
}

export async function verifyHealthcareActivationReadinessRef(input: {
  tenantId: string;
  agentId: string;
  targetEnvironment: 'production_equivalent' | 'production';
  approvalExpiresAt: string;
  readinessRef: string;
  now?: Date;
}): Promise<HealthcareActivationReadinessDecision> {
  if (!READINESS_REF_PATTERN.test(input.readinessRef)) {
    return { valid: false, code: 'readiness_missing' };
  }
  const readiness = await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, readiness_ref, tenant_id, agent_id, target_environment,
              core_version, model, role_package_id, role_package_version, recording_policy,
              catalog_version, catalog_count, discovered_count, tenant_table_count,
              rls_enabled_count, verified_control_count, caller_missing_count, caller_stale_count,
              migration_status, schema_status, database_status, keyring_status, evidence_status,
              caller_hash_status, retention_status, deletion_status, preflight_sha256,
              evidence_snapshot_sha256, retention_plan_sha256, deletion_evidence_sha256,
              status, submitted_by, verified_by, verified_at, expires_at, revoked_at
         FROM healthcare_activation_readiness
        WHERE readiness_ref = $1
        LIMIT 1`,
      [input.readinessRef],
    );
    return rows[0] ? mapReadiness(rows[0] as Record<string, unknown>) : null;
  });
  return evaluateHealthcareActivationReadiness({ ...input, readiness });
}
