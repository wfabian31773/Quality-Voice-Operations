-- Per-tenant pause / opt-out flag for the automated encryption reminder
-- nudge (see `platform/security/EncryptionReminderScheduler.ts`).
--
-- The scheduler re-emails the tenant owner every N days (default 14) when
-- a tenant still has zero active encryption keys. Some tenants legitimately
-- cannot turn encryption on yet (regulated migration, paused integration,
-- etc.) and asking platform admins to keep silencing the reminder by hand
-- after every cycle defeats the purpose of automating it. The columns
-- below let an admin park a tenant indefinitely from the Platform
-- Compliance → Encryption tab so the scheduler skips it cleanly while
-- the manual "Send reminder" button on the same tab keeps working
-- (manual sends should always be deliverable — pausing is for the
-- automated cadence only).
--
-- Defaults: paused = FALSE so existing tenants keep receiving the
-- automated nudge once the scheduler ships. The metadata columns
-- (paused_at / paused_by_user_id / paused_reason) are nullable so
-- pre-existing rows don't need a backfill — they're populated the
-- first time an admin toggles the flag.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS encryption_reminder_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS encryption_reminder_paused_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS encryption_reminder_paused_by_user_id VARCHAR NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS encryption_reminder_paused_reason TEXT NULL;

-- The scheduler's hot path is "tenants with zero active keys whose
-- pause flag is false". A partial index keeps that scan tiny once the
-- platform has hundreds of tenants — most of which will eventually be
-- encrypted and excluded by the encryption_keys join, leaving only the
-- still-unencrypted minority needing a paused / not-paused check.
CREATE INDEX IF NOT EXISTS idx_tenants_encryption_reminder_active
  ON tenants(id)
  WHERE encryption_reminder_paused = FALSE;
