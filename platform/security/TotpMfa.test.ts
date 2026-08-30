import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotpStep,
  totpAt,
  verifyRecoveryCode,
  verifyTotp,
} from './TotpMfa';
import { DEV_PLATFORM_ADMIN_MFA_SECRET, encryptedDevPlatformAdminMfaSecret } from './devPlatformAdminMfa';

const ORIGINAL_ENV = { ...process.env };

describe('TOTP MFA primitives', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'test-only-mfa-master-key-with-at-least-32-characters';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(secret, 59_000, { digits: 8 })).toBe('94287082');
  });

  it('encrypts the development platform-admin MFA seed with the same key material the login challenge uses', () => {
    expect(totpAt(DEV_PLATFORM_ADMIN_MFA_SECRET)).toMatch(/^\d{6}$/);
    expect(decryptTotpSecret(encryptedDevPlatformAdminMfaSecret())).toBe(DEV_PLATFORM_ADMIN_MFA_SECRET);
  });

  it('accepts only a bounded adjacent time step', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1_700_000_000_000;
    const previous = totpAt(secret, now - 30_000);
    const current = totpAt(secret, now);
    const tooOld = totpAt(secret, now - 60_000);

    expect(verifyTotp(secret, previous, now)).toBe(true);
    expect(verifyTotp(secret, current, now)).toBe(true);
    expect(verifyTotp(secret, tooOld, now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, 'not-a-code', now)).toBe(false);
    expect(matchTotpStep(secret, current, now)).toBe(BigInt(Math.floor(now / 30_000)));
    expect(matchTotpStep(secret, tooOld, now)).toBeNull();
  });

  it('generates a strong base32 secret without padding', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('encrypts the seed with authenticated encryption and rejects tampering', () => {
    const secret = generateTotpSecret();
    const ciphertext = encryptTotpSecret(secret);

    expect(ciphertext).not.toContain(secret);
    expect(decryptTotpSecret(ciphertext)).toBe(secret);

    const tampered = `${ciphertext.slice(0, -2)}AA`;
    expect(() => decryptTotpSecret(tampered)).toThrow();
  });

  it('fails closed without a production encryption key', () => {
    process.env.APP_ENV = 'production';
    delete process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    expect(() => encryptTotpSecret(generateTotpSecret())).toThrow(/ENCRYPTION_MASTER_KEY/);

    process.env.ENCRYPTION_MASTER_KEY = 'too-short';
    expect(() => encryptTotpSecret(generateTotpSecret())).toThrow(/at least 32/);
  });
});

describe('MFA recovery codes', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'test-only-mfa-master-key-with-at-least-32-characters';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('creates ten unique high-entropy one-time codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code))).toBe(true);
  });

  it('hashes codes with a server-side pepper and compares in constant-time form', () => {
    const [code] = generateRecoveryCodes();
    const hash = hashRecoveryCode(code);

    expect(hash).not.toContain(code);
    expect(verifyRecoveryCode(code.toLowerCase(), hash)).toBe(true);
    expect(verifyRecoveryCode('WRONG-CODE', hash)).toBe(false);
  });
});
