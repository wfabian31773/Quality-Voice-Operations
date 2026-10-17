-- Shared action layer storage (PR-01).
--
-- Typed actions in platform/actions are the only place business logic
-- lives. The app UI, voice agent, and QVO MCP server all go through
-- runAction(), which uses these tables for idempotency, two-phase
-- confirmation tokens, and a redacted audit row per run.
--
-- RLS is enabled AND forced. Policies key off current_setting('app.tenant_id')
-- the same way as 117_tenant_rls_remediation.sql. Missing/empty tenant
-- settings match no rows.

CREATE TABLE IF NOT EXISTS action_idempotency (
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(128) NOT NULL,
  key VARCHAR(256) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, action, key),
  CHECK (response IS NULL OR jsonb_typeof(response) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_action_idempotency_expires
  ON action_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS action_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(128) NOT NULL,
  call_id VARCHAR(128),
  payload_hash CHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  readback TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload) = 'object' OR jsonb_typeof(payload) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_action_proposals_tenant_call
  ON action_proposals (tenant_id, call_id);
CREATE INDEX IF NOT EXISTS idx_action_proposals_expires
  ON action_proposals (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS action_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(128) NOT NULL,
  actor JSONB NOT NULL,
  input_redacted JSONB NOT NULL,
  result_code VARCHAR(64) NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  call_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(actor) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_action_audit_log_tenant_created
  ON action_audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_audit_log_call
  ON action_audit_log (call_id)
  WHERE call_id IS NOT NULL;

ALTER TABLE action_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_action_idempotency ON action_idempotency;
CREATE POLICY tenant_isolation_action_idempotency ON action_idempotency
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_action_proposals ON action_proposals;
CREATE POLICY tenant_isolation_action_proposals ON action_proposals
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE action_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_action_audit_log ON action_audit_log;
CREATE POLICY tenant_isolation_action_audit_log ON action_audit_log
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

-- Append-only, matching audit_logs in 046_enterprise_security.sql.
CREATE OR REPLACE FUNCTION prevent_action_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  -- Same narrow exception as prevent_audit_log_mutation in 114: a verified
  -- tenant deletion may set app.verified_tenant_deletion_id so ON DELETE
  -- CASCADE from tenants can remove this tenant's rows.
  IF TG_OP = 'DELETE'
     AND current_setting('app.verified_tenant_deletion_id', TRUE) = OLD.tenant_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'action_audit_log is immutable: % operations are not permitted', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_audit_log_no_update ON action_audit_log;
CREATE TRIGGER action_audit_log_no_update BEFORE UPDATE ON action_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_action_audit_log_mutation();

DROP TRIGGER IF EXISTS action_audit_log_no_delete ON action_audit_log;
CREATE TRIGGER action_audit_log_no_delete BEFORE DELETE ON action_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_action_audit_log_mutation();

-- 120 already sets DEFAULT PRIVILEGES for qvo_app on objects created by the
-- migration role (including UPDATE/DELETE). Repeat GRANTs here so a restored
-- schema still has DML, then revoke mutations on the append-only audit table.
-- Do not edit 120 from this PR.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qvo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON action_idempotency, action_proposals TO qvo_app;
    GRANT SELECT, INSERT ON action_audit_log TO qvo_app;
    REVOKE UPDATE, DELETE ON action_audit_log FROM qvo_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_rls_tester') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON action_idempotency, action_proposals TO platform_rls_tester;
    GRANT SELECT, INSERT ON action_audit_log TO platform_rls_tester;
    REVOKE UPDATE, DELETE ON action_audit_log FROM platform_rls_tester;
  END IF;
END
$$;
