import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/114_healthcare_deployment_approvals.sql'),
  'utf8',
);

describe('healthcare deployment approval migration', () => {
  it('locks runtime identity, recording-disabled state, scope, expiry, and revocation evidence', () => {
    expect(migration).toMatch(/healthcare_deployment_approvals/i);
    expect(migration).toMatch(/core_version[^\n]+CHECK[^\n]+'1\.0\.0'/i);
    expect(migration).toMatch(/model[^\n]+CHECK[^\n]+'gpt-realtime-2'/i);
    expect(migration).toMatch(/role_package_id[^\n]+CHECK[^\n]+'healthcare-receptionist'/i);
    expect(migration).toMatch(/role_package_version[^\n]+CHECK[^\n]+'1\.0\.0'/i);
    expect(migration).toMatch(/recording_policy[^\n]+CHECK[^\n]+'disabled'/i);
    expect(migration).toMatch(/synthetic_test[^\n]+production_healthcare/i);
    expect(migration).toMatch(/expires_at/i);
    expect(migration).toMatch(/revoked_at/i);
  });

  it('enables RLS and prevents multiple active approvals for one tenant/agent', () => {
    expect(migration).toMatch(/ALTER TABLE healthcare_deployment_approvals ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/UNIQUE INDEX[\s\S]+tenant_id, agent_id[\s\S]+WHERE revoked_at IS NULL/i);
  });

  it('adds deterministic caller lookup without storing plaintext caller identity', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS caller_lookup_hash CHAR\(64\)/i);
    expect(migration).toMatch(/caller_lookup_hash[^;]+INDEX|INDEX[^;]+caller_lookup_hash/i);
  });

  it('preserves a redacted deletion evidence record after tenant and requesting-user deletion', () => {
    expect(migration).toMatch(/tenant_deletion_requests[\s\S]+tenant_fingerprint/i);
    expect(migration).toMatch(/tenant_deletion_requests_tenant_id_fkey[\s\S]+ON DELETE SET NULL/i);
    expect(migration).toMatch(/tenant_deletion_requests_requested_by_fkey[\s\S]+ON DELETE SET NULL/i);
    expect(migration).toMatch(/first_party_verification[\s\S]+external_deletion_evidence/i);
  });
});
