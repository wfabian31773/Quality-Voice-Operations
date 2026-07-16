import { describe, expect, it } from 'vitest';
import {
  HEALTHCARE_RETENTION_SCOPES,
  evaluateHealthcareRetentionPolicy,
  type HealthcareRetentionPolicy,
} from './healthcareRetentionPolicy';
import type { HealthcareControlEvidenceRecord } from './healthcareControlEvidence';

const now = new Date('2026-07-12T20:00:00.000Z');

function policy(): HealthcareRetentionPolicy {
  return {
    policyId: 'healthcare-pilot-retention',
    version: '1.0.0',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    environment: 'production',
    effectiveAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    evidenceRef: 'hce_retention',
    legalHoldMode: 'block_all_deletion',
    rules: Object.fromEntries(HEALTHCARE_RETENTION_SCOPES.map((scope) => [
      scope, { retentionDays: 30 },
    ])) as HealthcareRetentionPolicy['rules'],
  };
}

function evidence(): HealthcareControlEvidenceRecord {
  return {
    id: 'evidence-1', evidenceRef: 'hce_retention', controlKey: 'retention_controls',
    tenantId: 'tenant-1', agentId: 'agent-1', environment: 'production',
    artifactSha256: 'a'.repeat(64), artifactLocator: '', ownerRole: 'compliance',
    status: 'verified', submittedBy: 'submitter', verifiedBy: 'verifier',
    verifiedAt: '2026-07-02T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
  };
}

describe('healthcare retention policy', () => {
  it('accepts an exact, owner-evidence-bound plan with explicit durations for every scope', () => {
    expect(evaluateHealthcareRetentionPolicy({ policy: policy(), evidence: evidence(), now })).toEqual({
      valid: true, code: 'retention_policy_verified', evidenceRecordId: 'evidence-1',
    });
  });

  it('does not invent a duration when one scope is missing or malformed', () => {
    const missing = policy();
    delete (missing.rules as Partial<typeof missing.rules>).backups;
    expect(evaluateHealthcareRetentionPolicy({ policy: missing, evidence: evidence(), now })).toEqual({
      valid: false, code: 'retention_scope_incomplete',
    });

    const malformed = policy();
    malformed.rules.call_sessions.retentionDays = 0;
    expect(evaluateHealthcareRetentionPolicy({ policy: malformed, evidence: evidence(), now })).toEqual({
      valid: false, code: 'retention_duration_invalid',
    });
  });

  it('rejects unverified, non-independent, revoked, mismatched, or short-lived evidence', () => {
    for (const mutate of [
      (record: HealthcareControlEvidenceRecord) => { record.status = 'pending'; record.verifiedBy = null; },
      (record: HealthcareControlEvidenceRecord) => { record.verifiedBy = record.submittedBy; },
      (record: HealthcareControlEvidenceRecord) => { record.status = 'revoked'; record.revokedAt = now.toISOString(); },
      (record: HealthcareControlEvidenceRecord) => { record.controlKey = 'storage_controls'; },
      (record: HealthcareControlEvidenceRecord) => { record.expiresAt = '2026-09-01T00:00:00.000Z'; },
    ]) {
      const record = evidence();
      mutate(record);
      expect(evaluateHealthcareRetentionPolicy({ policy: policy(), evidence: record, now }).valid).toBe(false);
    }
  });

  it('requires an active production policy with legal holds blocking deletion', () => {
    const candidate = policy();
    candidate.legalHoldMode = 'unsupported' as never;
    expect(evaluateHealthcareRetentionPolicy({ policy: candidate, evidence: evidence(), now })).toEqual({
      valid: false, code: 'retention_legal_hold_invalid',
    });
  });
});
