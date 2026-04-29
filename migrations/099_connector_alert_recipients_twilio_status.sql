-- Live Twilio delivery tracking for connector outage SMS alerts.
--
-- Migration 094 introduced `connector_alert_recipients` so admins could see
-- which person was paged for an outage and the *initial* HTTP status Twilio
-- returned at dispatch time (twilio_status_code). That tells us whether
-- Twilio accepted the request, but not whether the carrier ultimately
-- delivered the SMS minutes later.
--
-- We now register a statusCallback URL on every outage SMS send. Twilio
-- POSTs back to that URL as the message moves through queued -> sent ->
-- delivered (or undelivered / failed) and the webhook updates the row by
-- looking it up via `twilio_message_sid`. The detail panel polls
-- /connectors/alerts/:alertId so the audit trail stays current.
--
-- Columns:
--   twilio_message_sid          -- Twilio Message SID returned at dispatch.
--                                  Webhook lookup key. Null for skipped /
--                                  Twilio-not-configured rows and for the
--                                  pre-statusCallback alerts written before
--                                  this migration.
--   twilio_message_status       -- Latest Twilio MessageStatus
--                                  (queued, sending, sent, delivered,
--                                  undelivered, failed). Verbatim — the UI
--                                  decides how to badge it.
--   twilio_error_code           -- Twilio carrier-side ErrorCode (e.g.
--                                  30003 unreachable destination). Distinct
--                                  from the existing twilio_status_code
--                                  which captures the HTTP status of the
--                                  initial /Messages.json POST.
--   delivery_status_updated_at  -- When the webhook last touched this row.
--                                  Powers the "Live" indicator on the
--                                  outage detail panel.

ALTER TABLE connector_alert_recipients
  ADD COLUMN IF NOT EXISTS twilio_message_sid VARCHAR(64),
  ADD COLUMN IF NOT EXISTS twilio_message_status TEXT,
  ADD COLUMN IF NOT EXISTS twilio_error_code INTEGER,
  ADD COLUMN IF NOT EXISTS delivery_status_updated_at TIMESTAMPTZ;

-- Webhook lookup: Twilio POSTs the MessageSid; we resolve a single recipient
-- row from it. SIDs are globally unique within an account, so a unique
-- partial index doubles as a guard against accidental duplicate inserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_alert_recipients_twilio_sid
  ON connector_alert_recipients(twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;
