-- 086_pairing_codes_id_normalize.sql
-- Bring dispatch_resource_pairing_codes in line with the rest of the
-- schema: VARCHAR(255) IDs (matching tenants.id, users.id,
-- user_devices.id) and the standard RLS variable name.

DROP POLICY IF EXISTS pairing_codes_tenant_isolation ON dispatch_resource_pairing_codes;

ALTER TABLE dispatch_resource_pairing_codes
  ALTER COLUMN tenant_id TYPE VARCHAR(255) USING tenant_id::text;

ALTER TABLE dispatch_resource_pairing_codes
  ALTER COLUMN issued_by_user TYPE VARCHAR(255) USING issued_by_user::text;

ALTER TABLE dispatch_resource_pairing_codes
  ALTER COLUMN consumed_device TYPE VARCHAR(255) USING consumed_device::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'dispatch_resource_pairing_codes'
      AND constraint_name = 'dispatch_resource_pairing_codes_tenant_id_fkey'
  ) THEN
    ALTER TABLE dispatch_resource_pairing_codes
      ADD CONSTRAINT dispatch_resource_pairing_codes_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE POLICY pairing_codes_tenant_isolation
  ON dispatch_resource_pairing_codes
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
