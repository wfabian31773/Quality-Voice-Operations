-- Per-(tenant, integration) dedup state for the platform-admin "stale
-- connector" ops alert. The Connector Health route already surfaces wedged
-- connectors (token expired or `needs_reconnect` for >= 2 sweep cycles), but
-- ops only saw them when an admin opened the page. The new
-- `ConnectorStaleAlertScheduler` runs a daily cycle, finds the same wedged
-- rows, and emails/Slacks platform admins with one consolidated digest.
--
-- This table is the dedup ledger that makes the digest sane:
--   * `(tenant_id, integration_id)` is the unique alert key.
--   * `last_alerted_at` gates the cooldown so a permanently broken
--     integration only re-pings ops once per cooldown window.
--   * `resolved_at` is stamped when a previously-alerted row is no longer
--     stale (worker recovered, admin reconnected, or integration disabled).
--     Clearing this field on the next stale recurrence is what makes a
--     "broken → fixed → broken again" transition fire a fresh alert.
--   * `alert_count` and `first_alerted_at` give ops a feel for how
--     long-running each outage has been across cycles.
--
-- The scheduler also writes `last_status` / `last_provider` for cheap
-- joinable context in admin queries — never decrypt or load the actual
-- token material here.

CREATE TABLE IF NOT EXISTS connector_stale_alerts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  integration_id VARCHAR(64) NOT NULL,
  last_provider VARCHAR(80),
  last_status VARCHAR(40),
  first_alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  UNIQUE (tenant_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_connector_stale_alerts_unresolved
  ON connector_stale_alerts (last_alerted_at DESC)
  WHERE resolved_at IS NULL;
