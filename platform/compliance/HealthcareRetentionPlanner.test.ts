import { describe, expect, it, vi } from 'vitest';
import { HEALTHCARE_RETENTION_SCOPES, type HealthcareRetentionPolicy } from '../../shared/compliance/healthcareRetentionPolicy';
import type { HealthcareControlEvidenceRecord } from '../../shared/compliance/healthcareControlEvidence';
import { buildHealthcareRetentionDryRun } from './HealthcareRetentionPlanner';

const policy: HealthcareRetentionPolicy = {
  policyId: 'pilot', version: '1.0.0', tenantId: 't1', agentId: 'a1', environment: 'production',
  effectiveAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
  evidenceRef: 'hce_retention', legalHoldMode: 'block_all_deletion',
  rules: Object.fromEntries(HEALTHCARE_RETENTION_SCOPES.map((scope) => [scope, { retentionDays: 30 }])) as HealthcareRetentionPolicy['rules'],
};
const evidence: HealthcareControlEvidenceRecord = {
  id: 'e1', evidenceRef: 'hce_retention', controlKey: 'retention_controls', tenantId: 't1', agentId: 'a1',
  environment: 'production', artifactSha256: 'a'.repeat(64), artifactLocator: '', ownerRole: 'compliance',
  status: 'verified', submittedBy: 'u1', verifiedBy: 'u2', verifiedAt: '2026-07-02T00:00:00.000Z',
  expiresAt: '2026-11-01T00:00:00.000Z', revokedAt: null,
};

describe('healthcare retention dry-run planner', () => {
  it('returns count-only evidence and never issues a destructive statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ candidate_count: 2 }] });
    const result = await buildHealthcareRetentionDryRun(
      { query }, { policy, evidence, now: new Date('2026-07-12T20:00:00.000Z') },
    );
    expect(result.mode).toBe('dry-run');
    expect(result.executionAuthorized).toBe(false);
    expect(result.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.counts.call_sessions).toBe(2);
    expect(result.counts.backups).toBeNull();
    expect(result.counts.external_processors).toBeNull();
    expect(result.externalEvidenceRequired).toEqual(['backups', 'external_processors']);
    expect(JSON.stringify(result)).not.toMatch(/artifactLocator|vault:\/\/|retentionDays/);
    for (const [sql, values] of query.mock.calls) {
      expect(String(sql)).toMatch(/^SELECT COUNT\(\*\)::int AS candidate_count/);
      expect(String(sql)).not.toMatch(/DELETE|UPDATE|TRUNCATE/i);
      expect(values[0]).toBe('t1');
      expect(values[1]).toBeInstanceOf(Date);
    }
  });

  it('refuses even a dry run when owner evidence is invalid', async () => {
    const query = vi.fn();
    await expect(buildHealthcareRetentionDryRun(
      { query }, { policy, evidence: { ...evidence, status: 'pending' }, now: new Date('2026-07-12T20:00:00.000Z') },
    )).rejects.toThrow('verified owner evidence');
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the current clock and treats absent count rows as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await buildHealthcareRetentionDryRun({ query }, { policy, evidence });
    expect(result.counts.call_sessions).toBe(0);
  });
});
