-- Tenant-level toggle for connector SMS outage alerts.
-- When TRUE, sustained-failure SMS notifications are suppressed for the tenant.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sms_alerts_disabled BOOLEAN NOT NULL DEFAULT FALSE;
