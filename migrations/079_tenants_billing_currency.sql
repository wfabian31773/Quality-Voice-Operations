-- Add billing_currency to tenants table so per-tenant cost displays
-- render in the right currency symbol/format (USD, EUR, GBP, etc.)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_currency VARCHAR(3) NOT NULL DEFAULT 'usd';

CREATE INDEX IF NOT EXISTS idx_tenants_billing_currency ON tenants(billing_currency);
