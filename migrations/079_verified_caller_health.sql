-- 079: Verified caller ID health tracking
--
-- Adds the bookkeeping columns the weekly health-check scheduler uses to
-- catch verified caller IDs that have been revoked, are about to expire, or
-- whose backing Trust Hub product / brand registration has been rejected.
--
-- Without this we only knew about a caller losing carrier attestation when
-- a campaign owner noticed calls were being attested at level C / flagged
-- as spam. The health scheduler runs weekly, queries Twilio for each
-- verified caller, and writes the result into the columns below so the UI
-- can surface an "expires in N days" badge and the notification dispatcher
-- can throttle alerts to one-per-week-per-caller.
--
-- Columns:
--   expires_at            — timestamp at which the carrier attestation
--                           lapses (Trust Hub product `valid_until`, brand
--                           registration expiration, etc.). NULL when the
--                           caller has no advertised expiry (entry-level
--                           Twilio OutgoingCallerIds last indefinitely).
--   last_health_check_at  — when the scheduler last queried Twilio.
--   last_health_status    — one of `healthy`, `expiring_soon`, `expired`,
--                           `revoked`, `unknown`. Drives the UI badge and
--                           the alert dispatcher.
--   last_health_message   — last human-readable detail (Twilio error text,
--                           Trust Hub status string, etc.) so the UI can
--                           explain *why* a caller is flagged.
--   expiry_alert_sent_at  — last time we dispatched an expiry / revoked
--                           alert for this caller. Throttles repeat
--                           notifications to once per week.

ALTER TABLE verified_caller_ids
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_health_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS last_health_message TEXT,
  ADD COLUMN IF NOT EXISTS expiry_alert_sent_at TIMESTAMPTZ;

-- Partial index on (last_health_check_at) for the weekly scheduler sweep:
-- only verified callers are ever health-checked, and the scheduler picks
-- up rows that were never checked (NULL) first, then the oldest checks.
CREATE INDEX IF NOT EXISTS idx_verified_caller_ids_health_check
  ON verified_caller_ids(last_health_check_at NULLS FIRST)
  WHERE status = 'verified';

-- Cross-tenant lookup of imminently-expiring callers (used by the
-- scheduler when computing the alert audience and by potential admin
-- dashboards). Filtered to only verified rows so we never index the long
-- tail of pending/failed/rotated rows.
CREATE INDEX IF NOT EXISTS idx_verified_caller_ids_expires_at
  ON verified_caller_ids(expires_at)
  WHERE status = 'verified' AND expires_at IS NOT NULL;
