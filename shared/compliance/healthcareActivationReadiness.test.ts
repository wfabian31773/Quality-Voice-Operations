import { describe, expect, it } from 'vitest';
import {
  evaluateHealthcareActivationReadiness,
  type HealthcareActivationReadinessRecord,
} from './healthcareActivationReadiness';

const now = new Date('2026-07-12T20:00:00.000Z');

function readiness(overrides: Partial<HealthcareActivationReadinessRecord> = {}): HealthcareActivationReadinessRecord {
  return {
    id: 'readiness-1',
    readinessRef: 'har_1234567890abcdef',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    targetEnvironment: 'production',
    coreVersion: '2.0.0',
    model: 'grok-voice-think-fast-2.0',
    rolePackageId: 'healthcare-receptionist',
    rolePackageVersion: '1.0.0',
    recordingPolicy: 'disabled',
    catalogVersion: '3.0.0',
    catalogCount: 188,
    discoveredCount: 188,
    tenantTableCount: 188,
    rlsEnabledCount: 188,
    verifiedControlCount: 11,
    callerMissingCount: 0,
    callerStaleCount: 0,
    migrationStatus: 'pass',
    schemaStatus: 'pass',
    databaseStatus: 'pass',
    keyringStatus: 'pass',
    evidenceStatus: 'pass',
    callerHashStatus: 'pass',
    retentionStatus: 'pass',
    deletionStatus: 'pass',
    preflightSha256: 'a'.repeat(64),
    evidenceSnapshotSha256: 'b'.repeat(64),
    retentionPlanSha256: 'c'.repeat(64),
    deletionEvidenceSha256: 'd'.repeat(64),
    submittedBy: 'admin-1',
    verifiedBy: 'admin-2',
    verifiedAt: '2026-07-12T19:30:00.000Z',
    expiresAt: '2026-07-20T19:00:00.000Z',
    status: 'verified',
    revokedAt: null,
    ...overrides,
  };
}

describe('healthcare activation readiness policy', () => {
  it('accepts one exact, independently verified, all-pass production attestation', () => {
    expect(evaluateHealthcareActivationReadiness({
      tenantId: 'tenant-1', agentId: 'agent-1', targetEnvironment: 'production',
      approvalExpiresAt: '2026-07-18T19:00:00.000Z', readinessRef: 'har_1234567890abcdef',
      readiness: readiness(), now,
    })).toEqual({ valid: true, code: 'readiness_verified', readinessId: 'readiness-1' });
  });

  it.each([
    ['missing', null, 'readiness_missing'],
    ['reference mismatch', readiness({ readinessRef: 'har_other' }), 'readiness_reference_mismatch'],
    ['scope mismatch', readiness({ tenantId: 'tenant-2' }), 'readiness_scope_mismatch'],
    ['environment mismatch', readiness({ targetEnvironment: 'production_equivalent' }), 'readiness_scope_mismatch'],
    ['runtime drift', readiness({ model: 'other-model' }), 'readiness_identity_mismatch'],
    ['catalog drift', readiness({ catalogVersion: '2.1.0' }), 'readiness_schema_mismatch'],
    ['catalog count drift', readiness({ discoveredCount: 187 }), 'readiness_schema_mismatch'],
    ['RLS gap', readiness({ rlsEnabledCount: 187 }), 'readiness_database_mismatch'],
    ['evidence gap', readiness({ verifiedControlCount: 10 }), 'readiness_evidence_mismatch'],
    ['caller gap', readiness({ callerMissingCount: 1 }), 'readiness_caller_hash_mismatch'],
    ['failed rehearsal', readiness({ deletionStatus: 'fail' }), 'readiness_check_failed'],
    ['self verified', readiness({ verifiedBy: 'admin-1' }), 'readiness_not_independent'],
    ['pending', readiness({ status: 'pending', verifiedBy: null, verifiedAt: null }), 'readiness_not_verified'],
    ['bad digest', readiness({ preflightSha256: 'not-a-digest' }), 'readiness_digest_invalid'],
    ['expired', readiness({ expiresAt: '2026-07-12T19:59:59.000Z' }), 'readiness_expired'],
    ['expires before approval', readiness({ expiresAt: '2026-07-15T19:00:00.000Z' }), 'readiness_expiry_mismatch'],
    ['revoked', readiness({ status: 'revoked', revokedAt: '2026-07-12T19:30:00.000Z' }), 'readiness_revoked'],
  ])('rejects %s', (_label, record, code) => {
    expect(evaluateHealthcareActivationReadiness({
      tenantId: 'tenant-1', agentId: 'agent-1', targetEnvironment: 'production',
      approvalExpiresAt: '2026-07-18T19:00:00.000Z', readinessRef: 'har_1234567890abcdef',
      readiness: record, now,
    })).toEqual({ valid: false, code });
  });
});
