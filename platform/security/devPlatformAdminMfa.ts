import { encryptTotpSecret } from './TotpMfa';

/**
 * Well-known TOTP seed for development / CI platform-admin fixtures.
 * Production accounts must enroll a unique authenticator; this value is
 * only written by `scripts/seed-admin.ts` (which refuses to run outside
 * APP_ENV=development).
 */
export const DEV_PLATFORM_ADMIN_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export function encryptedDevPlatformAdminMfaSecret(): string {
  return encryptTotpSecret(DEV_PLATFORM_ADMIN_MFA_SECRET);
}
