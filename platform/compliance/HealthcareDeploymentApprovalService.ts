import { withPrivilegedClient } from '../db';
import {
  evaluateHealthcareDeploymentApproval,
  isHealthcareReceptionistIdentity,
  type HealthcareDeploymentApprovalRecord,
  type HealthcareApprovalDecision,
} from '../../shared/compliance/healthcareDeploymentApproval';
import { constantTimeHashMatch, createPiiLookupHash } from '../security/PiiLookupHash';
import { verifyHealthcareControlEvidenceRefs } from './HealthcareControlEvidenceService';
import { verifyHealthcareActivationReadinessRef } from './HealthcareActivationReadinessService';

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mapApproval(row: Record<string, unknown>): HealthcareDeploymentApprovalRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    approvalKind: row.approval_kind === 'production_healthcare' ? 'production_healthcare' : 'synthetic_test',
    coreVersion: String(row.core_version),
    model: String(row.model),
    rolePackageId: String(row.role_package_id),
    rolePackageVersion: String(row.role_package_version),
    recordingPolicy: String(row.recording_policy),
    evidenceRefs: asObject(row.evidence_refs),
    syntheticCallerHashes: asStringArray(row.synthetic_caller_hashes),
    approvedBy: String(row.approved_by),
    approvedAt: new Date(String(row.approved_at)).toISOString(),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
    readinessRef: row.readiness_ref ? String(row.readiness_ref) : null,
  };
}

export async function getActiveHealthcareDeploymentApproval(
  tenantId: string,
  agentId: string,
): Promise<HealthcareDeploymentApprovalRecord | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, agent_id, approval_kind, core_version, model,
              role_package_id, role_package_version, recording_policy,
              evidence_refs, synthetic_caller_hashes, approved_by,
              approved_at, expires_at, revoked_at, readiness_ref
         FROM healthcare_deployment_approvals
        WHERE tenant_id = $1 AND agent_id = $2
          AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY approved_at DESC
        LIMIT 1`,
      [tenantId, agentId],
    );
    return rows[0] ? mapApproval(rows[0] as Record<string, unknown>) : null;
  });
}

export async function authorizeHealthcareDeployment(input: {
  tenantId: string;
  agentId: string;
  agentType: string;
  subjectPhone?: string;
  now?: Date;
}): Promise<HealthcareApprovalDecision> {
  if (!isHealthcareReceptionistIdentity(input.agentType, input.agentId)) {
    return { allowed: true, code: 'not_healthcare' };
  }
  const approval = await getActiveHealthcareDeploymentApproval(input.tenantId, input.agentId);
  const candidateHash = approval?.approvalKind === 'synthetic_test'
    ? createPiiLookupHash(input.tenantId, input.subjectPhone, 'synthetic_test')
    : null;
  const syntheticCallerMatched = approval?.approvalKind === 'synthetic_test'
    ? constantTimeHashMatch(candidateHash, approval.syntheticCallerHashes)
    : false;
  const decision = evaluateHealthcareDeploymentApproval({
    tenantId: input.tenantId,
    agentId: input.agentId,
    agentType: input.agentType,
    approval,
    syntheticCallerMatched,
    now: input.now,
  });
  if (decision.allowed && approval?.approvalKind === 'production_healthcare') {
    const evidenceDecision = await verifyHealthcareControlEvidenceRefs({
      tenantId: input.tenantId,
      agentId: input.agentId,
      approvalExpiresAt: approval.expiresAt,
      evidenceRefs: approval.evidenceRefs as Record<string, string>,
      now: input.now,
    });
    if (!evidenceDecision.valid) {
      return { allowed: false, code: 'production_evidence_incomplete' };
    }
    const readinessDecision = await verifyHealthcareActivationReadinessRef({
      tenantId: input.tenantId,
      agentId: input.agentId,
      targetEnvironment: 'production',
      approvalExpiresAt: approval.expiresAt,
      readinessRef: approval.readinessRef ?? '',
      now: input.now,
    });
    if (!readinessDecision.valid) {
      return { allowed: false, code: 'production_readiness_incomplete' };
    }
  }
  return decision;
}
