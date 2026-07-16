import {
  HEALTHCARE_APPROVAL_EVIDENCE_KEYS,
  type HealthcareApprovalEvidenceKey,
} from './healthcareDeploymentApproval';

export type HealthcareEvidenceOwnerRole =
  | 'compliance'
  | 'infrastructure'
  | 'product_safety'
  | 'pilot_customer';

export const HEALTHCARE_EVIDENCE_OWNER_ROLES: Readonly<
Record<HealthcareApprovalEvidenceKey, HealthcareEvidenceOwnerRole>
> = Object.freeze({
  compliance_owner_approval: 'compliance',
  customer_agreement: 'compliance',
  twilio_approval: 'infrastructure',
  openai_approval: 'infrastructure',
  hosting_approval: 'infrastructure',
  storage_controls: 'infrastructure',
  retention_controls: 'compliance',
  deletion_controls: 'compliance',
  deployment_security: 'infrastructure',
  recording_disabled: 'product_safety',
  pilot_acceptance: 'pilot_customer',
});

export interface HealthcareControlEvidenceRecord {
  id: string;
  evidenceRef: string;
  controlKey: HealthcareApprovalEvidenceKey;
  tenantId: string;
  agentId: string;
  environment: 'staging' | 'production';
  artifactSha256: string;
  artifactLocator: string;
  ownerRole: HealthcareEvidenceOwnerRole;
  status: 'pending' | 'verified' | 'revoked';
  submittedBy: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export type HealthcareControlEvidenceDecision =
  | { valid: true; code: 'evidence_verified'; recordIds: string[] }
  | { valid: false; code:
      | 'evidence_missing'
      | 'evidence_duplicate'
      | 'evidence_control_mismatch'
      | 'evidence_owner_mismatch'
      | 'evidence_scope_mismatch'
      | 'evidence_not_verified'
      | 'evidence_not_independent'
      | 'evidence_revoked'
      | 'evidence_digest_invalid'
      | 'evidence_expired'
      | 'evidence_expiry_mismatch' };

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function evaluateHealthcareControlEvidence(input: {
  tenantId: string;
  agentId: string;
  approvalExpiresAt: string;
  evidenceRefs: Record<string, string>;
  records: readonly HealthcareControlEvidenceRecord[];
  now?: Date;
}): HealthcareControlEvidenceDecision {
  const required = new Set<string>(HEALTHCARE_APPROVAL_EVIDENCE_KEYS);
  const suppliedKeys = Object.keys(input.evidenceRefs);
  if (suppliedKeys.length !== required.size || suppliedKeys.some((key) => !required.has(key))) {
    return { valid: false, code: 'evidence_control_mismatch' };
  }

  const byRef = new Map<string, HealthcareControlEvidenceRecord>();
  for (const record of input.records) {
    if (byRef.has(record.evidenceRef)) return { valid: false, code: 'evidence_duplicate' };
    byRef.set(record.evidenceRef, record);
  }

  const approvalExpiry = new Date(input.approvalExpiresAt).getTime();
  const now = (input.now ?? new Date()).getTime();
  const recordIds: string[] = [];

  for (const controlKey of HEALTHCARE_APPROVAL_EVIDENCE_KEYS) {
    const evidenceRef = input.evidenceRefs[controlKey];
    const record = byRef.get(evidenceRef);
    if (!record) return { valid: false, code: 'evidence_missing' };
    if (record.controlKey !== controlKey) return { valid: false, code: 'evidence_control_mismatch' };
    if (record.ownerRole !== HEALTHCARE_EVIDENCE_OWNER_ROLES[controlKey]) {
      return { valid: false, code: 'evidence_owner_mismatch' };
    }
    if (
      record.tenantId !== input.tenantId
      || record.agentId !== input.agentId
      || record.environment !== 'production'
    ) {
      return { valid: false, code: 'evidence_scope_mismatch' };
    }
    if (record.status !== 'verified' || !record.verifiedBy || !record.verifiedAt) {
      return { valid: false, code: 'evidence_not_verified' };
    }
    if (record.submittedBy === record.verifiedBy) {
      return { valid: false, code: 'evidence_not_independent' };
    }
    if (record.revokedAt) return { valid: false, code: 'evidence_revoked' };
    if (!DIGEST_PATTERN.test(record.artifactSha256)) {
      return { valid: false, code: 'evidence_digest_invalid' };
    }
    const evidenceExpiry = new Date(record.expiresAt).getTime();
    if (!Number.isFinite(evidenceExpiry) || evidenceExpiry <= now) {
      return { valid: false, code: 'evidence_expired' };
    }
    if (!Number.isFinite(approvalExpiry) || evidenceExpiry < approvalExpiry) {
      return { valid: false, code: 'evidence_expiry_mismatch' };
    }
    recordIds.push(record.id);
  }

  return { valid: true, code: 'evidence_verified', recordIds };
}
