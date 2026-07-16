import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(process.cwd(), 'migrations/115_healthcare_control_evidence.sql');

describe('healthcare control evidence migration', () => {
  it('creates a tenant-and-agent-scoped metadata-only evidence registry', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS healthcare_control_evidence/i);
    expect(sql).toMatch(/tenant_id[\s\S]*REFERENCES tenants\(id\)/i);
    expect(sql).toMatch(/agent_id[\s\S]*REFERENCES agents\(id\)/i);
    expect(sql).toMatch(/evidence_ref[\s\S]*UNIQUE/i);
    expect(sql).toMatch(/artifact_sha256\s+CHAR\(64\)/i);
    expect(sql).toMatch(/artifact_locator\s+VARCHAR\(500\)/i);
    expect(sql).not.toMatch(/artifact_(content|body|payload)|BYTEA/i);
  });

  it('enforces exact control, environment, owner, status, digest, expiry, and two-person constraints', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    for (const key of [
      'compliance_owner_approval', 'customer_agreement', 'twilio_approval', 'openai_approval',
      'hosting_approval', 'storage_controls', 'retention_controls', 'deletion_controls',
      'deployment_security', 'recording_disabled', 'pilot_acceptance',
    ]) expect(sql).toContain(`'${key}'`);
    expect(sql).toMatch(/environment[\s\S]*CHECK[\s\S]*'staging'[\s\S]*'production'/i);
    expect(sql).toMatch(/owner_role[\s\S]*'compliance'[\s\S]*'infrastructure'[\s\S]*'product_safety'[\s\S]*'pilot_customer'/i);
    expect(sql).toMatch(/status[\s\S]*'pending'[\s\S]*'verified'[\s\S]*'revoked'/i);
    expect(sql).toMatch(/artifact_sha256\s*~\s*'\^\[a-f0-9\]\{64\}\$'/i);
    expect(sql).toMatch(/verified_by\s+IS NULL\s+OR\s+verified_by\s+<>\s+submitted_by/i);
    expect(sql).toMatch(/expires_at\s*>\s+submitted_at/i);
  });

  it('makes artifact identity immutable while allowing controlled verify and revoke transitions', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION prevent_healthcare_control_evidence_artifact_mutation/i);
    expect(sql).toMatch(/OLD\.artifact_sha256[\s\S]*NEW\.artifact_sha256/i);
    expect(sql).toMatch(/OLD\.artifact_locator[\s\S]*NEW\.artifact_locator/i);
    expect(sql).toMatch(/OLD\.control_key[\s\S]*NEW\.control_key/i);
    expect(sql).toMatch(/CREATE TRIGGER healthcare_control_evidence_artifact_immutable/i);
  });

  it('enables service-only RLS and indexes active scoped lookups', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/ALTER TABLE healthcare_control_evidence ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY healthcare_control_evidence_service_only/i);
    expect(sql).toMatch(/current_user IN \('service_role', 'postgres'\)/i);
    expect(sql).toMatch(/CREATE INDEX[\s\S]*tenant_id[\s\S]*agent_id[\s\S]*environment[\s\S]*control_key/i);
  });

  it('adds caller lookup key versioning for controlled rotation', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS caller_lookup_key_version VARCHAR\(32\)/i);
    expect(sql).toMatch(/caller_lookup_hash IS NULL[\s\S]*caller_lookup_key_version IS NULL/i);
    expect(sql).toMatch(/caller_lookup_hash IS NOT NULL[\s\S]*caller_lookup_key_version IS NOT NULL/i);
  });
});
