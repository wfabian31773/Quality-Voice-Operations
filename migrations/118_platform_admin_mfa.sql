-- Fail-closed MFA state for privileged QVO identities.
-- TOTP seeds are AES-GCM ciphertext produced by the application; plaintext
-- seeds and recovery codes must never be persisted.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_totp_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_totp_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS mfa_pending_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_recovery_code_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS mfa_last_totp_step BIGINT,
  ADD COLUMN IF NOT EXISTS mfa_failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mfa_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_last_verified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_mfa_failed_attempts_nonnegative'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_mfa_failed_attempts_nonnegative
      CHECK (mfa_failed_attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_mfa_enabled_state_consistent'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_mfa_enabled_state_consistent
      CHECK (
        (mfa_enabled_at IS NULL AND mfa_totp_secret_encrypted IS NULL)
        OR
        (mfa_enabled_at IS NOT NULL AND mfa_totp_secret_encrypted IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_mfa_pending_state_consistent'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_mfa_pending_state_consistent
      CHECK (
        (mfa_pending_totp_secret_encrypted IS NULL AND mfa_pending_expires_at IS NULL)
        OR
        (mfa_pending_totp_secret_encrypted IS NOT NULL AND mfa_pending_expires_at IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_platform_admin_mfa
  ON users (is_platform_admin, mfa_enabled_at)
  WHERE is_platform_admin = TRUE;
