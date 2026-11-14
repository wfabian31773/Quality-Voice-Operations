import { createLogger } from '../core/logger';
import { isRenderRuntime } from '../runtime/processRole';

const logger = createLogger('TURNSTILE');

export const TURNSTILE_ALLOWED_HOSTNAMES_ENV = 'TURNSTILE_ALLOWED_HOSTNAMES';

export const TURNSTILE_ACTIONS = {
  signup: 'signup',
  bookDemo: 'book-demo',
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export type TurnstileFailureReason =
  | 'missing_token'
  | 'hostname_mismatch'
  | 'action_mismatch'
  | 'verification_failed';

export type TurnstileVerifyFailure = {
  ok: false;
  status: 400;
  reason: TurnstileFailureReason;
  error: string;
};

export type TurnstileVerifyResult = { ok: true } | TurnstileVerifyFailure;

/** Same user-facing copy for a failed, mismatched, or unusable CAPTCHA. */
export const TURNSTILE_CAPTCHA_FAILED_ERROR = 'CAPTCHA verification failed. Please try again.';

const ERRORS: Record<TurnstileFailureReason, string> = {
  missing_token: 'CAPTCHA verification is required',
  hostname_mismatch: TURNSTILE_CAPTCHA_FAILED_ERROR,
  action_mismatch: TURNSTILE_CAPTCHA_FAILED_ERROR,
  verification_failed: TURNSTILE_CAPTCHA_FAILED_ERROR,
};

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};

let missingAllowListWarned = false;

export function turnstileSecret(): string {
  return (process.env.TURNSTILE_SECRET_KEY || '').trim();
}

export function publicTurnstileSiteKey(): string {
  return (process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || '').trim();
}

export function normalizeTurnstileHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Parse `TURNSTILE_ALLOWED_HOSTNAMES`. Empty / unset means "do not enforce
 * a hostname allow-list" on local and Replit. On Render, an empty list is
 * treated as a missing control (fail closed). A set value is the full list.
 */
export function parseTurnstileAllowedHostnames(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[,;]/)
    .map(normalizeTurnstileHostname)
    .filter(Boolean);
}

export function allowedTurnstileHostnames(): string[] {
  return parseTurnstileAllowedHostnames(process.env[TURNSTILE_ALLOWED_HOSTNAMES_ENV]);
}

export function isAllowedTurnstileHostname(
  hostname: string | undefined,
  allowed: readonly string[] = allowedTurnstileHostnames(),
): boolean {
  if (!hostname) return false;
  return allowed.includes(normalizeTurnstileHostname(hostname));
}

export function turnstileClientIp(req: {
  ip?: string;
  headers: { [key: string]: string | string[] | undefined };
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? '';
}

/** Test-only: re-arm the one-time missing-allow-list warning. */
export function resetTurnstileHostnameAllowListWarning(): void {
  missingAllowListWarned = false;
}

function warnIfHostnameAllowListUnset(): void {
  if (missingAllowListWarned) return;
  missingAllowListWarned = true;
  logger.warn(
    'TURNSTILE_ALLOWED_HOSTNAMES is unset — skipping hostname allow-list (local/dev). Set a comma-separated list in production so tokens issued for other sites are rejected.',
  );
}

function fail(reason: TurnstileFailureReason): TurnstileVerifyFailure {
  return { ok: false, status: 400, reason, error: ERRORS[reason] };
}

// Never add the token or secret to this log line.
function reject(
  reason: TurnstileFailureReason,
  expectedAction: string,
  data?: SiteverifyResponse,
  extra?: Record<string, unknown>,
): TurnstileVerifyFailure {
  logger.warn('Turnstile verification rejected', {
    reason,
    expectedAction,
    hostname: data?.hostname,
    action: data?.action,
    errorCodes: data?.['error-codes'],
    ...extra,
  });
  return fail(reason);
}

/**
 * Verifies a Cloudflare Turnstile token against siteverify, then checks
 * that the returned `action` matches the form that collected the token.
 * When `TURNSTILE_ALLOWED_HOSTNAMES` is set, also requires `hostname` to
 * be on that comma-separated list. When it is unset on local/Replit,
 * hostname is not checked and a one-time warning is logged. On Render an
 * unset list is rejected (fail closed) so a missing env var cannot accept
 * tokens issued for other sites.
 *
 * When `TURNSTILE_SECRET_KEY` is unset, verification is skipped (local/dev
 * bypass). Production startup requires the secret, so this cannot ship
 * accidentally.
 */
export async function verifyTurnstile(opts: {
  token: string | undefined | null;
  ip: string;
  expectedAction: string;
}): Promise<TurnstileVerifyResult> {
  const secret = turnstileSecret();
  if (!secret) {
    logger.warn('TURNSTILE_SECRET_KEY not configured — skipping CAPTCHA verification');
    return { ok: true };
  }

  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  if (!token) return reject('missing_token', opts.expectedAction);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: opts.ip,
      }),
    });
    const data = (await response.json()) as SiteverifyResponse;
    if (data.success !== true) return reject('verification_failed', opts.expectedAction, data);

    const allowed = allowedTurnstileHostnames();
    if (allowed.length === 0) {
      // Render already has this env on qvo-api. Skipping the check there
      // would silently accept tokens from any hostname.
      if (isRenderRuntime()) {
        return reject('hostname_mismatch', opts.expectedAction, data, {
          hostnameAllowListUnset: true,
        });
      }
      warnIfHostnameAllowListUnset();
    } else if (!isAllowedTurnstileHostname(data.hostname, allowed)) {
      return reject('hostname_mismatch', opts.expectedAction, data);
    }

    if ((data.action ?? '').trim() !== opts.expectedAction) {
      return reject('action_mismatch', opts.expectedAction, data);
    }
    return { ok: true };
  } catch (err) {
    logger.error('Turnstile verification failed', {
      reason: 'verification_failed',
      expectedAction: opts.expectedAction,
      error: String(err),
    });
    return fail('verification_failed');
  }
}
