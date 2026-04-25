-- Track when an admin email was last sent for a connector that fell into
-- an auth-error / "needs reconnect" state. The column is cleared again
-- whenever the connector recovers (status flips back to success), which
-- guarantees the same connector cannot generate duplicate alerts until
-- it both recovers and fails again.
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS auth_alert_sent_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_integrations_auth_alert_pending
  ON integrations(tenant_id, last_sync_status)
  WHERE auth_alert_sent_at IS NULL;
