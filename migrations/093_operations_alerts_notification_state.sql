-- Adds delivery-state columns to operations_alerts so push notifications
-- (currently the finance billing_backfill_cross_day email/Slack ping) can
-- track per-alert dispatch and avoid duplicate sends across retries or
-- crash-restarts.
--
--   * notified_at        — wall-clock timestamp of the first successful push.
--                          NULL means the alert has never been sent (or the
--                          notifier is best-effort skipping it, e.g. because
--                          the finance distribution list is empty).
--   * notification_kind  — comma-separated channel list that succeeded on the
--                          first push (e.g. 'email', 'slack', 'email,slack').
--                          Stored as text rather than a typed array because we
--                          only ever read it back for diagnostics.
ALTER TABLE operations_alerts
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_kind VARCHAR(64);
