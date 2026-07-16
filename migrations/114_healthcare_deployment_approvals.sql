-- GTM-011: fail-closed deployment approval and deterministic PII lookup.

CREATE TABLE IF NOT EXISTS healthcare_deployment_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  approval_kind VARCHAR(32) NOT NULL CHECK (approval_kind IN ('synthetic_test', 'production_healthcare')),
  core_version VARCHAR(20) NOT NULL DEFAULT '1.0.0' CHECK (core_version = '1.0.0'),
  model VARCHAR(100) NOT NULL DEFAULT 'gpt-realtime-2' CHECK (model = 'gpt-realtime-2'),
  role_package_id VARCHAR(100) NOT NULL DEFAULT 'healthcare-receptionist' CHECK (role_package_id = 'healthcare-receptionist'),
  role_package_version VARCHAR(20) NOT NULL DEFAULT '1.0.0' CHECK (role_package_version = '1.0.0'),
  recording_policy VARCHAR(20) NOT NULL DEFAULT 'disabled' CHECK (recording_policy = 'disabled'),
  evidence_refs JSONB NOT NULL DEFAULT '{}',
  synthetic_caller_hashes JSONB NOT NULL DEFAULT '[]',
  approved_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  revocation_reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > approved_at),
  CHECK (jsonb_typeof(evidence_refs) = 'object'),
  CHECK (jsonb_typeof(synthetic_caller_hashes) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_healthcare_deployment_approval_active
  ON healthcare_deployment_approvals(tenant_id, agent_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_healthcare_deployment_approvals_expiry
  ON healthcare_deployment_approvals(expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE healthcare_deployment_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS healthcare_deployment_approvals_service_only ON healthcare_deployment_approvals;
CREATE POLICY healthcare_deployment_approvals_service_only ON healthcare_deployment_approvals
  FOR ALL
  USING (current_user IN ('service_role', 'postgres'))
  WITH CHECK (current_user IN ('service_role', 'postgres'));

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS caller_lookup_hash CHAR(64);
CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_caller_lookup_hash
  ON call_sessions(tenant_id, caller_lookup_hash, start_time DESC)
  WHERE caller_lookup_hash IS NOT NULL;

-- Preserve a redacted proof record after the tenant and requesting user are
-- removed. The execution path clears free-form fields before deletion.
ALTER TABLE tenant_deletion_requests ADD COLUMN IF NOT EXISTS tenant_fingerprint CHAR(64);
ALTER TABLE tenant_deletion_requests ADD COLUMN IF NOT EXISTS first_party_verification JSONB;
ALTER TABLE tenant_deletion_requests ADD COLUMN IF NOT EXISTS external_deletion_evidence JSONB;
ALTER TABLE tenant_deletion_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE tenant_deletion_requests ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE tenant_deletion_requests ALTER COLUMN requested_by DROP NOT NULL;

ALTER TABLE tenant_deletion_requests DROP CONSTRAINT IF EXISTS tenant_deletion_requests_tenant_id_fkey;
ALTER TABLE tenant_deletion_requests ADD CONSTRAINT tenant_deletion_requests_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE tenant_deletion_requests DROP CONSTRAINT IF EXISTS tenant_deletion_requests_requested_by_fkey;
ALTER TABLE tenant_deletion_requests ADD CONSTRAINT tenant_deletion_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tenant_deletion_requests DROP CONSTRAINT IF EXISTS tenant_deletion_requests_cancelled_by_fkey;
ALTER TABLE tenant_deletion_requests ADD CONSTRAINT tenant_deletion_requests_cancelled_by_fkey
  FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;

-- Audit rows remain immutable for ordinary writes. A verified tenant deletion
-- transaction may set the exact tenant id in a transaction-local setting so
-- the tenant FK cascade can complete. The redacted deletion evidence row above
-- becomes the durable, non-PHI proof of that destructive action.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.verified_tenant_deletion_id', TRUE) = OLD.tenant_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is immutable: % operations are not permitted', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
