import { withPrivilegedClient } from '../db';
import {
  evaluateHealthcareControlEvidence,
  type HealthcareControlEvidenceDecision,
  type HealthcareControlEvidenceRecord,
  type HealthcareEvidenceOwnerRole,
} from '../../shared/compliance/healthcareControlEvidence';
import type { HealthcareApprovalEvidenceKey } from '../../shared/compliance/healthcareDeploymentApproval';

function mapEvidence(row: Record<string, unknown>): HealthcareControlEvidenceRecord {
  return {
    id: String(row.id),
    evidenceRef: String(row.evidence_ref),
    controlKey: String(row.control_key) as HealthcareApprovalEvidenceKey,
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    environment: row.environment === 'staging' ? 'staging' : 'production',
    artifactSha256: String(row.artifact_sha256),
    artifactLocator: '',
    ownerRole: String(row.owner_role) as HealthcareEvidenceOwnerRole,
    status: row.status === 'verified' ? 'verified' : row.status === 'revoked' ? 'revoked' : 'pending',
    submittedBy: String(row.submitted_by),
    verifiedBy: row.verified_by ? String(row.verified_by) : null,
    verifiedAt: row.verified_at ? new Date(String(row.verified_at)).toISOString() : null,
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
  };
}

export async function verifyHealthcareControlEvidenceRefs(input: {
  tenantId: string;
  agentId: string;
  approvalExpiresAt: string;
  evidenceRefs: Record<string, string>;
  now?: Date;
}): Promise<HealthcareControlEvidenceDecision> {
  const refs = Object.values(input.evidenceRefs);
  if (refs.length === 0) return { valid: false, code: 'evidence_missing' };

  const records = await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, evidence_ref, control_key, tenant_id, agent_id, environment,
              artifact_sha256, owner_role, status, submitted_by, verified_by,
              verified_at, expires_at, revoked_at
         FROM healthcare_control_evidence
        WHERE evidence_ref = ANY($1::text[])`,
      [refs],
    );
    return rows.map(mapEvidence);
  });

  return evaluateHealthcareControlEvidence({ ...input, records });
}
