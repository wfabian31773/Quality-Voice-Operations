-- 068: CRM caller identity extras column
-- Adds a JSONB `extras` column to crm_caller_identities so per-provider
-- native record IDs (HubSpot company_id/deal_id, Pipedrive person_id/org_id/deal_id, etc.)
-- can be persisted verbatim instead of being squeezed into the Salesforce-shaped
-- contact_id/account_id/opportunity_id slots. The canonical columns are kept
-- for Salesforce and as a back-compat fallback for already-cached rows.

ALTER TABLE crm_caller_identities
  ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '{}'::jsonb;
