ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS is_free_number BOOLEAN DEFAULT FALSE;
ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS monthly_cost_cents INTEGER DEFAULT 200;
ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS provisioned_via VARCHAR(20) DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_phone_numbers_tenant_free ON phone_numbers(tenant_id, is_free_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_one_free_per_tenant ON phone_numbers(tenant_id) WHERE is_free_number = TRUE;
