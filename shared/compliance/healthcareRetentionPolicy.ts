import type { HealthcareControlEvidenceRecord } from './healthcareControlEvidence';

export const HEALTHCARE_RETENTION_POLICY_SCHEMA_VERSION = '1.0.0' as const;

export const HEALTHCARE_RETENTION_SCOPES = [
  'call_sessions',
  'call_transcripts',
  'call_events',
  'tool_invocations',
  'outbox',
  'tickets',
  'escalations',
  'knowledge',
  'logs',
  'control_evidence',
  'first_party_files',
  'backups',
  'external_processors',
] as const;

export type HealthcareRetentionScope = (typeof HEALTHCARE_RETENTION_SCOPES)[number];

export interface HealthcareRetentionPolicy {
  policyId: string;
  version: string;
  tenantId: string;
  agentId: string;
  environment: 'production';
  effectiveAt: string;
  expiresAt: string;
  evidenceRef: string;
  legalHoldMode: 'block_all_deletion';
  rules: Record<HealthcareRetentionScope, { retentionDays: number }>;
}

export type HealthcareRetentionPolicyDecision =
  | { valid: true; code: 'retention_policy_verified'; evidenceRecordId: string }
  | { valid: false; code:
      | 'retention_policy_identity_invalid'
      | 'retention_policy_inactive'
      | 'retention_scope_incomplete'
      | 'retention_duration_invalid'
      | 'retention_legal_hold_invalid'
      | 'retention_evidence_mismatch'
      | 'retention_evidence_not_verified'
      | 'retention_evidence_not_independent'
      | 'retention_evidence_expired' };

const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,99}$/;
const POLICY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function evaluateHealthcareRetentionPolicy(input: {
  policy: HealthcareRetentionPolicy;
  evidence: HealthcareControlEvidenceRecord;
  now?: Date;
}): HealthcareRetentionPolicyDecision {
  const { policy, evidence } = input;
  if (
    !POLICY_ID_PATTERN.test(policy.policyId)
    || !POLICY_VERSION_PATTERN.test(policy.version)
    || !policy.tenantId
    || !policy.agentId
    || policy.environment !== 'production'
  ) return { valid: false, code: 'retention_policy_identity_invalid' };

  const suppliedScopes = Object.keys(policy.rules);
  const expectedScopes = new Set<string>(HEALTHCARE_RETENTION_SCOPES);
  if (
    suppliedScopes.length !== expectedScopes.size
    || suppliedScopes.some((scope) => !expectedScopes.has(scope))
    || HEALTHCARE_RETENTION_SCOPES.some((scope) => !policy.rules[scope])
  ) return { valid: false, code: 'retention_scope_incomplete' };

  if (HEALTHCARE_RETENTION_SCOPES.some((scope) => {
    const days = policy.rules[scope].retentionDays;
    return !Number.isInteger(days) || days < 1 || days > 3650;
  })) return { valid: false, code: 'retention_duration_invalid' };

  if (policy.legalHoldMode !== 'block_all_deletion') {
    return { valid: false, code: 'retention_legal_hold_invalid' };
  }

  const now = (input.now ?? new Date()).getTime();
  const effectiveAt = new Date(policy.effectiveAt).getTime();
  const expiresAt = new Date(policy.expiresAt).getTime();
  if (
    !Number.isFinite(effectiveAt)
    || !Number.isFinite(expiresAt)
    || effectiveAt > now
    || expiresAt <= now
    || expiresAt <= effectiveAt
  ) return { valid: false, code: 'retention_policy_inactive' };

  if (
    evidence.evidenceRef !== policy.evidenceRef
    || evidence.controlKey !== 'retention_controls'
    || evidence.tenantId !== policy.tenantId
    || evidence.agentId !== policy.agentId
    || evidence.environment !== 'production'
    || evidence.ownerRole !== 'compliance'
    || !DIGEST_PATTERN.test(evidence.artifactSha256)
  ) return { valid: false, code: 'retention_evidence_mismatch' };
  if (evidence.status !== 'verified' || !evidence.verifiedBy || !evidence.verifiedAt) {
    return { valid: false, code: 'retention_evidence_not_verified' };
  }
  if (evidence.submittedBy === evidence.verifiedBy) {
    return { valid: false, code: 'retention_evidence_not_independent' };
  }
  const evidenceExpiry = new Date(evidence.expiresAt).getTime();
  if (
    evidence.revokedAt
    || !Number.isFinite(evidenceExpiry)
    || evidenceExpiry <= now
    || evidenceExpiry < expiresAt
  ) return { valid: false, code: 'retention_evidence_expired' };

  return {
    valid: true,
    code: 'retention_policy_verified',
    evidenceRecordId: evidence.id,
  };
}
