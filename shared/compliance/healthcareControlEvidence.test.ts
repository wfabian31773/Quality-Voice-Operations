import { describe, expect, it } from 'vitest';
import { HEALTHCARE_APPROVAL_EVIDENCE_KEYS } from './healthcareDeploymentApproval';
import {
  HEALTHCARE_EVIDENCE_OWNER_ROLES,
  evaluateHealthcareControlEvidence,
  type HealthcareControlEvidenceRecord,
} from './healthcareControlEvidence';

const tenantId = 'tenant-1';
const agentId = 'agent-1';
const approvalExpiresAt = '2026-08-01T00:00:00.000Z';

function completeEvidence(): {
  refs: Record<string, string>;
  records: HealthcareControlEvidenceRecord[];
} {
  const refs: Record<string, string> = {};
  const records = HEALTHCARE_APPROVAL_EVIDENCE_KEYS.map((controlKey, index) => {
    const evidenceRef = `hce_${String(index + 1).padStart(2, '0')}`;
    refs[controlKey] = evidenceRef;
    return {
      id: `evidence-${index + 1}`,
      evidenceRef,
      controlKey,
      tenantId,
      agentId,
      environment: 'production' as const,
      artifactSha256: 'a'.repeat(64),
      artifactLocator: `vault://qvo/${controlKey}/artifact`,
      ownerRole: HEALTHCARE_EVIDENCE_OWNER_ROLES[controlKey],
      status: 'verified' as const,
      submittedBy: `submitter-${index}`,
      verifiedBy: `verifier-${index}`,
      verifiedAt: '2026-07-12T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      revokedAt: null,
    };
  });
  return { refs, records };
}

describe('healthcare control evidence policy', () => {
  it('accepts only a complete independently verified production evidence set', () => {
    const { refs, records } = completeEvidence();
    expect(evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: refs, records,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).toEqual({ valid: true, code: 'evidence_verified', recordIds: records.map(({ id }) => id) });
  });

  it.each([
    ['scope mismatch', (record: HealthcareControlEvidenceRecord) => ({ ...record, tenantId: 'tenant-2' }), 'evidence_scope_mismatch'],
    ['environment mismatch', (record: HealthcareControlEvidenceRecord) => ({ ...record, environment: 'staging' as const }), 'evidence_scope_mismatch'],
    ['wrong control key', (record: HealthcareControlEvidenceRecord) => ({ ...record, controlKey: 'customer_agreement' as const }), 'evidence_control_mismatch'],
    ['wrong owner role', (record: HealthcareControlEvidenceRecord) => ({ ...record, ownerRole: record.ownerRole === 'compliance' ? 'infrastructure' as const : 'compliance' as const }), 'evidence_owner_mismatch'],
    ['unverified', (record: HealthcareControlEvidenceRecord) => ({ ...record, status: 'pending' as const }), 'evidence_not_verified'],
    ['self verified', (record: HealthcareControlEvidenceRecord) => ({ ...record, verifiedBy: record.submittedBy }), 'evidence_not_independent'],
    ['revoked', (record: HealthcareControlEvidenceRecord) => ({ ...record, revokedAt: '2026-07-13T00:00:00.000Z' }), 'evidence_revoked'],
    ['bad digest', (record: HealthcareControlEvidenceRecord) => ({ ...record, artifactSha256: 'not-a-digest' }), 'evidence_digest_invalid'],
    ['expires before approval', (record: HealthcareControlEvidenceRecord) => ({ ...record, expiresAt: '2026-07-20T00:00:00.000Z' }), 'evidence_expiry_mismatch'],
  ])('rejects %s', (_label, mutate, code) => {
    const { refs, records } = completeEvidence();
    records[0] = mutate(records[0]);
    expect(evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: refs, records,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).toMatchObject({ valid: false, code });
  });

  it('rejects missing, duplicate, unknown, or expired evidence without leaking artifact metadata', () => {
    const { refs, records } = completeEvidence();
    const missing = records.slice(1);
    expect(evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: refs, records: missing,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).toEqual({ valid: false, code: 'evidence_missing' });

    const duplicate = [...records, { ...records[0], id: 'duplicate' }];
    expect(evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: refs, records: duplicate,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).toEqual({ valid: false, code: 'evidence_duplicate' });

    const withUnknown = { ...refs, unsupported_control: 'hce_unknown' };
    const unknownResult = evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: withUnknown, records,
      now: new Date('2026-07-13T00:00:00.000Z'),
    });
    expect(unknownResult).toEqual({ valid: false, code: 'evidence_control_mismatch' });
    expect(JSON.stringify(unknownResult)).not.toContain('vault://');

    records[0] = { ...records[0], expiresAt: '2026-07-12T23:59:59.000Z' };
    expect(evaluateHealthcareControlEvidence({
      tenantId, agentId, approvalExpiresAt, evidenceRefs: refs, records,
      now: new Date('2026-07-13T00:00:00.000Z'),
    })).toMatchObject({ valid: false, code: 'evidence_expired' });
  });
});
