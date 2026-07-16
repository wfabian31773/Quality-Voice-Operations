import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/116_healthcare_activation_readiness.sql'),
  'utf8',
);

describe('healthcare activation readiness migration', () => {
  it('creates a scoped, identity-locked, all-pass readiness attestation', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS healthcare_activation_readiness/i);
    expect(migration).toMatch(/tenant_id[\s\S]*REFERENCES tenants\(id\)/i);
    expect(migration).toMatch(/agent_id[\s\S]*REFERENCES agents\(id\)/i);
    expect(migration).toMatch(/core_version[^\n]+CHECK[^\n]+'1\.0\.0'/i);
    expect(migration).toMatch(/model[^\n]+CHECK[^\n]+'gpt-realtime-2'/i);
    expect(migration).toMatch(/role_package_id[^\n]+CHECK[^\n]+'healthcare-receptionist'/i);
    expect(migration).toMatch(/recording_policy[^\n]+CHECK[^\n]+'disabled'/i);
    for (const column of [
      'migration_status', 'schema_status', 'database_status', 'keyring_status',
      'evidence_status', 'caller_hash_status', 'retention_status', 'deletion_status',
    ]) expect(migration).toMatch(new RegExp(`${column}[^\\n]+CHECK[^\\n]+'pass'`, 'i'));
  });

  it('requires reconciled counts, zero caller gaps, valid digests, and two-person verification', () => {
    expect(migration).toMatch(/catalog_count\s*=\s*discovered_count/i);
    expect(migration).toMatch(/tenant_table_count\s*=\s*rls_enabled_count/i);
    expect(migration).toMatch(/verified_control_count\s*=\s*11/i);
    expect(migration).toMatch(/caller_missing_count\s*=\s*0/i);
    expect(migration).toMatch(/caller_stale_count\s*=\s*0/i);
    expect(migration).toMatch(/preflight_sha256[\s\S]*\^\[a-f0-9\]\{64\}\$/i);
    expect(migration).toMatch(/verified_by\s+IS NULL\s+OR\s+verified_by\s+<>\s+submitted_by/i);
  });

  it('makes proof identity immutable, enables service-only RLS, and binds production approvals', () => {
    expect(migration).toMatch(/prevent_healthcare_activation_readiness_identity_mutation/i);
    expect(migration).toMatch(/CREATE TRIGGER healthcare_activation_readiness_identity_immutable/i);
    expect(migration).toMatch(/ALTER TABLE healthcare_activation_readiness ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/current_user IN \('service_role', 'postgres'\)/i);
    expect(migration).toMatch(/healthcare_deployment_approvals[\s\S]*ADD COLUMN IF NOT EXISTS readiness_ref/i);
    expect(migration).toMatch(/production_healthcare[\s\S]*readiness_ref IS NOT NULL/i);
    expect(migration).toMatch(/enforce_healthcare_deployment_readiness/i);
    expect(migration).toMatch(/target_environment = 'production'[\s\S]*status = 'verified'[\s\S]*expires_at >= NEW\.expires_at/i);
    expect(migration).toMatch(/tenant_id = NEW\.tenant_id[\s\S]*agent_id = NEW\.agent_id/i);
  });

  it('allows only pending-to-verified/revoked and verified-to-revoked workflow transitions', () => {
    expect(migration).toMatch(/OLD\.status = 'pending'[\s\S]*NEW\.status IN \('verified', 'revoked'\)/i);
    expect(migration).toMatch(/OLD\.status = 'verified'[\s\S]*NEW\.status = 'revoked'/i);
    expect(migration).toMatch(/invalid healthcare activation readiness workflow transition/i);
  });

  it('enforces the accountable owner role for each control at the database boundary', () => {
    expect(migration).toMatch(/healthcare_control_evidence_owner_role_match/i);
    expect(migration).toMatch(/openai_approval[\s\S]*owner_role = 'infrastructure'/i);
    expect(migration).toMatch(/recording_disabled[\s\S]*owner_role = 'product_safety'/i);
    expect(migration).toMatch(/pilot_acceptance[\s\S]*owner_role = 'pilot_customer'/i);
  });
});
