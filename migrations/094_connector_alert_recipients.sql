-- Per-recipient delivery records for connector outage alerts.
--
-- The aggregate alert metadata on `tenant_notifications` only tells admins
-- *that* an alert went out and how many people it was fanned out to. To let
-- admins audit a specific incident end-to-end (which person was paged, did
-- their SMS actually deliver, what was the original error trace) we need a
-- per-(recipient, dispatch) row.
--
-- Each row captures one (alert dispatch, recipient) pair across both the
-- email and SMS escalation paths in `SyncErrorAlerter`. `dispatch_id` is a
-- UUID generated at the start of each notify call and also stamped on the
-- corresponding `tenant_notifications.metadata.dispatchId` so the admin
-- detail endpoint can pivot from the aggregated alert row to its recipient
-- list in one indexed lookup.
--
-- Older alerts written before this migration will have no recipient rows;
-- the detail view degrades to "no per-recipient delivery data on file" for
-- those events.

CREATE TABLE IF NOT EXISTS connector_alert_recipients (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Not a foreign key because the underlying integration row may be deleted
  -- after the alert was sent, and we still want the audit trail to survive.
  integration_id VARCHAR NOT NULL,
  dispatch_id VARCHAR(64) NOT NULL,
  -- Mirrors `tenant_notifications.type` ('integration' or 'integration_sms')
  -- so the detail endpoint can match an alert event to its recipient list.
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ON DELETE SET NULL so deactivating a user doesn't erase the audit trail.
  user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  recipient_name TEXT,
  recipient_email TEXT,
  recipient_phone TEXT,
  -- 'sent', 'failed', 'skipped' (e.g. Twilio not configured in env)
  delivery_status TEXT NOT NULL,
  delivery_error TEXT,
  -- HTTP status returned by Twilio for SMS sends (null for email rows or
  -- Twilio-not-configured rows).
  twilio_status_code INTEGER
);

-- Primary lookup path: detail endpoint joins from alert -> recipient list
-- via dispatch_id, scoped to the requesting tenant for isolation.
CREATE INDEX IF NOT EXISTS idx_connector_alert_recipients_dispatch
  ON connector_alert_recipients(tenant_id, dispatch_id);

-- Fallback path for diagnostic queries that filter by integration over time.
CREATE INDEX IF NOT EXISTS idx_connector_alert_recipients_integration
  ON connector_alert_recipients(tenant_id, integration_id, dispatched_at DESC);
