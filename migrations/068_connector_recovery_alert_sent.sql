-- Track when the most recent "all clear" recovery email was dispatched
-- for a connector. Mirrors `auth_alert_sent_at` (migration 066) but is
-- used purely as a throttle marker so the recovery alert path can fire
-- at most once per integration per RECOVERY_THROTTLE_HOURS.
--
-- Why a dedicated column instead of looking at tenant_notifications:
-- recovery in-app rows are now fanned out per user and gated by each
-- admin's in_app preference, so an installation where every admin has
-- in_app off for 'integration_recovery' would leave no row behind to
-- act as the throttle marker — and email would be re-sent every time
-- the connector flapped within the throttle window. A column on the
-- integration itself is independent of per-user preferences.
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS recovery_alert_sent_at TIMESTAMP;
