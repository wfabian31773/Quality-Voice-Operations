export const HEALTHCARE_APPROVAL_EVIDENCE_KEYS = [
  'compliance_owner_approval',
  'customer_agreement',
  'twilio_approval',
  'openai_approval',
  'hosting_approval',
  'storage_controls',
  'retention_controls',
  'deletion_controls',
  'deployment_security',
  'recording_disabled',
  'pilot_acceptance',
] as const;

export const SYNTHETIC_APPROVAL_EVIDENCE_KEYS = [
  'test_authorization',
  'synthetic_data_protocol',
  'recording_disabled',
] as const;

export type HealthcareApprovalEvidenceKey = (typeof HEALTHCARE_APPROVAL_EVIDENCE_KEYS)[number];
export type HealthcareApprovalKind = 'synthetic_test' | 'production_healthcare';

export interface HealthcareDeploymentApprovalRecord {
  id: string;
  tenantId: string;
  agentId: string;
  approvalKind: HealthcareApprovalKind;
  coreVersion: string;
  model: string;
  rolePackageId: string;
  rolePackageVersion: string;
  recordingPolicy: string;
  evidenceRefs: Record<string, unknown>;
  syntheticCallerHashes: string[];
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  readinessRef: string | null;
}

export type HealthcareApprovalDecisionCode =
  | 'not_healthcare'
  | 'approval_missing'
  | 'approval_scope_mismatch'
  | 'runtime_identity_mismatch'
  | 'recording_not_approved'
  | 'approval_expired'
  | 'approval_revoked'
  | 'synthetic_evidence_incomplete'
  | 'synthetic_caller_not_approved'
  | 'synthetic_test_approved'
  | 'production_evidence_incomplete'
  | 'production_readiness_missing'
  | 'production_readiness_incomplete'
  | 'production_healthcare_approved';

export interface HealthcareApprovalDecision {
  allowed: boolean;
  code: HealthcareApprovalDecisionCode;
  approvalId?: string;
}

const HEALTHCARE_IDENTITIES = new Set([
  'answering_service',
  'answering-service',
  'healthcare_receptionist',
  'healthcare-receptionist',
]);

export function isHealthcareReceptionistIdentity(agentType: unknown, agentId: unknown): boolean {
  return (typeof agentType === 'string' && HEALTHCARE_IDENTITIES.has(agentType.trim().toLowerCase()))
    || (typeof agentId === 'string' && HEALTHCARE_IDENTITIES.has(agentId.trim().toLowerCase()));
}

function hasEvidence(
  evidenceRefs: Record<string, unknown>,
  requiredKeys: readonly string[],
): boolean {
  return requiredKeys.every((key) => {
    const value = evidenceRefs[key];
    return typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 500;
  });
}

export function evaluateHealthcareDeploymentApproval(input: {
  tenantId: string;
  agentId: string;
  agentType: string;
  approval: HealthcareDeploymentApprovalRecord | null;
  syntheticCallerMatched: boolean;
  now?: Date;
}): HealthcareApprovalDecision {
  if (!isHealthcareReceptionistIdentity(input.agentType, input.agentId)) {
    return { allowed: true, code: 'not_healthcare' };
  }

  const approval = input.approval;
  if (!approval) return { allowed: false, code: 'approval_missing' };
  if (approval.tenantId !== input.tenantId || approval.agentId !== input.agentId) {
    return { allowed: false, code: 'approval_scope_mismatch' };
  }
  if (
    approval.coreVersion !== '1.0.0'
    || approval.model !== 'gpt-realtime-2'
    || approval.rolePackageId !== 'healthcare-receptionist'
    || approval.rolePackageVersion !== '1.0.0'
  ) {
    return { allowed: false, code: 'runtime_identity_mismatch' };
  }
  if (approval.recordingPolicy !== 'disabled') {
    return { allowed: false, code: 'recording_not_approved' };
  }
  if (approval.revokedAt) return { allowed: false, code: 'approval_revoked' };

  const expiry = new Date(approval.expiresAt);
  const now = input.now ?? new Date();
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    return { allowed: false, code: 'approval_expired' };
  }

  if (approval.approvalKind === 'synthetic_test') {
    if (!hasEvidence(approval.evidenceRefs, SYNTHETIC_APPROVAL_EVIDENCE_KEYS)) {
      return { allowed: false, code: 'synthetic_evidence_incomplete' };
    }
    if (!input.syntheticCallerMatched) {
      return { allowed: false, code: 'synthetic_caller_not_approved' };
    }
    return { allowed: true, code: 'synthetic_test_approved', approvalId: approval.id };
  }

  if (approval.approvalKind === 'production_healthcare') {
    if (!approval.readinessRef || !/^har_[a-f0-9]{3,36}$/.test(approval.readinessRef)) {
      return { allowed: false, code: 'production_readiness_missing' };
    }
    if (!hasEvidence(approval.evidenceRefs, HEALTHCARE_APPROVAL_EVIDENCE_KEYS)) {
      return { allowed: false, code: 'production_evidence_incomplete' };
    }
    return { allowed: true, code: 'production_healthcare_approved', approvalId: approval.id };
  }

  return { allowed: false, code: 'production_evidence_incomplete' };
}
