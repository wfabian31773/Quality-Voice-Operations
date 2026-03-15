CREATE TABLE IF NOT EXISTS dnc_list (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  reason TEXT,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dnc_list_tenant_phone ON dnc_list(tenant_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_dnc_list_tenant ON dnc_list(tenant_id);

ALTER TABLE dnc_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dnc_list_tenant_isolation ON dnc_list;
CREATE POLICY dnc_list_tenant_isolation ON dnc_list
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
