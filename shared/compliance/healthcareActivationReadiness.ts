import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  MASTER_VOICE_AGENT_MODEL,
} from '../../platform/agent-runtime/masterVoiceAgent';

export const HEALTHCARE_ACTIVATION_CATALOG_VERSION = '3.0.0';
export const HEALTHCARE_ACTIVATION_CATALOG_COUNT = 188;
export const HEALTHCARE_ACTIVATION_EVIDENCE_CONTROL_COUNT = 11;

type ReadinessCheckStatus = 'pass' | 'fail' | 'external_required';

export interface HealthcareActivationReadinessRecord {
  id: string;
  readinessRef: string;
  tenantId: string;
  agentId: string;
  targetEnvironment: 'production_equivalent' | 'production';
  coreVersion: string;
  model: string;
  rolePackageId: string;
  rolePackageVersion: string;
  recordingPolicy: string;
  catalogVersion: string;
  catalogCount: number;
  discoveredCount: number;
  tenantTableCount: number;
  rlsEnabledCount: number;
  verifiedControlCount: number;
  callerMissingCount: number;
  callerStaleCount: number;
  migrationStatus: ReadinessCheckStatus;
  schemaStatus: ReadinessCheckStatus;
  databaseStatus: ReadinessCheckStatus;
  keyringStatus: ReadinessCheckStatus;
  evidenceStatus: ReadinessCheckStatus;
  callerHashStatus: ReadinessCheckStatus;
  retentionStatus: ReadinessCheckStatus;
  deletionStatus: ReadinessCheckStatus;
  preflightSha256: string;
  evidenceSnapshotSha256: string;
  retentionPlanSha256: string;
  deletionEvidenceSha256: string;
  submittedBy: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  expiresAt: string;
  status: 'pending' | 'verified' | 'revoked';
  revokedAt: string | null;
}

export type HealthcareActivationReadinessDecision =
  | { valid: true; code: 'readiness_verified'; readinessId: string }
  | { valid: false; code:
      | 'readiness_missing'
      | 'readiness_reference_mismatch'
      | 'readiness_scope_mismatch'
      | 'readiness_identity_mismatch'
      | 'readiness_schema_mismatch'
      | 'readiness_database_mismatch'
      | 'readiness_evidence_mismatch'
      | 'readiness_caller_hash_mismatch'
      | 'readiness_check_failed'
      | 'readiness_not_verified'
      | 'readiness_not_independent'
      | 'readiness_digest_invalid'
      | 'readiness_expired'
      | 'readiness_expiry_mismatch'
      | 'readiness_revoked' };

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function evaluateHealthcareActivationReadiness(input: {
  tenantId: string;
  agentId: string;
  targetEnvironment: 'production_equivalent' | 'production';
  approvalExpiresAt: string;
  readinessRef: string;
  readiness: HealthcareActivationReadinessRecord | null;
  now?: Date;
}): HealthcareActivationReadinessDecision {
  const readiness = input.readiness;
  if (!readiness) return { valid: false, code: 'readiness_missing' };
  if (readiness.readinessRef !== input.readinessRef) {
    return { valid: false, code: 'readiness_reference_mismatch' };
  }
  if (
    readiness.tenantId !== input.tenantId
    || readiness.agentId !== input.agentId
    || readiness.targetEnvironment !== input.targetEnvironment
  ) return { valid: false, code: 'readiness_scope_mismatch' };
  if (
    readiness.coreVersion !== MASTER_VOICE_AGENT_CORE_VERSION
    || readiness.model !== MASTER_VOICE_AGENT_MODEL
    || readiness.rolePackageId !== 'healthcare-receptionist'
    || readiness.rolePackageVersion !== '1.0.0'
    || readiness.recordingPolicy !== 'disabled'
  ) return { valid: false, code: 'readiness_identity_mismatch' };
  if (
    readiness.catalogVersion !== HEALTHCARE_ACTIVATION_CATALOG_VERSION
    || readiness.catalogCount !== HEALTHCARE_ACTIVATION_CATALOG_COUNT
    || readiness.discoveredCount !== readiness.catalogCount
  ) return { valid: false, code: 'readiness_schema_mismatch' };
  if (
    readiness.tenantTableCount !== readiness.catalogCount
    || readiness.rlsEnabledCount !== readiness.tenantTableCount
  ) return { valid: false, code: 'readiness_database_mismatch' };
  if (readiness.verifiedControlCount !== HEALTHCARE_ACTIVATION_EVIDENCE_CONTROL_COUNT) {
    return { valid: false, code: 'readiness_evidence_mismatch' };
  }
  if (readiness.callerMissingCount !== 0 || readiness.callerStaleCount !== 0) {
    return { valid: false, code: 'readiness_caller_hash_mismatch' };
  }
  const statuses = [
    readiness.migrationStatus, readiness.schemaStatus, readiness.databaseStatus,
    readiness.keyringStatus, readiness.evidenceStatus, readiness.callerHashStatus,
    readiness.retentionStatus, readiness.deletionStatus,
  ];
  if (!statuses.every((status) => status === 'pass')) {
    return { valid: false, code: 'readiness_check_failed' };
  }
  if (readiness.revokedAt || readiness.status === 'revoked') {
    return { valid: false, code: 'readiness_revoked' };
  }
  if (readiness.status !== 'verified' || !readiness.verifiedBy || !readiness.verifiedAt) {
    return { valid: false, code: 'readiness_not_verified' };
  }
  if (readiness.submittedBy === readiness.verifiedBy) {
    return { valid: false, code: 'readiness_not_independent' };
  }
  if (![readiness.preflightSha256, readiness.evidenceSnapshotSha256,
    readiness.retentionPlanSha256, readiness.deletionEvidenceSha256]
    .every((value) => DIGEST_PATTERN.test(value))) {
    return { valid: false, code: 'readiness_digest_invalid' };
  }
  const now = (input.now ?? new Date()).getTime();
  const readinessExpiry = new Date(readiness.expiresAt).getTime();
  const approvalExpiry = new Date(input.approvalExpiresAt).getTime();
  if (!Number.isFinite(readinessExpiry) || readinessExpiry <= now) {
    return { valid: false, code: 'readiness_expired' };
  }
  if (!Number.isFinite(approvalExpiry) || readinessExpiry < approvalExpiry) {
    return { valid: false, code: 'readiness_expiry_mismatch' };
  }
  return { valid: true, code: 'readiness_verified', readinessId: readiness.id };
}
