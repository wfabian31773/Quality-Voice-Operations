import { createLogger } from '../core/logger';

const logger = createLogger('TURNSTILE');

/**
 * Default hostnames Cloudflare may return for a token solved on a QVO
 * surface. Override with a comma-separated `TURNSTILE_ALLOWED_HOSTNAMES`
 * list (replaces this default when set).
 */
export const DEFAULT_TURNSTILE_ALLOWED_HOSTNAMES = [
  'qualityvoiceoperations.com',
  'api.qualityvoiceoperations.com',
  'voice.qualityvoiceoperations.com',
] as const;

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

const ERRORS: Record<TurnstileFailureReason, string> = {
  missing_token: 'CAPTCHA verification is required',
  hostname_mismatch: 'CAPTCHA hostname is not allowed for this form',
  action_mismatch: 'CAPTCHA action does not match this form',
  verification_failed: 'CAPTCHA verification failed. Please try again.',
};

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};

export function turnstileSecret(): string {
  return (process.env.TURNSTILE_SECRET_KEY || '').trim();
}

export function publicTurnstileSiteKey(): string {
  return (process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || '').trim();
}

export function normalizeTurnstileHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

export function parseTurnstileAllowedHostnames(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_TURNSTILE_ALLOWED_HOSTNAMES];
  }
  const hosts = raw
    .split(/[,;]/)
    .map(normalizeTurnstileHostname)
    .filter(Boolean);
  return hosts.length > 0 ? hosts : [...DEFAULT_TURNSTILE_ALLOWED_HOSTNAMES];
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

function fail(reason: TurnstileFailureReason): TurnstileVerifyFailure {
  return { ok: false, status: 400, reason, error: ERRORS[reason] };
}

// Never add the token or secret to this log line.
function reject(
  reason: TurnstileFailureReason,
  expectedAction: string,
  data?: SiteverifyResponse,
): TurnstileVerifyFailure {
  logger.warn('Turnstile verification rejected', {
    reason,
    expectedAction,
    hostname: data?.hostname,
    action: data?.action,
    errorCodes: data?.['error-codes'],
  });
  return fail(reason);
}

/**
 * Verifies a Cloudflare Turnstile token against siteverify, then checks
 * that the returned hostname is on the QVO allow-list and that `action`
 * matches the form that collected the token.
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
    if (!isAllowedTurnstileHostname(data.hostname)) return reject('hostname_mismatch', opts.expectedAction, data);
    if ((data.action ?? '').trim() !== opts.expectedAction) return reject('action_mismatch', opts.expectedAction, data);
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
