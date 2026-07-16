-- GTM-012: authenticated healthcare control evidence and caller-HMAC rotation metadata.
-- Stores artifact metadata and a digest only. Artifact contents and secrets remain
-- in the approved external evidence system referenced by artifact_locator.

CREATE TABLE IF NOT EXISTS healthcare_control_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_ref VARCHAR(40) NOT NULL UNIQUE
    DEFAULT ('hce_' || replace(gen_random_uuid()::text, '-', '')),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  environment VARCHAR(20) NOT NULL
    CHECK (environment IN ('staging', 'production')),
  control_key VARCHAR(64) NOT NULL CHECK (control_key IN (
    'compliance_owner_approval',
    'customer_agreement',
    'twilio_approval',
    'openai_approval',
    'hosting_approval',
    'storage_controls',
    'retention_controls',
    'deletion_controls',
    'deployment_security',
    'recording_disabled',
    'pilot_acceptance'
  )),
  artifact_locator VARCHAR(500) NOT NULL,
  artifact_sha256 CHAR(64) NOT NULL
    CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  owner_role VARCHAR(32) NOT NULL CHECK (owner_role IN (
    'compliance', 'infrastructure', 'product_safety', 'pilot_customer'
  )),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  submitted_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ,
  revoked_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason VARCHAR(500),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > submitted_at),
  CHECK (verified_by IS NULL OR verified_by <> submitted_by),
  CHECK (
    (status = 'pending' AND verified_by IS NULL AND verified_at IS NULL AND revoked_at IS NULL)
    OR (status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_healthcare_control_evidence_scope
  ON healthcare_control_evidence(tenant_id, agent_id, environment, control_key)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_healthcare_control_evidence_expiry
  ON healthcare_control_evidence(expires_at)
  WHERE status = 'verified' AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_healthcare_control_evidence_artifact_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.evidence_ref IS DISTINCT FROM NEW.evidence_ref
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
     OR OLD.environment IS DISTINCT FROM NEW.environment
     OR OLD.control_key IS DISTINCT FROM NEW.control_key
     OR OLD.artifact_locator IS DISTINCT FROM NEW.artifact_locator
     OR OLD.artifact_sha256 IS DISTINCT FROM NEW.artifact_sha256
     OR OLD.owner_role IS DISTINCT FROM NEW.owner_role
     OR OLD.submitted_by IS DISTINCT FROM NEW.submitted_by
     OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'healthcare control evidence artifact identity is immutable';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS healthcare_control_evidence_artifact_immutable
  ON healthcare_control_evidence;
CREATE TRIGGER healthcare_control_evidence_artifact_immutable
  BEFORE UPDATE ON healthcare_control_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_healthcare_control_evidence_artifact_mutation();

ALTER TABLE healthcare_control_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS healthcare_control_evidence_service_only
  ON healthcare_control_evidence;
CREATE POLICY healthcare_control_evidence_service_only
  ON healthcare_control_evidence
  FOR ALL
  USING (current_user IN ('service_role', 'postgres'))
  WITH CHECK (current_user IN ('service_role', 'postgres'));

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS caller_lookup_key_version VARCHAR(32);

ALTER TABLE call_sessions
  DROP CONSTRAINT IF EXISTS call_sessions_lookup_hash_version_pair;
ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_lookup_hash_version_pair CHECK (
    (caller_lookup_hash IS NULL AND caller_lookup_key_version IS NULL)
    OR (caller_lookup_hash IS NOT NULL AND caller_lookup_key_version IS NOT NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_call_sessions_lookup_key_version
  ON call_sessions(tenant_id, caller_lookup_key_version, start_time DESC)
  WHERE caller_lookup_hash IS NOT NULL;
