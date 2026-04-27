-- 080: Mobile push device registry
--
-- Stores Expo push tokens reported by the technician mobile app so the
-- server can fan-out notifications when a dispatch job is assigned, the
-- job's status moves to en_route / on_site, or a booking is rescheduled
-- into the technician's day.
--
-- Tokens are scoped per (tenant_id, push_token) so reinstalling the app
-- with a new token simply inserts another row, while the same physical
-- device handing back the same token is idempotently upserted.
--
-- Why a per-device `push_enabled` flag (not just the per-user
-- preferences in user_notification_preferences):
--   - Mobile callers authenticate with a tenant-scoped API key, so we
--     do not always have a real `users.id` to attach a preference to.
--   - The toggle in the Profile tab is meant to silence pushes on THIS
--     device (e.g. shared truck phone), which is what `push_enabled`
--     models. A separate per-user preference can layer on top later if
--     we ever wire the mobile app to a JWT session.
CREATE TABLE IF NOT EXISTS user_devices (
  id            VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id   VARCHAR(255) REFERENCES dispatch_resources(id) ON DELETE CASCADE,
  user_id       VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
  push_token    TEXT NOT NULL,
  platform      VARCHAR(16) NOT NULL DEFAULT 'expo',
  push_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  device_label  TEXT NOT NULL DEFAULT '',
  app_version   VARCHAR(64) NOT NULL DEFAULT '',
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, push_token)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_resource
  ON user_devices(tenant_id, resource_id) WHERE push_enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_devices_user
  ON user_devices(tenant_id, user_id) WHERE push_enabled = TRUE;
