import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTHCARE_APPROVAL_EVIDENCE_KEYS } from '../../shared/compliance/healthcareDeploymentApproval';
import { HEALTHCARE_EVIDENCE_OWNER_ROLES } from '../../shared/compliance/healthcareControlEvidence';

const mocks = vi.hoisted(() => ({ query: vi.fn(), withPrivilegedClient: vi.fn() }));
vi.mock('../db', () => ({ withPrivilegedClient: mocks.withPrivilegedClient }));

import { verifyHealthcareControlEvidenceRefs } from './HealthcareControlEvidenceService';

const refs = Object.fromEntries(HEALTHCARE_APPROVAL_EVIDENCE_KEYS.map((key, index) => [key, `hce_${index}`]));

function rows() {
  return HEALTHCARE_APPROVAL_EVIDENCE_KEYS.map((controlKey, index) => ({
    id: `id-${index}`, evidence_ref: `hce_${index}`, control_key: controlKey,
    tenant_id: 'tenant-1', agent_id: 'agent-1', environment: 'production',
    artifact_sha256: 'a'.repeat(64), artifact_locator: `vault://artifact/${index}`,
    owner_role: HEALTHCARE_EVIDENCE_OWNER_ROLES[controlKey], status: 'verified', submitted_by: `submit-${index}`,
    verified_by: `verify-${index}`, verified_at: '2026-07-12T00:00:00.000Z',
    expires_at: '2099-09-01T00:00:00.000Z', revoked_at: null,
  }));
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: rows() });
  mocks.withPrivilegedClient.mockReset().mockImplementation(
    async (callback: (client: { query: typeof mocks.query }) => Promise<unknown>) => callback({ query: mocks.query }),
  );
});

describe('healthcare control evidence repository', () => {
  it('returns missing without opening a privileged connection when no references are supplied', async () => {
    await expect(verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z',
      evidenceRefs: {},
    })).resolves.toEqual({ valid: false, code: 'evidence_missing' });
    expect(mocks.withPrivilegedClient).not.toHaveBeenCalled();
  });

  it('loads only the referenced scoped metadata with a parameterized query', async () => {
    await expect(verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z',
      evidenceRefs: refs,
    })).resolves.toMatchObject({ valid: true, code: 'evidence_verified' });

    expect(mocks.withPrivilegedClient).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM healthcare_control_evidence[\s\S]*evidence_ref = ANY\(\$1::text\[\]\)/),
      [Object.values(refs)],
    );
    expect(JSON.stringify(await verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z',
      evidenceRefs: refs,
    }))).not.toContain('vault://');
  });

  it('fails closed when a referenced record is absent, revoked, expired, or malformed', async () => {
    mocks.query.mockResolvedValueOnce({ rows: rows().slice(1) });
    await expect(verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z', evidenceRefs: refs,
    })).resolves.toEqual({ valid: false, code: 'evidence_missing' });

    mocks.query.mockResolvedValueOnce({ rows: rows().map((row, index) => index === 0
      ? { ...row, status: 'revoked', revoked_at: '2026-07-13T00:00:00.000Z' }
      : row) });
    await expect(verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z', evidenceRefs: refs,
    })).resolves.toMatchObject({ valid: false, code: 'evidence_not_verified' });
  });

  it('maps staging, pending, revoked, and null workflow fields without exposing artifact locators', async () => {
    const variants: Array<Record<string, unknown>> = rows();
    variants[0] = { ...variants[0], environment: 'staging' };
    variants[1] = { ...variants[1], status: 'pending', verified_by: null, verified_at: null };
    variants[2] = { ...variants[2], status: 'revoked', revoked_at: '2026-07-13T00:00:00.000Z' };
    mocks.query.mockResolvedValueOnce({ rows: variants });
    const result = await verifyHealthcareControlEvidenceRefs({
      tenantId: 'tenant-1', agentId: 'agent-1', approvalExpiresAt: '2099-08-01T00:00:00.000Z',
      evidenceRefs: refs,
    });
    expect(result).toEqual({ valid: false, code: 'evidence_scope_mismatch' });
    expect(JSON.stringify(result)).not.toContain('vault://');
  });
});
