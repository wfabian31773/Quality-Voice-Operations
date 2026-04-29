-- Track every time the CRM dispatch layer scrubs stale cached records for a
-- given (tenant, provider, caller_phone). Repeated scrubs for the same caller
-- are a strong signal that:
--   (a) the upstream CRM integration is flaky (records keep getting deleted
--       and re-created), or
--   (b) the customer's team is repeatedly deleting CRM records that the AI
--       just created.
--
-- Either way the customer should hear about it instead of us silently
-- scrubbing the cache and retrying with degraded context. The
-- `CrmStaleCacheTracker` module reads this table to count scrubs in the last
-- 24h per (tenant, provider, caller_phone) and fires an in-app alert when the
-- count crosses a configurable threshold.

CREATE TABLE IF NOT EXISTS crm_stale_cache_scrubs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Lower-case adapter slug (salesforce / hubspot / pipedrive / zoho).
  provider VARCHAR(64) NOT NULL,
  -- Digits-only normalized form so different formattings of the same number
  -- deduplicate cleanly. Matches the key shape used by `crm_caller_identities`
  -- so the two tables can be cross-referenced for diagnostics.
  caller_phone VARCHAR(32) NOT NULL,
  -- The {contactId, accountId, opportunityId, companyId, dealId, personId,
  -- orgId} payload that was just scrubbed, captured verbatim so the alert
  -- can deep-link the customer to the offending upstream record.
  stale_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Adapter-reported error code (e.g. ENTITY_IS_DELETED for Salesforce,
  -- HTTP 404 for HubSpot/Pipedrive). Helps customers triage which kind of
  -- "record vanished" they're actually hitting.
  error_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary read path: the alert tracker counts recent scrubs per
-- (tenant, provider, caller) within a 24h sliding window.
CREATE INDEX IF NOT EXISTS idx_crm_stale_cache_scrubs_lookup
  ON crm_stale_cache_scrubs(tenant_id, provider, caller_phone, occurred_at DESC);

-- Diagnostic path: list recent scrubs per tenant for an admin overview
-- without forcing a (provider, caller_phone) filter.
CREATE INDEX IF NOT EXISTS idx_crm_stale_cache_scrubs_tenant_recent
  ON crm_stale_cache_scrubs(tenant_id, occurred_at DESC);
