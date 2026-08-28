/**
 * Centralised production-hardening helpers for the admin API (BL-011 / S-?).
 *
 * Everything here keys off `APP_ENV` rather than `NODE_ENV` so that we get
 * deterministic behaviour even when the host platform sets `NODE_ENV=production`
 * for tooling reasons (e.g. Vite, supertest harnesses) but we are actually
 * running a development server.
 *
 * - JWT: signing/verification is pinned to HS256 in `auth.ts` so an attacker
 *   cannot smuggle in a `none` or asymmetric token.
 * - Cookies: `auth_token` is always `HttpOnly`; `Secure` is set in
 *   production/staging only so dev cookies still work over plain HTTP.
 * - CORS: in production the allow-list is read from `ALLOWED_ORIGINS`; any
 *   request from an unknown origin is rejected. In development we allow any
 *   origin so local tooling and the Replit preview iframe still work.
 * - Frame guards: `X-Frame-Options` is `DENY` in production, `SAMEORIGIN` in
 *   dev so the Replit preview iframe (same origin) keeps rendering.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { CookieOptions } from 'express';
import type { CorsOptions } from 'cors';

const PRODUCTION_LIKE_ENVS = new Set(['production', 'staging']);

/** Cloudflare's documented always-pass / always-fail / already-spent dummy secrets. */
const CLOUDFLARE_TURNSTILE_DUMMY_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export function isProductionLike(): boolean {
  const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
  if (appEnv) return PRODUCTION_LIKE_ENVS.has(appEnv);
  // Fallback to NODE_ENV only when APP_ENV is genuinely unset, so legacy
  // callers continue to work but `APP_ENV` always wins when both are set.
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return PRODUCTION_LIKE_ENVS.has(nodeEnv);
}

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 600 * 1000;

/**
 * Returns the canonical options for the `auth_token` session cookie.
 *
 * `secure: true` is required by browsers when `SameSite=None`, but we use
 * `SameSite=Lax` so it is purely for transport security in production. In
 * dev we leave `secure` off so the cookie works over HTTP on localhost and
 * the Replit dev preview.
 */
export function authCookieOptions(overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isProductionLike(),
    sameSite: 'lax',
    path: '/',
    maxAge: EIGHT_HOURS_MS,
    ...overrides,
  };
}

/**
 * Returns the canonical options for the per-provider OAuth `state` cookie used
 * by `connectorOAuth.ts` (BL-027).
 *
 * The `state` query parameter is also HMAC-signed, but we bind it to a cookie
 * for defense-in-depth per RFC 9700 §4.7 (OAuth 2.0 Security BCP). The
 * callback verifies the cookie equals the `state` query param before doing the
 * token exchange, which means a `state` value leaked via referer / browser
 * history / server logs cannot be replayed without the user's cookie jar.
 *
 * Attributes (all four are required for BL-027):
 * - `HttpOnly`: blocks JS reads (defense vs XSS exfil).
 * - `Secure`: HTTPS-only in prod-like envs (cleared in dev so localhost still
 *   works over plain HTTP).
 * - `SameSite=Lax`: still sent on the top-level OAuth-provider redirect back
 *   to our callback, but blocked from cross-site sub-requests.
 * - `Max-Age=600s`: matches the 600s age check in `verifyState`.
 *
 * `path: '/connectors/oauth'` scopes the cookie so it is only sent to the
 * OAuth init/callback routes and never leaks onto unrelated endpoints.
 */
export function oauthStateCookieOptions(overrides: Partial<CookieOptions> = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: isProductionLike(),
    sameSite: 'lax',
    path: '/connectors/oauth',
    maxAge: OAUTH_STATE_TTL_MS,
    ...overrides,
  };
}

/**
 * Parses the `ALLOWED_ORIGINS` env var into a normalised set. Accepts a
 * comma-separated list. Trailing slashes are trimmed so operators don't have
 * to worry about exact formatting.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim().replace(/\/$/, '');
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/**
 * Builds CORS options that:
 *   - In dev: reflect the request `Origin` (so any local tool / preview works).
 *   - In prod: only reflect origins listed in `ALLOWED_ORIGINS`. Unknown
 *     origins receive a CORS error (the request still hits the route, but the
 *     browser will block reading the response and discard the credentials).
 *   - Always allows requests with no `Origin` header (server-to-server,
 *     curl, Twilio webhooks) — the `cors` package would otherwise reject them.
 *
 * The allow-list is captured at module load time so the function can be
 * called repeatedly without re-parsing. Tests reset it via the
 * `__resetAllowedOriginsForTests` hook.
 */
let cachedAllowedOrigins: Set<string> | null = null;

function getAllowedOrigins(): Set<string> {
  if (cachedAllowedOrigins === null) {
    cachedAllowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  }
  return cachedAllowedOrigins;
}

export function __resetAllowedOriginsForTests(): void {
  cachedAllowedOrigins = null;
}

export function corsOptions(): CorsOptions {
  if (!isProductionLike()) {
    return { origin: true, credentials: true };
  }
  return {
    origin(requestOrigin, callback) {
      if (!requestOrigin) {
        // No Origin header: server-to-server, curl, Twilio. Allow.
        callback(null, true);
        return;
      }
      const normalised = requestOrigin.replace(/\/$/, '');
      const allowed = getAllowedOrigins();
      if (allowed.has(normalised)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${requestOrigin} not allowed by CORS`));
    },
    credentials: true,
  };
}

/**
 * Adds the baseline security headers on every admin-api response.
 *
 *   - `X-Content-Type-Options: nosniff` — always.
 *   - `X-Frame-Options: DENY` in production (no embedding, period).
 *   - `X-Frame-Options: SAMEORIGIN` in dev so the Replit preview iframe
 *     keeps working while the SPA is mounted on the same origin.
 *
 * This is intentionally minimal; full CSP is handled elsewhere.
 */
export function securityHeaders(): RequestHandler {
  const frameOption = isProductionLike() ? 'DENY' : 'SAMEORIGIN';
  return function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', frameOption);
    next();
  };
}

/**
 * Guards production startup. Throws (so the process exits) when a secret
 * that must be configured before serving traffic is missing. Called from
 * `start.ts` in addition to the broader `validate-env` script so the admin
 * API itself fails closed even when launched outside the start script.
 */
export function assertProductionSecrets(): void {
  if (!isProductionLike()) return;
  const required: Array<readonly [string, string]> = [
    ['ADMIN_JWT_SECRET', 'JWT signing secret for admin API auth'],
    ['ALLOWED_ORIGINS', 'comma-separated list of CORS origins allowed in production'],
    ['TURNSTILE_SECRET_KEY', 'Cloudflare Turnstile secret key for sign-up CAPTCHA'],
    [
      'CONNECTOR_EMAIL_WEBHOOK_SECRET',
      'shared secret for /connectors/email-status delivery webhook (SES/Postmark/SendGrid/Mailgun)',
    ],
  ];

  // Defense-in-depth: when the deployment is wired to Calendly (either via the
  // server-readable BOOK_DEMO_SCHEDULER_PROVIDER override or the build-time
  // VITE_BOOK_DEMO_SCHEDULER_PROVIDER fallback), the Calendly webhook verifier
  // must have its signing key configured, otherwise /book-demo/calendly-webhook
  // will return 500 for every signed delivery in production.
  const provider = (
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER ??
    process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER ??
    ''
  )
    .trim()
    .toLowerCase();
  if (provider === 'calendly') {
    required.push([
      'CALENDLY_WEBHOOK_SECRET',
      'HMAC-SHA256 signing key for Calendly /book-demo/calendly-webhook (required because BOOK_DEMO_SCHEDULER_PROVIDER=calendly)',
    ]);
  }

  const missing = required.filter(([name]) => !process.env[name]);

  // Task #995: Surface the connector OAuth state-signing requirement
  // explicitly at boot. `connectorOAuth.ts::getStateSecret()` accepts
  // *either* `ADMIN_JWT_SECRET` or `CONNECTOR_ENCRYPTION_KEY` and fails
  // closed in production-like envs when neither is set (the runtime guard
  // added in Task #621). The `required` list above already demands
  // `ADMIN_JWT_SECRET`, so under normal operation this branch piggybacks
  // on that error — but we add a dedicated message that names *both*
  // candidate vars and points at the OAuth flows specifically so
  // operators understand the blast radius (every tenant clicking
  // "Connect" gets a 500 until this is fixed) without having to grep
  // through the OAuth router.
  const oauthSecretConfigured = !!(
    process.env.ADMIN_JWT_SECRET || process.env.CONNECTOR_ENCRYPTION_KEY
  );

  const errors: string[] = [];
  if (missing.length > 0) {
    const names = missing.map(([name]) => name).join(', ');
    errors.push(`missing required env var(s): ${names}`);
  }
  if (!oauthSecretConfigured) {
    errors.push(
      'connector OAuth state signing requires ADMIN_JWT_SECRET or CONNECTOR_ENCRYPTION_KEY (neither is set; /connectors/oauth/<provider>/init will refuse every tenant request)',
    );
  }

  const turnstileSecret = (process.env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (turnstileSecret && CLOUDFLARE_TURNSTILE_DUMMY_SECRETS.has(turnstileSecret)) {
    errors.push(
      'TURNSTILE_SECRET_KEY is a Cloudflare test/dummy secret; set a real Turnstile secret in production',
    );
  }

  if (errors.length > 0) {
    throw new Error(`Refusing to start admin API in production: ${errors.join('; ')}`);
  }
}
