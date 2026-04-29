-- Per-recipient delivery records for verified caller health alerts.
--
-- Mirrors the connector_alert_recipients table (migration 094) so the
-- Platform Admin verified-caller health panel can show "did the alert
-- email actually reach the tenant's admins?" instead of only "we sent
-- something this week". Without this, support cannot tell the difference
-- between a tenant who ignored the alert and a tenant whose mailbox
-- bounced every recipient.
--
-- One row per (dispatch, recipient). dispatch_id groups every recipient
-- in a single dispatchVerifiedCallerAlert call so the admin endpoint can
-- pivot from a caller's history into the per-recipient breakdown with
-- one indexed lookup. caller_id is intentionally NOT a foreign key
-- because the underlying verified_caller_ids row may be deleted (or
-- rotated) after the alert was sent and we still want the audit trail
-- to survive.
--
-- delivery_status values:
--   sent     — sendEmail returned success.
--   bounced  — sendEmail returned a permanent SMTP failure (5xx, mailbox
--              rejected, address unknown, …). These are the rows the UI
--              should treat as "didn't reach the recipient" for the
--              all-bounced badge.
--   failed   — transient SMTP failure (e.g. 4xx, network error, timeout).
--              The next weekly scheduler run will try again.
--   skipped  — Recipient was filtered out before the network call —
--              opted out of integration emails, on the suppression list,
--              etc. Captured so the panel can explain *why* a recipient
--              isn't in the sent list.

CREATE TABLE IF NOT EXISTS verified_caller_alert_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Not a foreign key on purpose; see header note about deletes.
  caller_id VARCHAR NOT NULL,
  dispatch_id VARCHAR(64) NOT NULL,
  -- Caller's health status at dispatch time ('expiring_soon' | 'expired'
  -- | 'revoked'). Captured here so the history view shows what the alert
  -- said even if the caller has since been re-verified.
  health_status VARCHAR(32) NOT NULL,
  -- Recipient context. user_id is nullable because a recipient might be
  -- deactivated by the time we surface the audit row — ON DELETE SET NULL
  -- preserves the rest of the trail.
  user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  recipient_name TEXT,
  recipient_email TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  delivery_error TEXT,
  -- Convenience flag for the UI: true when delivery_status='bounced'
  -- (permanent SMTP failure). Stored rather than derived so future
  -- async bounce webhook integration can flip an existing 'sent' row to
  -- 'bounced' without losing the original send attempt.
  permanent_failure BOOLEAN NOT NULL DEFAULT FALSE,
  -- Source attribution: 'scheduler' for automated weekly runs,
  -- 'admin_reissue' for the Platform Admin "Re-issue alert" button.
  source TEXT NOT NULL DEFAULT 'scheduler',
  triggered_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-caller history lookup: the admin detail endpoint pulls the most
-- recent N dispatches for a single (tenant, caller) pair.
CREATE INDEX IF NOT EXISTS idx_verified_caller_alert_recipients_caller
  ON verified_caller_alert_recipients(tenant_id, caller_id, dispatched_at DESC);

-- Dispatch grouping: pivot from a caller's most recent dispatch_id into
-- the recipient list without re-scanning the full history.
CREATE INDEX IF NOT EXISTS idx_verified_caller_alert_recipients_dispatch
  ON verified_caller_alert_recipients(tenant_id, dispatch_id);
