/**
 * Shared cap for password and MFA attempt limiters.
 *
 * Production/staging stay tight. Local, CI, and e2e share one runner IP
 * and one seeded admin across many specs, so they need headroom.
 */
export function authAttemptRateLimitMax(): number {
  return process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging' ? 10 : 200;
}
