-- Federal Do-Not-Call registry sync.
--
-- Extends the per-tenant `dnc_list` (migration 022) with a *platform-scoped*
-- snapshot of the FTC National Do Not Call Registry. The compliance pre-flight
-- (`platform/campaigns/ComplianceService.ts`) consults this table in addition
-- to the tenant DNC list so a tenant who hasn't manually added a federally
-- protected number is still blocked from dialing it. Closes the largest TCPA
-- exposure left after the per-tenant DNC work (BL-029).
--
-- Two tables:
--   * federal_dnc_numbers — one row per phone number on the registry. NOT
--     tenant-scoped (this is a platform-wide reference dataset). Indexed by
--     phone_number for the batch ANY(...) lookups the pre-flight performs.
--   * federal_dnc_sync_state — singleton (id=1) tracking the last sync run:
--     when it started/finished, what registry version it pulled, how many
--     numbers it loaded, and the outcome. The scheduled job in
--     `platform/campaigns/FederalDncSyncScheduler.ts` updates this row each
--     week.
--
-- RLS: deliberately NOT enabled on either table. They're a reference dataset
-- consulted by every tenant — RLS would force us to either grant a global
-- bypass or duplicate the data per tenant, both of which are worse than
-- leaving these tables platform-only and never returning their contents in
-- a tenant-scoped API surface (we only ever do a membership check against
-- already-decrypted phones, never SELECT *).

CREATE TABLE IF NOT EXISTS federal_dnc_numbers (
  phone_number VARCHAR(20) PRIMARY KEY,
  registry_version VARCHAR(64) NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_federal_dnc_numbers_version
  ON federal_dnc_numbers(registry_version);

CREATE TABLE IF NOT EXISTS federal_dnc_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_sync_started_at TIMESTAMPTZ,
  last_sync_completed_at TIMESTAMPTZ,
  last_registry_version VARCHAR(64),
  last_record_count INTEGER,
  last_status VARCHAR(20),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO federal_dnc_sync_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
