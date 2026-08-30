import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  calculateHealthcareReadinessPreflightSha256,
  type HealthcareReadinessPreflightDigestInput,
} from '../../../platform/compliance/HealthcareDataControlPreflight';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  queryMock: vi.fn(),
  runAllIsolationTestsMock: vi.fn(),
  getSchedulerStatusMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  verifyEvidenceMock: vi.fn(),
  verifyReadinessMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  withPrivilegedClient: async (cb: (c: unknown) => Promise<unknown>) => cb({ query: a.queryMock }),
}));
vi.mock('../../../platform/security/TenantIsolationService', () => ({ runAllIsolationTests: a.runAllIsolationTestsMock }));
vi.mock('../../../platform/security/EncryptionService', () => ({ getOrCreateTenantDEK: vi.fn() }));
vi.mock('../../../platform/security/TenantIsolationScheduler', () => ({ getTenantIsolationSchedulerStatus: a.getSchedulerStatusMock }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../../../platform/email/templates', () => ({ encryptionInitializationReminderEmail: () => ({ subject: 's', html: 'h', text: 't' }) }));
vi.mock('../../../platform/compliance/HealthcareControlEvidenceService', () => ({
  verifyHealthcareControlEvidenceRefs: a.verifyEvidenceMock,
}));
vi.mock('../../../platform/compliance/HealthcareActivationReadinessService', () => ({
  verifyHealthcareActivationReadinessRef: a.verifyReadinessMock,
}));

import router from './platformCompliance';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [{}] });
  a.runAllIsolationTestsMock.mockReset().mockResolvedValue({ passed: 5, failed: 0, results: [] });
  a.getSchedulerStatusMock.mockReset().mockReturnValue({ running: true });
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.verifyEvidenceMock.mockReset().mockResolvedValue({ valid: true, code: 'evidence_verified', recordIds: ['e1'] });
  a.verifyReadinessMock.mockReset().mockResolvedValue({ valid: true, code: 'readiness_verified', readinessId: 'r1' });
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
});

describe('platform-admin gate', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/compliance/overview')).status).toBe(403);
  });
});

describe('GET read routes', () => {
  it('overview aggregates compliance stats', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { rows: [{ total_tenants: 3, active_tenants: 2, suspended_tenants: 1 }] };
      return { rows: [{}] };
    });
    const res = await request(app()).get('/platform/compliance/overview');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenants');
    expect(res.body).toHaveProperty('encryption');
    expect(res.body).toHaveProperty('isolationTests');
  });
  it('overview 500 on query failure', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/compliance/overview')).status).toBe(500);
  });
  it('audit-log list', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: '0' }] } : { rows: [] },
    );
    expect((await request(app()).get('/platform/compliance/audit-log')).status).toBe(200);
  });
  it('encryption status', async () => {
    expect((await request(app()).get('/platform/compliance/encryption')).status).toBe(200);
  });
  it('deletion-requests', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/platform/compliance/deletion-requests')).status).toBe(200);
  });
  it('keeps completed deletion evidence visible after the tenant row is removed', async () => {
    a.queryMock.mockResolvedValue({ rows: [{
      id: 'delete-1', tenant_id: null, tenant_name: null, status: 'completed',
      tenant_fingerprint: 'fingerprint-1', first_party_verification: { verified: true },
      external_deletion_evidence: { twilio: 'evidence/vendor/twilio-delete-1' },
      completed_at: '2026-07-12T20:00:00.000Z',
    }] });

    const res = await request(app()).get('/platform/compliance/deletion-requests?status=completed');

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(a.queryMock).toHaveBeenCalledWith(
      expect.stringMatching(/FROM tenant_deletion_requests d\s+LEFT JOIN tenants t/),
      ['completed'],
    );
    expect(String(a.queryMock.mock.calls[0]?.[0])).toMatch(
      /tenant_fingerprint[\s\S]*first_party_verification[\s\S]*external_deletion_evidence[\s\S]*completed_at/,
    );
  });
  it('isolation-tests', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/platform/compliance/isolation-tests')).status).toBe(200);
  });
  it('platform-admins', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 'u1', email: 'a@x.com' }] });
    expect((await request(app()).get('/platform/compliance/platform-admins')).status).toBe(200);
  });
  it('encrypted-fields', async () => {
    expect((await request(app()).get('/platform/compliance/encrypted-fields')).status).toBe(200);
  });
});

describe('POST /platform/compliance/isolation-tests/run', () => {
  it('runs the isolation suite', async () => {
    const res = await request(app()).post('/platform/compliance/isolation-tests/run').send({});
    expect(res.status).toBe(200);
    expect(a.runAllIsolationTestsMock).toHaveBeenCalled();
  });
});

const productionEvidence = {
  compliance_owner_approval: 'evidence/compliance/owner-1',
  customer_agreement: 'evidence/customer/baa-1',
  twilio_approval: 'evidence/vendor/twilio-1',
  openai_approval: 'evidence/vendor/openai-1',
  hosting_approval: 'evidence/vendor/hosting-1',
  storage_controls: 'evidence/security/storage-1',
  retention_controls: 'evidence/security/retention-1',
  deletion_controls: 'evidence/security/deletion-1',
  deployment_security: 'evidence/security/deployment-1',
  recording_disabled: 'evidence/recording/disabled-1',
  pilot_acceptance: 'evidence/customer/acceptance-1',
};

const validApprovalExpiry = () => new Date(Date.now() + 20 * 86_400_000).toISOString();

describe('healthcare deployment approvals', () => {
  it('rejects tenant roles and requires platform-admin authorization', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/compliance/healthcare-approvals')).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-approvals').send({})).status).toBe(403);
  });

  it('rejects incomplete production evidence without writing an approval', async () => {
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'production_healthcare',
      expiresAt: validApprovalExpiry(), evidenceRefs: { compliance_owner_approval: 'evidence/owner/1' }, readinessRef: 'har_abc',
    });
    expect(res.status).toBe(400);
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO healthcare_deployment_approvals'))).toBe(false);
  });

  it('creates an exact locked production approval and audits it without accepting runtime versions from the client', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', tenant_id: 't1', type: 'answering_service' }] };
      if (sql.includes('INSERT INTO healthcare_deployment_approvals')) return { rows: [{
        id: 'approval-1', tenant_id: 't1', agent_id: 'a1', approval_kind: 'production_healthcare',
        core_version: '2.0.0', model: 'grok-voice-think-fast-2.0', role_package_id: 'healthcare-receptionist',
        role_package_version: '1.0.0', recording_policy: 'disabled', approved_by: 'u1',
        approved_at: '2026-07-12T19:00:00.000Z', expires_at: validApprovalExpiry(), revoked_at: null, readiness_ref: 'har_abc',
      }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'production_healthcare',
      expiresAt: validApprovalExpiry(), evidenceRefs: productionEvidence, readinessRef: 'har_abc',
    });
    expect(res.status).toBe(201);
    expect(res.body.approval).toMatchObject({
      id: 'approval-1', coreVersion: '2.0.0', model: 'grok-voice-think-fast-2.0',
      rolePackageId: 'healthcare-receptionist', rolePackageVersion: '1.0.0', recordingPolicy: 'disabled',
      readinessRef: 'har_abc',
    });
    expect(JSON.stringify(res.body)).not.toContain('syntheticCallerHashes');
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.approval_created' }));
    expect(a.verifyEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1', evidenceRefs: productionEvidence,
    }));
    expect(a.verifyReadinessMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1', readinessRef: 'har_abc', targetEnvironment: 'production',
    }));
  });

  it('rejects well-formed production references that are not authenticated by the evidence registry', async () => {
    a.verifyEvidenceMock.mockResolvedValue({ valid: false, code: 'evidence_missing' });
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'production_healthcare',
      expiresAt: validApprovalExpiry(), evidenceRefs: productionEvidence, readinessRef: 'har_abc',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Production healthcare evidence is not verified' });
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO healthcare_deployment_approvals'))).toBe(false);
  });

  it('rejects a production approval when the readiness attestation is missing or revoked', async () => {
    a.verifyReadinessMock.mockResolvedValue({ valid: false, code: 'readiness_revoked' });
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'production_healthcare',
      expiresAt: validApprovalExpiry(), evidenceRefs: productionEvidence, readinessRef: 'har_abc',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Production healthcare readiness is not verified' });
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO healthcare_deployment_approvals'))).toBe(false);
  });

  it('rejects client attempts to supply locked runtime identity fields', async () => {
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'production_healthcare',
      expiresAt: validApprovalExpiry(), evidenceRefs: productionEvidence, readinessRef: 'har_abc',
      coreVersion: 'attacker-controlled',
    });
    expect(res.status).toBe(400);
  });

  it('hashes synthetic caller numbers and never stores or returns them in plaintext', async () => {
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', tenant_id: 't1', type: 'answering_service' }] };
      if (sql.includes('INSERT INTO healthcare_deployment_approvals')) {
        expect(JSON.stringify(values)).not.toContain('5551234567');
        expect(JSON.stringify(values)).toMatch(/[a-f0-9]{64}/);
        return { rows: [{ id: 'approval-s1', tenant_id: 't1', agent_id: 'a1', approval_kind: 'synthetic_test', core_version: '2.0.0', model: 'grok-voice-think-fast-2.0', role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0', recording_policy: 'disabled', approved_by: 'u1', approved_at: '2026-07-12T19:00:00.000Z', expires_at: validApprovalExpiry(), revoked_at: null }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).post('/platform/compliance/healthcare-approvals').send({
      tenantId: 't1', agentId: 'a1', approvalKind: 'synthetic_test', expiresAt: validApprovalExpiry(),
      evidenceRefs: { test_authorization: 'evidence/test/auth-1', synthetic_data_protocol: 'evidence/test/synthetic-1', recording_disabled: 'evidence/test/recording-1' },
      syntheticCallerNumbers: ['+15551234567'],
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('5551234567');
    expect(res.body.approval.syntheticCallerCount).toBe(1);
  });

  it('lists redacted approvals and revokes by id with a bounded reason', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 'approval-1', tenant_id: 't1', agent_id: 'a1', approval_kind: 'synthetic_test', core_version: '2.0.0', model: 'grok-voice-think-fast-2.0', role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0', recording_policy: 'disabled', approved_by: 'u1', approved_at: '2026-07-12T19:00:00.000Z', expires_at: validApprovalExpiry(), revoked_at: null, synthetic_caller_count: 1 }] });
    const list = await request(app()).get('/platform/compliance/healthcare-approvals');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('synthetic_caller_hashes');

    const revoke = await request(app()).post('/platform/compliance/healthcare-approvals/approval-1/revoke').send({ reason: 'Customer pilot authorization withdrawn' });
    expect(revoke.status).toBe(200);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.approval_revoked' }));
  });
});

const validEvidenceExpiry = () => new Date(Date.now() + 120 * 86_400_000).toISOString();
const evidenceSubmission = {
  tenantId: 't1',
  agentId: 'a1',
  environment: 'production',
  controlKey: 'openai_approval',
  artifactLocator: 'vault://qvo/openai/baa-2026',
  artifactSha256: 'a'.repeat(64),
  ownerRole: 'infrastructure',
};

describe('healthcare control evidence registry', () => {
  it('requires platform-admin authorization for list, submit, verify, and revoke', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/compliance/healthcare-evidence')).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-evidence').send({})).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-evidence/e1/verify').send({})).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-evidence/e1/revoke').send({ reason: 'withdrawn' })).status).toBe(403);
  });

  it('submits metadata-only pending evidence and rejects client-controlled workflow state', async () => {
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', tenant_id: 't1' }] };
      if (sql.includes('INSERT INTO healthcare_control_evidence')) {
        expect(JSON.stringify(values)).not.toContain('artifact contents');
        return { rows: [{
          id: 'e1', evidence_ref: 'hce_abc', tenant_id: 't1', agent_id: 'a1',
          environment: 'production', control_key: 'openai_approval', artifact_sha256: 'a'.repeat(64),
          owner_role: 'infrastructure', status: 'pending', submitted_by: 'u1', submitted_at: new Date().toISOString(),
          verified_by: null, verified_at: null, expires_at: validEvidenceExpiry(), revoked_at: null,
        }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).post('/platform/compliance/healthcare-evidence').send({
      ...evidenceSubmission, expiresAt: validEvidenceExpiry(),
    });
    expect(res.status).toBe(201);
    expect(res.body.evidence).toMatchObject({ evidenceRef: 'hce_abc', status: 'pending' });
    expect(JSON.stringify(res.body)).not.toContain('artifactLocator');
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.evidence_submitted' }));

    const forged = await request(app()).post('/platform/compliance/healthcare-evidence').send({
      ...evidenceSubmission, expiresAt: validEvidenceExpiry(), status: 'verified', verifiedBy: 'u1',
    });
    expect(forged.status).toBe(400);

    const secretBearingLocator = await request(app()).post('/platform/compliance/healthcare-evidence').send({
      ...evidenceSubmission,
      artifactLocator: 'https://evidence.example/control?token=must-not-enter-the-registry',
      expiresAt: validEvidenceExpiry(),
    });
    expect(secretBearingLocator.status).toBe(400);
  });

  it('rejects an owner role that does not match the accountable control owner', async () => {
    const res = await request(app()).post('/platform/compliance/healthcare-evidence').send({
      ...evidenceSubmission, ownerRole: 'compliance', expiresAt: validEvidenceExpiry(),
    });
    expect(res.status).toBe(400);
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO healthcare_control_evidence'))).toBe(false);
  });

  it('requires an independent verifier and supports audited revocation', async () => {
    a.queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'e1', evidence_ref: 'hce_abc', tenant_id: 't1', agent_id: 'a1', environment: 'production',
        control_key: 'openai_approval', artifact_sha256: 'a'.repeat(64), owner_role: 'compliance',
        status: 'verified', submitted_by: 'u2', verified_by: 'u1', verified_at: new Date().toISOString(),
        expires_at: validEvidenceExpiry(), revoked_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'e1', evidence_ref: 'hce_abc', tenant_id: 't1', agent_id: 'a1', environment: 'production',
        control_key: 'openai_approval', artifact_sha256: 'a'.repeat(64), owner_role: 'compliance',
        status: 'revoked', submitted_by: 'u2', verified_by: 'u1', verified_at: new Date().toISOString(),
        expires_at: validEvidenceExpiry(), revoked_at: new Date().toISOString(),
      }] });

    const selfVerify = await request(app()).post('/platform/compliance/healthcare-evidence/e1/verify').send({});
    expect(selfVerify.status).toBe(409);
    expect(String(a.queryMock.mock.calls[0]?.[0])).toMatch(/submitted_by <> \$2/);

    const verified = await request(app()).post('/platform/compliance/healthcare-evidence/e1/verify').send({});
    expect(verified.status).toBe(200);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.evidence_verified' }));

    const revoked = await request(app()).post('/platform/compliance/healthcare-evidence/e1/revoke').send({ reason: 'Vendor terms changed' });
    expect(revoked.status).toBe(200);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.evidence_revoked' }));
  });

  it('lists metadata without artifact locators or content', async () => {
    a.queryMock.mockResolvedValue({ rows: [{
      id: 'e1', evidence_ref: 'hce_abc', tenant_id: 't1', agent_id: 'a1', environment: 'production',
      control_key: 'openai_approval', artifact_sha256: 'a'.repeat(64), owner_role: 'compliance',
      status: 'verified', submitted_by: 'u2', verified_by: 'u1', verified_at: new Date().toISOString(),
      expires_at: validEvidenceExpiry(), revoked_at: null,
    }] });
    const res = await request(app()).get('/platform/compliance/healthcare-evidence?tenantId=t1&agentId=a1');
    expect(res.status).toBe(200);
    expect(res.body.evidence).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/artifact_locator|artifactLocator|vault:\/\//);
  });
});

const readinessPayload = () => {
  const preflight: HealthcareReadinessPreflightDigestInput & { preflightSha256: string } = {
    overallStatus: 'pass',
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
    preflightSha256: '',
    evidenceSnapshotSha256: 'b'.repeat(64),
    retentionPlanSha256: 'c'.repeat(64),
    deletionEvidenceSha256: 'd'.repeat(64),
  };
  preflight.preflightSha256 = calculateHealthcareReadinessPreflightSha256(preflight);
  return {
    tenantId: 't1',
    agentId: 'a1',
    targetEnvironment: 'production',
    expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    preflight,
  };
};

describe('healthcare activation readiness registry', () => {
  it('requires platform-admin authorization for list, submit, verify, and revoke', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/compliance/healthcare-readiness')).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-readiness').send(readinessPayload())).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-readiness/r1/verify').send({})).status).toBe(403);
    expect((await request(app()).post('/platform/compliance/healthcare-readiness/r1/revoke').send({ reason: 'withdrawn' })).status).toBe(403);
  });

  it('submits only an exact all-pass immutable readiness payload', async () => {
    a.queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM agents')) return { rows: [{ id: 'a1', tenant_id: 't1', type: 'answering_service' }] };
      if (sql.includes('INSERT INTO healthcare_activation_readiness')) {
        expect(values).toContain('3.0.0');
        return { rows: [{
          id: 'r1', readiness_ref: 'har_abc', tenant_id: 't1', agent_id: 'a1',
          target_environment: 'production', core_version: '2.0.0', model: 'grok-voice-think-fast-2.0',
          role_package_id: 'healthcare-receptionist', role_package_version: '1.0.0', recording_policy: 'disabled',
          catalog_version: '3.0.0', catalog_count: 188, discovered_count: 188,
          tenant_table_count: 188, rls_enabled_count: 188, verified_control_count: 11,
          caller_missing_count: 0, caller_stale_count: 0, status: 'pending', submitted_by: 'u1',
          submitted_at: new Date().toISOString(), verified_by: null, verified_at: null,
          expires_at: readinessPayload().expiresAt, revoked_at: null,
        }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).post('/platform/compliance/healthcare-readiness').send(readinessPayload());
    expect(res.status).toBe(201);
    expect(res.body.readiness).toMatchObject({ readinessRef: 'har_abc', status: 'pending', catalogVersion: '3.0.0' });
    expect(JSON.stringify(res.body)).not.toMatch(/preflightSha256|evidenceSnapshotSha256|[a-f0-9]{64}/);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.readiness_submitted' }));

    const drifted = readinessPayload();
    drifted.preflight.rlsEnabledCount = 187;
    expect((await request(app()).post('/platform/compliance/healthcare-readiness').send(drifted)).status).toBe(400);

    const digestMismatch = readinessPayload();
    digestMismatch.preflight.preflightSha256 = 'f'.repeat(64);
    const mismatch = await request(app()).post('/platform/compliance/healthcare-readiness').send(digestMismatch);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: 'Healthcare readiness preflight digest does not match payload' });
  });

  it('requires independent verification and supports audited revocation', async () => {
    const base = {
      id: 'r1', readiness_ref: 'har_abc', tenant_id: 't1', agent_id: 'a1', target_environment: 'production',
      core_version: '2.0.0', model: 'grok-voice-think-fast-2.0', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', catalog_version: '3.0.0',
      catalog_count: 188, discovered_count: 188, tenant_table_count: 188, rls_enabled_count: 188,
      verified_control_count: 11, caller_missing_count: 0, caller_stale_count: 0,
      submitted_by: 'u2', submitted_at: new Date().toISOString(), expires_at: readinessPayload().expiresAt,
    };
    a.queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...base, status: 'verified', verified_by: 'u1', verified_at: new Date().toISOString(), revoked_at: null }] })
      .mockResolvedValueOnce({ rows: [{ ...base, status: 'revoked', verified_by: 'u1', verified_at: new Date().toISOString(), revoked_at: new Date().toISOString() }] });

    expect((await request(app()).post('/platform/compliance/healthcare-readiness/r1/verify').send({})).status).toBe(409);
    expect(String(a.queryMock.mock.calls[0]?.[0])).toMatch(/submitted_by <> \$2/);
    expect((await request(app()).post('/platform/compliance/healthcare-readiness/r1/verify').send({})).status).toBe(200);
    expect((await request(app()).post('/platform/compliance/healthcare-readiness/r1/revoke').send({ reason: 'Rehearsal evidence withdrawn' })).status).toBe(200);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'healthcare.readiness_revoked' }));
  });

  it('lists bounded metadata without proof digests', async () => {
    a.queryMock.mockResolvedValue({ rows: [{
      id: 'r1', readiness_ref: 'har_abc', tenant_id: 't1', agent_id: 'a1', target_environment: 'production',
      core_version: '2.0.0', model: 'grok-voice-think-fast-2.0', role_package_id: 'healthcare-receptionist',
      role_package_version: '1.0.0', recording_policy: 'disabled', catalog_version: '3.0.0',
      catalog_count: 188, discovered_count: 188, tenant_table_count: 188, rls_enabled_count: 188,
      verified_control_count: 11, caller_missing_count: 0, caller_stale_count: 0,
      status: 'verified', submitted_by: 'u2', submitted_at: new Date().toISOString(),
      verified_by: 'u1', verified_at: new Date().toISOString(), expires_at: readinessPayload().expiresAt, revoked_at: null,
    }] });
    const res = await request(app()).get('/platform/compliance/healthcare-readiness?tenantId=t1&agentId=a1');
    expect(res.status).toBe(200);
    expect(res.body.readiness).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/sha256|[a-f0-9]{64}/);
  });
});
