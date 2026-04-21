-- Daily digest support for saved call views.
-- Owner gets the digest when digest_enabled = true.
-- Shared-view watchers can opt in via digest_subscribers (array of user emails).

ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS digest_subscribers TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS digest_last_run_at TIMESTAMPTZ;

ALTER TABLE call_saved_views
  ADD COLUMN IF NOT EXISTS digest_last_match_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_call_saved_views_digest_enabled
  ON call_saved_views(tenant_id) WHERE digest_enabled = true;
