import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), withPrivilegedClient: vi.fn(), verifyEvidence: vi.fn(), verifyReadiness: vi.fn(),
}));

vi.mock('../db', () => ({
  withPrivilegedClient: mocks.withPrivilegedClient,
}));
vi.mock('./HealthcareControlEvidenceService', () => ({
  verifyHealthcareControlEvidenceRefs: mocks.verifyEvidence,
}));
vi.mock('./HealthcareActivationReadinessService', () => ({
  verifyHealthcareActivationReadinessRef: mocks.verifyReadiness,
}));

import {
  authorizeHealthcareDeployment,
  getActiveHealthcareDeploymentApproval,
} from './HealthcareDeploymentApprovalService';

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.withPrivilegedClient.mockReset().mockImplementation(
    async (callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => callback({ query: mocks.query }),
  );
  mocks.verifyEvidence.mockReset().mockResolvedValue({
    valid: true, code: 'evidence_verified', recordIds: ['evidence-1'],
  });
  mocks.verifyReadiness.mockReset().mockResolvedValue({
    valid: true, code: 'readiness_verified', readinessId: 'readiness-1',
  });
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
});

describe('healthcare deployment approval repository', () => {
  it('loads only an unrevoked, unexpired, tenant-and-agent-scoped record', async () => {
    await getActiveHealthcareDeploymentApproval('tenant-1', 'agent-1');
    expect(mocks.withPrivilegedClient).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringMatching(
      /tenant_id = \$1[\s\S]*agent_id = \$2[\s\S]*revoked_at IS NULL[\s\S]*expires_at > NOW\(\)/,
    ), ['tenant-1', 'agent-1']);
  });

  it('does not query approval storage for an unrelated role', async () => {
    await expect(authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'home-services', subjectPhone: '+15551234567',
    })).resolves.toEqual({ allowed: true, code: 'not_healthcare' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('maps serialized JSON fields defensively without exposing malformed values', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: 'approval-json', tenant_id: 'tenant-1', agent_id: 'agent-1',
        approval_kind: 'production_healthcare', core_version: '1.0.0', model: 'gpt-realtime-2',
        role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0',
        recording_policy: 'disabled', evidence_refs: '{"pilot_acceptance":"evidence/pilot/1"}',
        synthetic_caller_hashes: ['hash-1', 42], approved_by: 'admin-1',
        approved_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-07-20T19:00:00.000Z',
        revoked_at: '2026-07-13T19:00:00.000Z', readiness_ref: 'har_abc',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'approval-malformed', tenant_id: 'tenant-1', agent_id: 'agent-1',
        approval_kind: 'synthetic_test', core_version: '1.0.0', model: 'gpt-realtime-2',
        role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0',
        recording_policy: 'disabled', evidence_refs: '{malformed', synthetic_caller_hashes: null,
        approved_by: 'admin-1', approved_at: '2026-07-12T19:00:00.000Z',
        expires_at: '2099-07-20T19:00:00.000Z', revoked_at: null,
      }] });

    await expect(getActiveHealthcareDeploymentApproval('tenant-1', 'agent-1')).resolves.toMatchObject({
      approvalKind: 'production_healthcare',
      evidenceRefs: { pilot_acceptance: 'evidence/pilot/1' },
      readinessRef: 'har_abc',
      syntheticCallerHashes: ['hash-1'],
      revokedAt: '2026-07-13T19:00:00.000Z',
    });
    await expect(getActiveHealthcareDeploymentApproval('tenant-1', 'agent-1')).resolves.toMatchObject({
      evidenceRefs: {}, syntheticCallerHashes: [], revokedAt: null,
    });
  });

  it('denies healthcare by default and never logs or returns the subject phone', async () => {
    const result = await authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service', subjectPhone: '+15551234567',
    });
    expect(result).toEqual({ allowed: false, code: 'approval_missing' });
    expect(JSON.stringify(result)).not.toContain('5551234567');
  });

  it('matches a synthetic caller by purpose-separated HMAC', async () => {
    const { createPiiLookupHash } = await import('../security/PiiLookupHash');
    const hash = createPiiLookupHash('tenant-1', '+15551234567', 'synthetic_test');
    mocks.query.mockResolvedValue({ rows: [{
      id: 'approval-1', tenant_id: 'tenant-1', agent_id: 'agent-1', approval_kind: 'synthetic_test',
      core_version: '1.0.0', model: 'gpt-realtime-2', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', evidence_refs: {
        test_authorization: 'evidence/test/auth', synthetic_data_protocol: 'evidence/test/synthetic',
        recording_disabled: 'evidence/test/recording',
      }, synthetic_caller_hashes: [hash], approved_by: 'admin-1',
      approved_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-07-20T19:00:00.000Z', revoked_at: null,
    }] });
    await expect(authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service', subjectPhone: '(555) 123-4567',
    })).resolves.toMatchObject({ allowed: true, code: 'synthetic_test_approved', approvalId: 'approval-1' });
  });

  it('authorizes a complete production approval without requiring a caller hash', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'approval-prod', tenant_id: 'tenant-1', agent_id: 'agent-1', approval_kind: 'production_healthcare',
      core_version: '1.0.0', model: 'gpt-realtime-2', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', evidence_refs: {
        compliance_owner_approval: 'evidence/compliance/owner-1', customer_agreement: 'evidence/customer/1',
        twilio_approval: 'evidence/vendor/twilio-1', openai_approval: 'evidence/vendor/openai-1',
        hosting_approval: 'evidence/vendor/hosting-1', storage_controls: 'evidence/storage/1',
        retention_controls: 'evidence/retention/1', deletion_controls: 'evidence/deletion/1',
        deployment_security: 'evidence/security/1', recording_disabled: 'evidence/recording/1',
        pilot_acceptance: 'evidence/pilot/1',
      }, synthetic_caller_hashes: [], approved_by: 'admin-1',
      approved_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-07-20T19:00:00.000Z', revoked_at: null,
      readiness_ref: 'har_abc',
    }] });

    await expect(authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
    })).resolves.toMatchObject({ allowed: true, code: 'production_healthcare_approved' });
    expect(mocks.verifyEvidence).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-07-20T19:00:00.000Z',
    }));
    expect(mocks.verifyReadiness).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', agentId: 'agent-1', targetEnvironment: 'production',
      approvalExpiresAt: '2099-07-20T19:00:00.000Z', readinessRef: 'har_abc',
    }));
  });

  it('denies an otherwise complete production approval when registry evidence is invalidated', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'approval-prod', tenant_id: 'tenant-1', agent_id: 'agent-1', approval_kind: 'production_healthcare',
      core_version: '1.0.0', model: 'gpt-realtime-2', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', evidence_refs: Object.fromEntries([
        'compliance_owner_approval', 'customer_agreement', 'twilio_approval', 'openai_approval',
        'hosting_approval', 'storage_controls', 'retention_controls', 'deletion_controls',
        'deployment_security', 'recording_disabled', 'pilot_acceptance',
      ].map((key) => [key, `hce_${key}`])), synthetic_caller_hashes: [], approved_by: 'admin-1',
      approved_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-07-20T19:00:00.000Z', revoked_at: null,
      readiness_ref: 'har_abc',
    }] });
    mocks.verifyEvidence.mockResolvedValue({ valid: false, code: 'evidence_revoked' });

    await expect(authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
    })).resolves.toEqual({ allowed: false, code: 'production_evidence_incomplete' });
  });

  it('denies an otherwise valid production approval when readiness is revoked later', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'approval-prod', tenant_id: 'tenant-1', agent_id: 'agent-1', approval_kind: 'production_healthcare',
      core_version: '1.0.0', model: 'gpt-realtime-2', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', readiness_ref: 'har_abc',
      evidence_refs: Object.fromEntries([
        'compliance_owner_approval', 'customer_agreement', 'twilio_approval', 'openai_approval',
        'hosting_approval', 'storage_controls', 'retention_controls', 'deletion_controls',
        'deployment_security', 'recording_disabled', 'pilot_acceptance',
      ].map((key) => [key, `hce_${key}`])), synthetic_caller_hashes: [], approved_by: 'admin-1',
      approved_at: '2026-07-12T19:00:00.000Z', expires_at: '2099-07-20T19:00:00.000Z', revoked_at: null,
    }] });
    mocks.verifyReadiness.mockResolvedValue({ valid: false, code: 'readiness_revoked' });

    await expect(authorizeHealthcareDeployment({
      tenantId: 'tenant-1', agentId: 'agent-1', agentType: 'answering_service',
    })).resolves.toEqual({ allowed: false, code: 'production_readiness_incomplete' });
  });
});
