/**
 * Signup CAPTCHA config helpers.
 *
 * The backend requires a Turnstile token whenever `TURNSTILE_SECRET_KEY` is
 * set. The widget can only render when a *public* site key is available —
 * either baked in at build time (`VITE_TURNSTILE_SITE_KEY`) or served at
 * runtime by `GET /auth/signup-config` (`TURNSTILE_SITE_KEY`).
 *
 * Production (`APP_ENV=production|staging`) already refuses to boot without
 * `TURNSTILE_SECRET_KEY`, so the "no secret → skip CAPTCHA" path is a
 * documented local/dev bypass that cannot ship accidentally.
 */

function readViteEnv(name: string): string {
  return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name] || '').trim();
}

export const BUILD_TIME_TURNSTILE_SITE_KEY = readViteEnv('VITE_TURNSTILE_SITE_KEY');

export const IS_PROD_BUILD = Boolean(
  (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD,
);

export type SignupCaptchaConfig = {
  captchaRequired: boolean;
  siteKey: string;
};

export function parseSignupCaptchaConfig(
  raw: unknown,
  buildTimeSiteKey = BUILD_TIME_TURNSTILE_SITE_KEY,
): SignupCaptchaConfig {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const remoteKey = typeof obj.siteKey === 'string' ? obj.siteKey.trim() : '';
  return {
    captchaRequired: obj.captchaRequired === true,
    siteKey: remoteKey || buildTimeSiteKey,
  };
}

/**
 * When `GET /auth/signup-config` cannot be reached:
 * - production builds fail closed (treat captcha as required)
 * - local/dev/test allow submit without a token (server also skips
 *   verification when `TURNSTILE_SECRET_KEY` is unset)
 */
export function resolveCaptchaConfigAfterFetchFailure(
  buildTimeSiteKey = BUILD_TIME_TURNSTILE_SITE_KEY,
  isProdBuild = IS_PROD_BUILD,
): SignupCaptchaConfig {
  return {
    siteKey: buildTimeSiteKey,
    captchaRequired: Boolean(buildTimeSiteKey) || isProdBuild,
  };
}
