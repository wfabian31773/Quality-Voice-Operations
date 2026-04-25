-- 066: CRM caller identity cache
-- Persists per-tenant per-caller-phone CRM record IDs returned by connector
-- adapters (Salesforce / HubSpot / etc.). Subsequent connector dispatches for
-- the same caller can short-circuit phone/company lookups by using these IDs.

CREATE TABLE IF NOT EXISTS crm_caller_identities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  phone_e164 VARCHAR(32) NOT NULL,
  contact_id VARCHAR(255),
  account_id VARCHAR(255),
  opportunity_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_crm_caller_identities_tenant_phone
  ON crm_caller_identities(tenant_id, phone_e164);

CREATE INDEX IF NOT EXISTS idx_crm_caller_identities_tenant_provider
  ON crm_caller_identities(tenant_id, provider);

ALTER TABLE crm_caller_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_crm_caller_identities ON crm_caller_identities;
CREATE POLICY tenant_isolation_crm_caller_identities ON crm_caller_identities
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
