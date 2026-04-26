-- Sales alert settings: configure who receives "new demo booking" alerts
-- and which channels (email / slack) are active. Stored in the existing
-- platform_settings key/value table created in 055_production_essentials.sql.
--
-- Default: both channels enabled, recipients/webhook empty so the existing
-- env-var fallbacks (SALES_NOTIFICATION_EMAIL / OPS_SLACK_WEBHOOK_URL)
-- continue to drive routing until an admin overrides them in the UI.

INSERT INTO platform_settings (key, value)
VALUES (
  'sales_alert_settings',
  '{
    "channels": { "email": true, "slack": true },
    "emailRecipients": [],
    "slackWebhookUrl": null,
    "notifyOnNewLead": true,
    "notifyOnBookingCreated": true,
    "notifyOnBookingRescheduled": true,
    "notifyOnBookingCancelled": true
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
