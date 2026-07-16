import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'migrations/118_platform_admin_mfa.sql'),
  'utf8',
);
const preflight = readFileSync(
  join(process.cwd(), 'platform/compliance/HealthcareDataControlPreflight.ts'),
  'utf8',
);

describe('platform-admin MFA migration', () => {
  it('adds encrypted pending and enabled TOTP state without plaintext seed columns', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS mfa_totp_secret_encrypted TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS mfa_pending_totp_secret_encrypted TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS mfa_pending_expires_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ/i);
    expect(migration).not.toMatch(/mfa_(?:totp_)?secret\s+(?:TEXT|VARCHAR)/i);
  });

  it('tracks one-time recovery material, replay state, lockout, and verification time', () => {
    expect(migration).toMatch(/mfa_recovery_code_hashes TEXT\[\][^;]+NOT NULL[^;]+DEFAULT/i);
    expect(migration).toMatch(/mfa_last_totp_step BIGINT/i);
    expect(migration).toMatch(/mfa_failed_attempts INTEGER[^;]+NOT NULL[^;]+DEFAULT 0/i);
    expect(migration).toMatch(/mfa_locked_until TIMESTAMPTZ/i);
    expect(migration).toMatch(/mfa_last_verified_at TIMESTAMPTZ/i);
  });

  it('enforces internally consistent MFA state', () => {
    expect(migration).toMatch(/mfa_failed_attempts >= 0/i);
    expect(migration).toMatch(/mfa_enabled_at IS NULL[\s\S]*mfa_totp_secret_encrypted IS NULL/i);
    expect(migration).toMatch(/mfa_enabled_at IS NOT NULL[\s\S]*mfa_totp_secret_encrypted IS NOT NULL/i);
  });

  it('makes privileged MFA state an explicit healthcare-readiness prerequisite', () => {
    expect(preflight).toContain("'118_platform_admin_mfa.sql'");
  });
});
