-- Demo scheduler settings: provider, embed URL, and (encrypted) webhook
-- secrets for the public /book-demo page.
--
-- Stored under platform_settings (created in 055_production_essentials.sql)
-- so the same key/value JSON pattern used by maintenance_mode and
-- sales_alert_settings applies. The secret fields are AES-256-GCM encrypted
-- by the admin API service before being written, so reading the row directly
-- never leaks the plaintext key.
--
-- Default: provider 'cal.com' + the previous build-time embed URL fallback,
-- and both webhook secrets unset so the env-driven path
-- (CALCOM_WEBHOOK_SECRET / CALENDLY_WEBHOOK_SECRET) keeps working until an
-- admin overrides it from the UI.

INSERT INTO platform_settings (key, value)
VALUES (
  'demo_scheduler',
  '{
    "provider": "cal.com",
    "embedUrl": "https://cal.com/qvo/30min",
    "calcomWebhookSecretEncrypted": null,
    "calendlyWebhookSecretEncrypted": null
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
