-- Track when the auto-disable scheduler flipped an integration's
-- is_enabled to FALSE because it had been stuck in an auth-error /
-- needs_reconnect state for longer than the configured threshold
-- (CONNECTOR_AUTO_DISABLE_DAYS, default 14 days).
--
-- The column doubles as:
--   * a marker so the scheduler does not re-evaluate already-disabled
--     integrations (the WHERE clause filters is_enabled = TRUE), and
--   * a signal to the Connectors UI to render an explicit "auto-disabled"
--     badge separate from "manually disabled".
--
-- It is cleared whenever a user re-enables / reconnects the connector
-- (upsertConnector) or when a sync transitions back to success
-- (updateConnectorSyncStatus).
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS auto_disabled_at TIMESTAMP;
