-- 085_dispatch_resource_pairing_codes.sql
-- Admin-issued one-time codes that bind a mobile device to a specific
-- dispatch_resource at enrollment time. See task #602.

CREATE TABLE IF NOT EXISTS dispatch_resource_pairing_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id     VARCHAR(255) NOT NULL REFERENCES dispatch_resources(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,
  issued_by_user  VARCHAR(255),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  consumed_device VARCHAR(255),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_codes_hash
  ON dispatch_resource_pairing_codes (code_hash);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_tenant_resource
  ON dispatch_resource_pairing_codes (tenant_id, resource_id, created_at DESC);

ALTER TABLE dispatch_resource_pairing_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pairing_codes_tenant_isolation ON dispatch_resource_pairing_codes;
CREATE POLICY pairing_codes_tenant_isolation
  ON dispatch_resource_pairing_codes
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
