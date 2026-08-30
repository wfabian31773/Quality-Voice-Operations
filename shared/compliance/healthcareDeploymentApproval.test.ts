import { describe, expect, it } from 'vitest';
import {
  HEALTHCARE_APPROVAL_EVIDENCE_KEYS,
  evaluateHealthcareDeploymentApproval,
  isHealthcareReceptionistIdentity,
  type HealthcareDeploymentApprovalRecord,
} from './healthcareDeploymentApproval';

const now = new Date('2026-07-12T20:00:00.000Z');

function evidence(): Record<(typeof HEALTHCARE_APPROVAL_EVIDENCE_KEYS)[number], string> {
  return Object.fromEntries(
    HEALTHCARE_APPROVAL_EVIDENCE_KEYS.map((key) => [key, `evidence/${key}/approved-1`]),
  ) as Record<(typeof HEALTHCARE_APPROVAL_EVIDENCE_KEYS)[number], string>;
}

function approval(overrides: Partial<HealthcareDeploymentApprovalRecord> = {}): HealthcareDeploymentApprovalRecord {
  return {
    id: 'approval-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    approvalKind: 'synthetic_test',
    coreVersion: '2.0.0',
    model: 'grok-voice-think-fast-2.0',
    rolePackageId: 'healthcare-receptionist',
    rolePackageVersion: '1.0.0',
    recordingPolicy: 'disabled',
    evidenceRefs: {
      test_authorization: 'evidence/test/authorized-1',
      synthetic_data_protocol: 'evidence/test/synthetic-1',
      recording_disabled: 'evidence/test/recording-disabled-1',
    },
    syntheticCallerHashes: ['hash-1'],
    approvedBy: 'platform-admin-1',
    approvedAt: '2026-07-12T19:00:00.000Z',
    expiresAt: '2026-07-20T19:00:00.000Z',
    revokedAt: null,
    readinessRef: null,
    ...overrides,
  };
}

describe('healthcare deployment approval policy', () => {
  it.each([
    ['answering_service', 'agent-1'],
    ['answering-service', 'agent-1'],
    ['healthcare_receptionist', 'agent-1'],
    ['healthcare-receptionist', 'agent-1'],
    ['outbound', 'healthcare-receptionist'],
  ])('recognizes healthcare identity %s / %s', (agentType, agentId) => {
    expect(isHealthcareReceptionistIdentity(agentType, agentId)).toBe(true);
  });

  it('does not impose the healthcare gate on an unrelated role package', () => {
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'home-services',
      approval: null, syntheticCallerMatched: false, now,
    })).toEqual({ allowed: true, code: 'not_healthcare' });
  });

  it('denies healthcare traffic when no approval exists', () => {
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
      approval: null, syntheticCallerMatched: false, now,
    })).toEqual({ allowed: false, code: 'approval_missing' });
  });

  it('allows an exact, unexpired synthetic approval only for an allowlisted caller', () => {
    const allowed = evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
      approval: approval(), syntheticCallerMatched: true, now,
    });
    expect(allowed).toEqual({ allowed: true, code: 'synthetic_test_approved', approvalId: 'approval-1' });

    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
      approval: approval(), syntheticCallerMatched: false, now,
    })).toEqual({ allowed: false, code: 'synthetic_caller_not_approved' });
  });

  it.each([
    ['tenant mismatch', { tenantId: 'tenant-2' }, 'approval_scope_mismatch'],
    ['agent mismatch', { agentId: 'agent-2' }, 'approval_scope_mismatch'],
    ['core drift', { coreVersion: '2.0.0' }, 'runtime_identity_mismatch'],
    ['model drift', { model: 'other-model' }, 'runtime_identity_mismatch'],
    ['role drift', { rolePackageVersion: '2.0.0' }, 'runtime_identity_mismatch'],
    ['recording enabled', { recordingPolicy: 'enabled' }, 'recording_not_approved'],
    ['expired', { expiresAt: '2026-07-12T19:59:59.000Z' }, 'approval_expired'],
    ['revoked', { revokedAt: '2026-07-12T19:30:00.000Z' }, 'approval_revoked'],
  ])('denies %s', (_label, overrides, expectedCode) => {
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
      approval: approval(overrides as Partial<HealthcareDeploymentApprovalRecord>),
      syntheticCallerMatched: true, now,
    })).toEqual({ allowed: false, code: expectedCode });
  });

  it('requires every production evidence reference and does not accept boolean assertions', () => {
    const production = approval({
      approvalKind: 'production_healthcare',
      evidenceRefs: evidence(),
      syntheticCallerHashes: [],
      readinessRef: 'har_abc',
    });
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'healthcare-receptionist',
      approval: production, syntheticCallerMatched: false, now,
    })).toEqual({ allowed: true, code: 'production_healthcare_approved', approvalId: 'approval-1' });

    const incomplete = { ...evidence() };
    delete (incomplete as Partial<Record<string, string>>).openai_approval;
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'healthcare-receptionist',
      approval: { ...production, evidenceRefs: incomplete }, syntheticCallerMatched: false, now,
    })).toEqual({ allowed: false, code: 'production_evidence_incomplete' });
  });

  it('requires a readiness reference for every production approval', () => {
    expect(evaluateHealthcareDeploymentApproval({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'healthcare-receptionist',
      approval: approval({ approvalKind: 'production_healthcare', evidenceRefs: evidence(), readinessRef: null }),
      syntheticCallerMatched: false, now,
    })).toEqual({ allowed: false, code: 'production_readiness_missing' });
  });
});
