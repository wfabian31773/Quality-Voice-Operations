import { createHash } from 'node:crypto';
import { HEALTHCARE_APPROVAL_EVIDENCE_KEYS } from '../../shared/compliance/healthcareDeploymentApproval';
import { createScopedIdentifierHash, getPiiLookupKeyringStatus } from '../security/PiiLookupHash';
import { discoverTenantScopedTables } from './HealthcareDeletionVerificationService';
import { buildTenantDeletionPlan } from './healthcareDataControlManifest';
import {
  TENANT_DATA_CONTROL_CATALOG,
  TENANT_DATA_CONTROL_CATALOG_VERSION,
  validateTenantDataControlCatalog,
} from './tenantDataControlCatalog';

type CheckStatus = 'pass' | 'fail' | 'external_required';

interface PreflightClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

interface SafeRetentionProof {
  status: 'pass' | 'fail';
  policyDigest: string;
  candidateCount: number;
}

interface SafeDeletionProof {
  status: 'pass' | 'fail';
  driftCount: number;
  remainingRowCount: number;
  rollbackProven: boolean;
  evidencePersisted: boolean;
}

const REQUIRED_MIGRATIONS = [
  '114_healthcare_deployment_approvals.sql',
  '115_healthcare_control_evidence.sql',
  '116_healthcare_activation_readiness.sql',
  '117_tenant_rls_remediation.sql',
  '118_platform_admin_mfa.sql',
] as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export interface HealthcareReadinessPreflightDigestInput {
  overallStatus: 'pass' | 'fail';
  catalogVersion: string;
  catalogCount: number;
  discoveredCount: number;
  tenantTableCount: number;
  rlsEnabledCount: number;
  verifiedControlCount: number;
  callerMissingCount: number;
  callerStaleCount: number;
  migrationStatus: CheckStatus;
  schemaStatus: CheckStatus;
  databaseStatus: CheckStatus;
  keyringStatus: CheckStatus;
  evidenceStatus: CheckStatus;
  callerHashStatus: CheckStatus;
  retentionStatus: CheckStatus;
  deletionStatus: CheckStatus;
  evidenceSnapshotSha256: string;
  retentionPlanSha256: string;
  deletionEvidenceSha256: string;
}

export function calculateHealthcareReadinessPreflightSha256(
  input: HealthcareReadinessPreflightDigestInput,
): string {
  return digest({
    overallStatus: input.overallStatus,
    catalogVersion: input.catalogVersion,
    catalogCount: input.catalogCount,
    discoveredCount: input.discoveredCount,
    tenantTableCount: input.tenantTableCount,
    rlsEnabledCount: input.rlsEnabledCount,
    verifiedControlCount: input.verifiedControlCount,
    callerMissingCount: input.callerMissingCount,
    callerStaleCount: input.callerStaleCount,
    migrationStatus: input.migrationStatus,
    schemaStatus: input.schemaStatus,
    databaseStatus: input.databaseStatus,
    keyringStatus: input.keyringStatus,
    evidenceStatus: input.evidenceStatus,
    callerHashStatus: input.callerHashStatus,
    retentionStatus: input.retentionStatus,
    deletionStatus: input.deletionStatus,
    evidenceSnapshotSha256: input.evidenceSnapshotSha256,
    retentionPlanSha256: input.retentionPlanSha256,
    deletionEvidenceSha256: input.deletionEvidenceSha256,
  });
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function collectHealthcareDataControlPreflight(
  client: PreflightClient,
  input: {
    tenantId: string;
    agentId: string;
    expectedDatabaseRole: string;
    retention?: SafeRetentionProof;
    deletion?: SafeDeletionProof;
  },
) {
  const scopeDigest = createScopedIdentifierHash(
    input.tenantId,
    input.agentId,
    'approval_evidence',
  );
  const expectedDatabaseRole = input.expectedDatabaseRole.trim();
  if (
    expectedDatabaseRole.length === 0
    || expectedDatabaseRole.length > 63
    || /[\u0000-\u001f]/.test(expectedDatabaseRole)
  ) throw new Error('Expected database role must be a bounded PostgreSQL identifier');

  const migrationResult = await client.query(
    'SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename',
    [[...REQUIRED_MIGRATIONS]],
  );
  const appliedMigrations = migrationResult.rows.map((row) => String(row.filename)).sort();
  const migrationStatus: CheckStatus = REQUIRED_MIGRATIONS.every((name) => appliedMigrations.includes(name))
    ? 'pass'
    : 'fail';

  const discovered = await discoverTenantScopedTables(client);
  const deletionPlan = buildTenantDeletionPlan(discovered);
  const catalogNames = new Set(TENANT_DATA_CONTROL_CATALOG.map((entry) => entry.table));
  const discoveredNames = new Set(discovered.map((entry) => entry.table));
  const driftCount = new Set([
    ...[...catalogNames].filter((table) => !discoveredNames.has(table)),
    ...[...discoveredNames].filter((table) => !catalogNames.has(table)),
    ...deletionPlan.invalidIdentifiers,
  ]).size;
  const catalogErrors = validateTenantDataControlCatalog();
  const schemaStatus: CheckStatus = deletionPlan.ready && driftCount === 0 && catalogErrors.length === 0
    ? 'pass'
    : 'fail';

  const roleResult = await client.query(
    `SELECT (
       current_user = $1
       AND r.rolcanlogin
       AND r.rolbypassrls
       AND NOT r.rolsuper
     ) AS service_role_verified
       FROM pg_roles r
      WHERE r.rolname = current_user`,
    [expectedDatabaseRole],
  );
  const serviceRoleVerified = roleResult.rows[0]?.service_role_verified === true;
  const rlsResult = await client.query(
    `SELECT COUNT(*)::int AS tenant_table_count,
            COUNT(*) FILTER (WHERE c.relrowsecurity)::int AS rls_enabled_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
        )
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attname = 'tenant_id'
             AND a.attnum > 0
             AND NOT a.attisdropped
        )`,
  );
  const tenantTableCount = numberValue(rlsResult.rows[0]?.tenant_table_count);
  const rlsEnabledCount = numberValue(rlsResult.rows[0]?.rls_enabled_count);
  const databaseStatus: CheckStatus = serviceRoleVerified
    && tenantTableCount > 0
    && tenantTableCount === rlsEnabledCount
    ? 'pass'
    : 'fail';

  const evidenceResult = await client.query(
    `SELECT
       COUNT(DISTINCT control_key) FILTER (
         WHERE status = 'verified' AND revoked_at IS NULL AND expires_at > NOW()
       )::int AS verified_control_count,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = 'revoked' OR revoked_at IS NOT NULL)::int AS revoked_count
       FROM healthcare_control_evidence
      WHERE tenant_id = $1 AND agent_id = $2 AND environment = 'production'`,
    [input.tenantId, input.agentId],
  );
  const verifiedControlCount = numberValue(evidenceResult.rows[0]?.verified_control_count);
  const pendingCount = numberValue(evidenceResult.rows[0]?.pending_count);
  const revokedCount = numberValue(evidenceResult.rows[0]?.revoked_count);
  const evidenceStatus: CheckStatus = verifiedControlCount === HEALTHCARE_APPROVAL_EVIDENCE_KEYS.length
    ? 'pass'
    : 'fail';

  const keyring = getPiiLookupKeyringStatus();
  const keyringStatus: CheckStatus = keyring.valid ? 'pass' : 'fail';
  const keyringConfigurationDigest = digest({
    currentVersion: keyring.currentVersion,
    previousVersion: keyring.previousVersion,
    dualRead: keyring.dualRead,
  });
  const callerResult = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE caller_number IS NOT NULL)::int AS caller_count,
       COUNT(*) FILTER (WHERE caller_number IS NOT NULL AND caller_lookup_key_version = $2)::int AS current_count,
       COUNT(*) FILTER (WHERE caller_number IS NOT NULL AND (caller_lookup_hash IS NULL OR caller_lookup_key_version IS NULL))::int AS missing_count,
       COUNT(*) FILTER (WHERE caller_number IS NOT NULL AND caller_lookup_hash IS NOT NULL AND caller_lookup_key_version IS DISTINCT FROM $2)::int AS stale_count
       FROM call_sessions WHERE tenant_id = $1`,
    [input.tenantId, keyring.currentVersion],
  );
  const callerCount = numberValue(callerResult.rows[0]?.caller_count);
  const currentCount = numberValue(callerResult.rows[0]?.current_count);
  const missingCount = numberValue(callerResult.rows[0]?.missing_count);
  const staleCount = numberValue(callerResult.rows[0]?.stale_count);
  const callerHashStatus: CheckStatus = keyring.valid && missingCount === 0 && staleCount === 0
    ? 'pass'
    : 'fail';

  const retention = input.retention
    && DIGEST_PATTERN.test(input.retention.policyDigest)
    && Number.isInteger(input.retention.candidateCount)
    && input.retention.candidateCount >= 0
    ? { ...input.retention }
    : { status: 'external_required' as const, policyDigest: digest('retention-proof-missing'), candidateCount: 0 };
  const deletion = input.deletion
    ? { ...input.deletion }
    : {
        status: 'external_required' as const,
        driftCount,
        remainingRowCount: 0,
        rollbackProven: false,
        evidencePersisted: false,
      };
  const retentionStatus: CheckStatus = retention.status;
  const deletionStatus: CheckStatus = deletion.status === 'pass'
    && deletion.driftCount === 0
    && deletion.remainingRowCount === 0
    && deletion.rollbackProven
    && deletion.evidencePersisted
    ? 'pass'
    : deletion.status === 'external_required' ? 'external_required' : 'fail';

  const statuses = [
    migrationStatus, schemaStatus, databaseStatus, evidenceStatus,
    keyringStatus, callerHashStatus, retentionStatus, deletionStatus,
  ];
  const overallStatus: 'pass' | 'fail' = statuses.every((status) => status === 'pass') ? 'pass' : 'fail';
  const evidenceSnapshotSha256 = digest({
    requiredControlCount: HEALTHCARE_APPROVAL_EVIDENCE_KEYS.length,
    verifiedControlCount,
    pendingCount,
    revokedCount,
    status: evidenceStatus,
  });
  const retentionPlanSha256 = retention.policyDigest;
  const deletionEvidenceSha256 = digest({ ...deletion, status: deletionStatus });
  const readiness = {
    overallStatus,
    catalogVersion: TENANT_DATA_CONTROL_CATALOG_VERSION,
    catalogCount: TENANT_DATA_CONTROL_CATALOG.length,
    discoveredCount: discovered.length,
    tenantTableCount,
    rlsEnabledCount,
    verifiedControlCount,
    callerMissingCount: missingCount,
    callerStaleCount: staleCount,
    migrationStatus,
    schemaStatus,
    databaseStatus,
    keyringStatus,
    evidenceStatus,
    callerHashStatus,
    retentionStatus,
    deletionStatus,
    evidenceSnapshotSha256,
    retentionPlanSha256,
    deletionEvidenceSha256,
  };

  return {
    overallStatus,
    scopeDigest,
    readiness: {
      ...readiness,
      preflightSha256: calculateHealthcareReadinessPreflightSha256(readiness),
    },
    migrations: {
      status: migrationStatus,
      requiredCount: REQUIRED_MIGRATIONS.length,
      appliedCount: appliedMigrations.length,
      digest: digest(appliedMigrations),
    },
    schema: {
      status: schemaStatus,
      catalogVersion: TENANT_DATA_CONTROL_CATALOG_VERSION,
      catalogCount: TENANT_DATA_CONTROL_CATALOG.length,
      discoveredCount: discovered.length,
      driftCount,
      digest: digest(discovered.map((entry) => [entry.table, entry.deleteRule]).sort()),
    },
    database: {
      status: databaseStatus,
      serviceRoleStatus: serviceRoleVerified ? 'pass' : 'fail',
      rlsStatus: tenantTableCount > 0 && tenantTableCount === rlsEnabledCount ? 'pass' : 'fail',
      tenantTableCount,
      rlsEnabledCount,
    },
    keyring: {
      status: keyringStatus,
      dualReadStatus: keyring.dualRead ? 'enabled' : 'disabled',
      configurationDigest: keyringConfigurationDigest,
    },
    evidenceRegistry: {
      status: evidenceStatus,
      requiredControlCount: HEALTHCARE_APPROVAL_EVIDENCE_KEYS.length,
      verifiedControlCount,
      pendingCount,
      revokedCount,
    },
    callerHashReconciliation: {
      status: callerHashStatus,
      callerCount,
      currentCount,
      missingCount,
      staleCount,
    },
    retention: { ...retention, status: retentionStatus },
    deletion: { ...deletion, status: deletionStatus },
  };
}
