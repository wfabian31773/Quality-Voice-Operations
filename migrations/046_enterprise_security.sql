-- Enterprise Security & Compliance Migration
-- Immutable audit log, envelope encryption tracking, GDPR support, credential vault enhancements

-- 1. Make audit_logs immutable (append-only: no UPDATE or DELETE)
-- Use trigger functions that raise exceptions to block mutations loudly
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is immutable: % operations are not permitted', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- 2. Add before/after state columns to audit_logs if not present
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB DEFAULT NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_state JSONB DEFAULT NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info';

CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_occurred ON audit_logs(tenant_id, action, occurred_at);

-- 3. Envelope encryption key registry
CREATE TABLE IF NOT EXISTS encryption_keys (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_alias VARCHAR(100) NOT NULL,
  encrypted_dek TEXT NOT NULL,
  algorithm VARCHAR(30) DEFAULT 'aes-256-gcm',
  is_active BOOLEAN DEFAULT TRUE,
  rotated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_encryption_keys_tenant ON encryption_keys(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_encryption_keys_alias ON encryption_keys(tenant_id, key_alias) WHERE is_active = TRUE;

ALTER TABLE encryption_keys ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation_encryption_keys ON encryption_keys
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Encrypted fields registry (tracks which fields are encrypted)
CREATE TABLE IF NOT EXISTS encrypted_fields (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_name VARCHAR(100) NOT NULL,
  column_name VARCHAR(100) NOT NULL,
  encryption_key_id VARCHAR REFERENCES encryption_keys(id),
  encrypted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_encrypted_fields_tenant ON encrypted_fields(tenant_id);

ALTER TABLE encrypted_fields ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation_encrypted_fields ON encrypted_fields
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. GDPR data subject requests
CREATE TABLE IF NOT EXISTS gdpr_requests (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('export', 'erasure')),
  subject_email VARCHAR(255) NOT NULL,
  subject_user_id VARCHAR,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  requested_by VARCHAR REFERENCES users(id),
  result_data JSONB,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gdpr_requests_tenant ON gdpr_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_status ON gdpr_requests(tenant_id, status);

ALTER TABLE gdpr_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation_gdpr_requests ON gdpr_requests
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. Add permission scope to api_keys if not present
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permission_level VARCHAR(20) DEFAULT 'read-only'
  CHECK (permission_level IN ('read-only', 'write', 'admin'));

-- 7. Tenant isolation verification log
CREATE TABLE IF NOT EXISTS tenant_isolation_tests (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name VARCHAR(200) NOT NULL,
  test_result VARCHAR(20) NOT NULL CHECK (test_result IN ('pass', 'fail')),
  details JSONB DEFAULT '{}',
  run_at TIMESTAMP DEFAULT NOW()
);
