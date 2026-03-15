ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_call_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_phone_numbers_demo ON phone_numbers(is_demo) WHERE is_demo = true;
CREATE INDEX IF NOT EXISTS idx_tenants_demo ON tenants(is_demo) WHERE is_demo = true;
