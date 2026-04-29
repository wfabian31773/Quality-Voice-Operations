-- 095: CRM caller identity revalidation tracking
-- Adds a `last_validated_at` column so the periodic CRM identity sweep
-- (CrmCallerIdentityRevalidationScheduler) can pick up rows that haven't
-- been re-validated against the upstream CRM in the last N hours, scrub
-- ones whose IDs return 404 / RESOURCE_NOT_FOUND, and bump the timestamp
-- on rows that still resolve. NULL = never validated, sweep first.

ALTER TABLE crm_caller_identities
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_caller_identities_provider_validated
  ON crm_caller_identities(provider, last_validated_at NULLS FIRST);
