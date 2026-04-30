-- Live email-provider delivery tracking for connector outage alerts.
-- Sibling to migration 099 (Twilio statusCallback). The new
-- POST /connectors/email-status webhook resolves a recipient row by
-- email_message_id and updates email_provider_event + delivery_status so
-- the admin detail panel's Live indicator works for email alerts too.
-- delivery_status_updated_at is reused from migration 099.

ALTER TABLE connector_alert_recipients
  ADD COLUMN IF NOT EXISTS email_message_id VARCHAR(512),
  ADD COLUMN IF NOT EXISTS email_provider_event TEXT;

-- Unique partial index: webhook lookup key, also guards against
-- accidental duplicate inserts of the same Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_alert_recipients_email_msgid
  ON connector_alert_recipients(email_message_id)
  WHERE email_message_id IS NOT NULL;
