-- Track when an admin email was last sent for scheduling-provider drift
-- (an agent or phone number is using a calendar that's no longer connected
-- via an enabled scheduling integration). Per-tenant dedupe column mirrors
-- the per-integration `auth_alert_sent_at` pattern from migration 066, but
-- a tenant can have N drifted agents/numbers across providers and we only
-- want to nag once per 24h with a single roll-up email.
--
-- Column lives on `tenants` because the drift signal is computed by joining
-- `agents.scheduling_provider` / `phone_numbers.scheduling_provider` against
-- the set of enabled scheduling integrations for the tenant — there's no
-- single integration row to stamp. The `SchedulingDriftAlertScheduler` does
-- the per-tenant atomic claim via UPDATE ... WHERE scheduling_drift_alert_sent_at
-- IS NULL OR < NOW() - 24h.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS scheduling_drift_alert_sent_at TIMESTAMP;
