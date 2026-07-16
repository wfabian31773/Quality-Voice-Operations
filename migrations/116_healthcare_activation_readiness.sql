-- GTM-013: immutable production-equivalent rehearsal attestation and approval binding.

CREATE TABLE IF NOT EXISTS healthcare_activation_readiness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  readiness_ref VARCHAR(40) NOT NULL UNIQUE
    DEFAULT ('har_' || replace(gen_random_uuid()::text, '-', '')),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_environment VARCHAR(32) NOT NULL
    CHECK (target_environment IN ('production_equivalent', 'production')),
  core_version VARCHAR(20) NOT NULL DEFAULT '1.0.0' CHECK (core_version = '1.0.0'),
  model VARCHAR(100) NOT NULL DEFAULT 'gpt-realtime-2' CHECK (model = 'gpt-realtime-2'),
  role_package_id VARCHAR(100) NOT NULL DEFAULT 'healthcare-receptionist' CHECK (role_package_id = 'healthcare-receptionist'),
  role_package_version VARCHAR(20) NOT NULL DEFAULT '1.0.0' CHECK (role_package_version = '1.0.0'),
  recording_policy VARCHAR(20) NOT NULL DEFAULT 'disabled' CHECK (recording_policy = 'disabled'),
  catalog_version VARCHAR(20) NOT NULL CHECK (catalog_version = '3.0.0'),
  catalog_count INTEGER NOT NULL CHECK (catalog_count = 188),
  discovered_count INTEGER NOT NULL,
  tenant_table_count INTEGER NOT NULL,
  rls_enabled_count INTEGER NOT NULL,
  verified_control_count INTEGER NOT NULL CHECK (verified_control_count = 11),
  caller_missing_count INTEGER NOT NULL CHECK (caller_missing_count = 0),
  caller_stale_count INTEGER NOT NULL CHECK (caller_stale_count = 0),
  migration_status VARCHAR(20) NOT NULL CHECK (migration_status = 'pass'),
  schema_status VARCHAR(20) NOT NULL CHECK (schema_status = 'pass'),
  database_status VARCHAR(20) NOT NULL CHECK (database_status = 'pass'),
  keyring_status VARCHAR(20) NOT NULL CHECK (keyring_status = 'pass'),
  evidence_status VARCHAR(20) NOT NULL CHECK (evidence_status = 'pass'),
  caller_hash_status VARCHAR(20) NOT NULL CHECK (caller_hash_status = 'pass'),
  retention_status VARCHAR(20) NOT NULL CHECK (retention_status = 'pass'),
  deletion_status VARCHAR(20) NOT NULL CHECK (deletion_status = 'pass'),
  preflight_sha256 CHAR(64) NOT NULL CHECK (preflight_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_snapshot_sha256 CHAR(64) NOT NULL CHECK (evidence_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  retention_plan_sha256 CHAR(64) NOT NULL CHECK (retention_plan_sha256 ~ '^[a-f0-9]{64}$'),
  deletion_evidence_sha256 CHAR(64) NOT NULL CHECK (deletion_evidence_sha256 ~ '^[a-f0-9]{64}$'),
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
  CHECK (catalog_count = discovered_count),
  CHECK (tenant_table_count = catalog_count),
  CHECK (tenant_table_count = rls_enabled_count),
  CHECK (expires_at > submitted_at AND expires_at <= submitted_at + INTERVAL '90 days'),
  CHECK (verified_by IS NULL OR verified_by <> submitted_by),
  CHECK (
    (status = 'pending' AND verified_by IS NULL AND verified_at IS NULL AND revoked_at IS NULL)
    OR (status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_healthcare_activation_readiness_scope
  ON healthcare_activation_readiness(tenant_id, agent_id, target_environment, expires_at)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_healthcare_activation_readiness_identity_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.readiness_ref IS DISTINCT FROM NEW.readiness_ref
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.agent_id IS DISTINCT FROM NEW.agent_id
     OR OLD.target_environment IS DISTINCT FROM NEW.target_environment
     OR OLD.core_version IS DISTINCT FROM NEW.core_version
     OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.role_package_id IS DISTINCT FROM NEW.role_package_id
     OR OLD.role_package_version IS DISTINCT FROM NEW.role_package_version
     OR OLD.recording_policy IS DISTINCT FROM NEW.recording_policy
     OR OLD.catalog_version IS DISTINCT FROM NEW.catalog_version
     OR OLD.catalog_count IS DISTINCT FROM NEW.catalog_count
     OR OLD.discovered_count IS DISTINCT FROM NEW.discovered_count
     OR OLD.tenant_table_count IS DISTINCT FROM NEW.tenant_table_count
     OR OLD.rls_enabled_count IS DISTINCT FROM NEW.rls_enabled_count
     OR OLD.verified_control_count IS DISTINCT FROM NEW.verified_control_count
     OR OLD.caller_missing_count IS DISTINCT FROM NEW.caller_missing_count
     OR OLD.caller_stale_count IS DISTINCT FROM NEW.caller_stale_count
     OR OLD.preflight_sha256 IS DISTINCT FROM NEW.preflight_sha256
     OR OLD.evidence_snapshot_sha256 IS DISTINCT FROM NEW.evidence_snapshot_sha256
     OR OLD.retention_plan_sha256 IS DISTINCT FROM NEW.retention_plan_sha256
     OR OLD.deletion_evidence_sha256 IS DISTINCT FROM NEW.deletion_evidence_sha256
     OR OLD.submitted_by IS DISTINCT FROM NEW.submitted_by
     OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'healthcare activation readiness proof identity is immutable';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.verified_by IS DISTINCT FROM NEW.verified_by
       OR OLD.verified_at IS DISTINCT FROM NEW.verified_at
       OR OLD.revoked_by IS DISTINCT FROM NEW.revoked_by
       OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
       OR OLD.revocation_reason IS DISTINCT FROM NEW.revocation_reason THEN
      RAISE EXCEPTION 'invalid healthcare activation readiness workflow transition';
    END IF;
  ELSIF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('verified', 'revoked'))
    OR (OLD.status = 'verified' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'invalid healthcare activation readiness workflow transition';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS healthcare_activation_readiness_identity_immutable
  ON healthcare_activation_readiness;
CREATE TRIGGER healthcare_activation_readiness_identity_immutable
  BEFORE UPDATE ON healthcare_activation_readiness
  FOR EACH ROW EXECUTE FUNCTION prevent_healthcare_activation_readiness_identity_mutation();

ALTER TABLE healthcare_activation_readiness ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS healthcare_activation_readiness_service_only
  ON healthcare_activation_readiness;
CREATE POLICY healthcare_activation_readiness_service_only
  ON healthcare_activation_readiness
  FOR ALL
  USING (current_user IN ('service_role', 'postgres'))
  WITH CHECK (current_user IN ('service_role', 'postgres'));

ALTER TABLE healthcare_control_evidence
  DROP CONSTRAINT IF EXISTS healthcare_control_evidence_owner_role_match;
ALTER TABLE healthcare_control_evidence
  ADD CONSTRAINT healthcare_control_evidence_owner_role_match CHECK (
    (control_key IN ('compliance_owner_approval', 'customer_agreement', 'retention_controls', 'deletion_controls') AND owner_role = 'compliance')
    OR (control_key IN ('twilio_approval', 'openai_approval', 'hosting_approval', 'storage_controls', 'deployment_security') AND owner_role = 'infrastructure')
    OR (control_key = 'recording_disabled' AND owner_role = 'product_safety')
    OR (control_key = 'pilot_acceptance' AND owner_role = 'pilot_customer')
  ) NOT VALID;

ALTER TABLE healthcare_deployment_approvals
  ADD COLUMN IF NOT EXISTS readiness_ref VARCHAR(40)
  REFERENCES healthcare_activation_readiness(readiness_ref) ON DELETE RESTRICT;
ALTER TABLE healthcare_deployment_approvals
  DROP CONSTRAINT IF EXISTS healthcare_deployment_approval_readiness_required;
ALTER TABLE healthcare_deployment_approvals
  ADD CONSTRAINT healthcare_deployment_approval_readiness_required CHECK (
    (approval_kind = 'production_healthcare' AND readiness_ref IS NOT NULL)
    OR (approval_kind = 'synthetic_test' AND readiness_ref IS NULL)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_healthcare_deployment_readiness()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.approval_kind = 'production_healthcare' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM healthcare_activation_readiness readiness
       WHERE readiness.readiness_ref = NEW.readiness_ref
         AND readiness.target_environment = 'production'
         AND readiness.status = 'verified'
         AND readiness.revoked_at IS NULL
         AND readiness.expires_at >= NEW.expires_at
         AND readiness.tenant_id = NEW.tenant_id
         AND readiness.agent_id = NEW.agent_id
         AND readiness.core_version = NEW.core_version
         AND readiness.model = NEW.model
         AND readiness.role_package_id = NEW.role_package_id
         AND readiness.role_package_version = NEW.role_package_version
         AND readiness.recording_policy = NEW.recording_policy
    ) THEN
      RAISE EXCEPTION 'production healthcare approval requires active verified readiness';
    END IF;
  ELSIF NEW.readiness_ref IS NOT NULL THEN
    RAISE EXCEPTION 'synthetic healthcare approval cannot reference production readiness';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS healthcare_deployment_readiness_enforced
  ON healthcare_deployment_approvals;
CREATE TRIGGER healthcare_deployment_readiness_enforced
  BEFORE INSERT OR UPDATE OF readiness_ref, approval_kind, tenant_id, agent_id, expires_at
  ON healthcare_deployment_approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_healthcare_deployment_readiness();
