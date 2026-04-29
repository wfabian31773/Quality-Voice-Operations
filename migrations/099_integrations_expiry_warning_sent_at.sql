-- Track when we last emailed tenant admins a "your connector token is
-- about to expire" heads-up. The Connector Auth Alert scheduler already
-- pages tenants once a connector has actually fallen into
-- `needs_reconnect` / `auth_error` state via `auth_alert_sent_at`, but by
-- then the worker is already failing. This column gates a second alert
-- class — a proactive warning ~24h before the OAuth access token expires
-- so customers can reconnect during business hours instead of after the
-- first failed sync.
--
-- Mirrors the throttle pattern from `auth_alert_sent_at` (migration 066):
--   * The expiring-warning cycle only sends when this column is NULL or
--     older than the throttle window (~20h), so two cycles within a day
--     can't double-page admins for the same upcoming expiry.
--   * `updateConnectorSyncStatus(success, ...)` clears this column on
--     recovery so a connector that recovers and later expires again gets
--     a fresh warning instead of being silenced for 24h.
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS expiry_warning_sent_at TIMESTAMPTZ;

-- Cheap index so the scheduler's "warn me about anything that hasn't been
-- warned yet" pre-filter can short-circuit on a partial scan instead of
-- pulling the full integrations table on every cycle. Mirrors the
-- partial index used for `auth_alert_sent_at`.
CREATE INDEX IF NOT EXISTS idx_integrations_expiry_warning_pending
  ON integrations(tenant_id, last_sync_status)
  WHERE expiry_warning_sent_at IS NULL;
