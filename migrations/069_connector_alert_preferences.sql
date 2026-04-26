-- Per-tenant preferences that let admins control which connector
-- auth/sync alert emails their workspace receives. Two pieces:
--
--   1. `connector_alert_settings` holds tenant-wide knobs:
--        * digest_mode = TRUE folds the per-integration auth-failure
--          emails into a single daily digest sent by the
--          ConnectorAuthAlertScheduler. In-app notifications still
--          fire (subject to the existing 24h throttle).
--        * digest_last_sent_at gates the digest to once per 24 hours.
--   2. `connector_alert_mutes` lets an admin silence alerts (both
--      email and in-app) for a specific provider (e.g. all Slack
--      connectors) or a single integration row. Default is "no
--      mutes", matching the pre-existing behaviour where every
--      enabled connector triggers an alert when it errors.

CREATE TABLE IF NOT EXISTS connector_alert_settings (
  tenant_id           VARCHAR PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  digest_mode         BOOLEAN NOT NULL DEFAULT FALSE,
  digest_last_sent_at TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by          VARCHAR
);

CREATE TABLE IF NOT EXISTS connector_alert_mutes (
  tenant_id  VARCHAR     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope      VARCHAR(16) NOT NULL CHECK (scope IN ('provider', 'integration')),
  target     VARCHAR     NOT NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT NOW(),
  created_by VARCHAR,
  PRIMARY KEY (tenant_id, scope, target)
);

CREATE INDEX IF NOT EXISTS idx_connector_alert_mutes_tenant
  ON connector_alert_mutes(tenant_id);
