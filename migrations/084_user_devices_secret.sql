-- 084_user_devices_secret.sql
--
-- Caller→resource binding for the mobile location ingest endpoint.
--
-- Why this exists:
--   The mobile app authenticates with a tenant-wide API key (`vai_*`).
--   That alone cannot identify *which* technician is calling, so the new
--   POST /api/v1/dispatch/resources/:id/location endpoint had no way to
--   stop a malicious tech from posting another coworker's resource_id.
--
-- The fix:
--   When a device registers it now also receives a per-device secret
--   (one-time disclosed). We store only the SHA-256 hash. Subsequent
--   writes to the location endpoint must include the secret in the
--   `X-Device-Secret` header. The server hashes the header value and
--   looks up the matching `user_devices` row, then verifies that
--   row's `resource_id` equals the URL `:id` parameter. The secret is
--   sourced from `crypto.randomBytes(32)` server-side, so brute force
--   is infeasible.
--
-- The column is nullable for back-compat with already-registered
-- devices. The location endpoint requires the header, so existing
-- devices simply re-register on first run after upgrade and obtain
-- a fresh secret.

ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS device_secret_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_user_devices_secret_hash
  ON user_devices (device_secret_hash)
  WHERE device_secret_hash IS NOT NULL;

COMMENT ON COLUMN user_devices.device_secret_hash IS
  'SHA-256 hex hash of the device-issued secret used to bind mobile location pings to a single resource_id (see migration 084).';
