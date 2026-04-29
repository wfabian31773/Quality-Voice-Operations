/**
 * Tenant-scoped, time-limited URL helpers for the customer-facing
 * completion-photo email.
 *
 * When a job transitions to `completed` and has `proof_of_completion`
 * attachments, the dispatch pipeline emails the customer a copy of each
 * photo. The email links must NOT leak raw object-storage URLs (those
 * carry no tenant scope and would survive long after the customer has
 * forgotten about the visit), so each link is an absolute URL pointing at
 * a server-side proxy gated by an HMAC-signed token of
 * `(tenantId, attachmentId, expiresAt)`.
 *
 * Why HMAC + expiry instead of a per-attachment token row in the DB:
 *   - Stateless: no migration to track tokens, no sweeper to expire them.
 *   - Tenant-scoped: the token binds the attachment to the tenant that
 *     issued it, so a forged or copy-pasted attachment id from another
 *     tenant cannot validate.
 *   - Time-limited: expiry is encoded in the token and re-checked on
 *     every download. Default window matches a "send a few days after
 *     the visit" customer expectation; ops can override via env var.
 *   - Constant-time verify: HMAC compare via `timingSafeEqual` so we
 *     never leak bit-by-bit information about the secret.
 *
 * The URL produced here is consumed by
 * `server/admin-api/routes/dispatch.ts:getCompletionPhotoHandler`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../core/logger';

const logger = createLogger('DISPATCH_COMPLETION_PHOTO_TOKEN');

// Stable dev fallback so unit tests and local dev can mint tokens
// without any extra setup. Production MUST set
// DISPATCH_COMPLETION_PHOTO_SECRET — the dev secret is well-known
// and committed to the repo, so quietly using it in production would
// let anyone forge a download URL. The getter therefore THROWS in
// production when the env var is missing, which surfaces as a 500 on
// the first send/verify and prevents minting unsafe tokens.
const DEV_FALLBACK_SECRET = 'dispatch-completion-photo-dev-secret-change-me';

class CompletionPhotoSecretMisconfiguredError extends Error {
  constructor() {
    super(
      'DISPATCH_COMPLETION_PHOTO_SECRET is not set. The dev fallback secret is ' +
      'refused in production to prevent forgeable photo download URLs. Set the ' +
      'env var to a strong random string and redeploy.',
    );
    this.name = 'CompletionPhotoSecretMisconfiguredError';
  }
}

function getSecret(): string {
  const explicit = process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  if (process.env.NODE_ENV === 'production') {
    // Fail closed: never mint or accept a token signed with the
    // committed dev secret in production. The caller's try/catch
    // converts this into a logged error + 500 (mint path) or a
    // simple "false" verify (since verify already wraps with try/
    // catch in our handler).
    logger.error(
      'DISPATCH_COMPLETION_PHOTO_SECRET is not set in production — refusing to use the dev fallback.',
    );
    throw new CompletionPhotoSecretMisconfiguredError();
  }
  return DEV_FALLBACK_SECRET;
}

// Default window for a freshly-minted link. 14 days matches the
// customer-facing booking-tracker grace window — long enough that a
// customer can revisit the email a couple of days after the visit,
// short enough that a stale forwarded link doesn't expose photos
// indefinitely. Configurable via env so an enterprise tenant can
// tighten it without a code change.
const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60;

export function getCompletionPhotoTokenTtlSeconds(): number {
  const raw = process.env.DISPATCH_COMPLETION_PHOTO_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_TTL_SECONDS;
  }
  // Cap at 90 days so a misconfigured env var can never produce an
  // effectively-immortal link.
  return Math.min(n, 90 * 24 * 60 * 60);
}

function signaturePayload(
  tenantId: string,
  attachmentId: string,
  expiresAtSec: number,
): string {
  // Pipe-delimited and field-prefixed so a future format bump can be
  // detected and rejected cleanly. The leading `v1|` lets us roll a
  // new HMAC scheme without invalidating in-flight links if we ever
  // need to (we'd accept both during the rollover).
  return `v1|${tenantId}|${attachmentId}|${expiresAtSec}`;
}

function computeMac(
  tenantId: string,
  attachmentId: string,
  expiresAtSec: number,
): string {
  return createHmac('sha256', getSecret())
    .update(signaturePayload(tenantId, attachmentId, expiresAtSec))
    .digest('hex')
    .slice(0, 32); // 128 bits — well past brute-force reach.
}

function tryComputeMac(
  tenantId: string,
  attachmentId: string,
  expiresAtSec: number,
): string | null {
  try {
    return computeMac(tenantId, attachmentId, expiresAtSec);
  } catch {
    // getSecret() throws in production when the secret is unset; the
    // verify path must degrade to "deny" rather than 500, since the
    // handler converts our `false` return into a clean 404. The mint
    // path keeps the throw because we want loud failure when the
    // platform tries to send an email it can't safely sign.
    return null;
  }
}

export interface CompletionPhotoTokenParts {
  /** Unix seconds at which the token stops being valid. */
  expiresAtSec: number;
  /** HMAC-SHA256 over `(v1|tenantId|attachmentId|expiresAtSec)`. */
  signature: string;
}

/**
 * Mint the (signature, expiry) pair for a single attachment. Callers
 * stitch them into a URL via {@link buildCompletionPhotoUrl}.
 */
export function buildCompletionPhotoToken(params: {
  tenantId: string;
  attachmentId: string;
  /** Optional override for testing or per-tenant tightening. */
  ttlSeconds?: number;
  /** Optional fixed `now` for unit-test determinism. */
  nowMs?: number;
}): CompletionPhotoTokenParts {
  const ttl = params.ttlSeconds ?? getCompletionPhotoTokenTtlSeconds();
  const now = params.nowMs ?? Date.now();
  const expiresAtSec = Math.floor(now / 1000) + ttl;
  const signature = computeMac(params.tenantId, params.attachmentId, expiresAtSec);
  return { expiresAtSec, signature };
}

/**
 * Constant-time verification of a token against the (untrusted)
 * `(tenantId, attachmentId)` pair the server resolved from the URL.
 * Returns false on any mismatch, expired token, blank input, or
 * length surprise — never throws.
 */
export function verifyCompletionPhotoToken(params: {
  tenantId: string | null | undefined;
  attachmentId: string | null | undefined;
  expiresAtSec: number | null | undefined;
  signature: string | null | undefined;
  /** Optional fixed `now` for unit-test determinism. */
  nowMs?: number;
}): boolean {
  if (!params.tenantId || !params.attachmentId) return false;
  if (!params.signature || typeof params.signature !== 'string') return false;
  if (
    params.expiresAtSec == null
    || !Number.isFinite(params.expiresAtSec)
    || !Number.isInteger(params.expiresAtSec)
  ) {
    return false;
  }
  const now = params.nowMs ?? Date.now();
  if (params.expiresAtSec * 1000 < now) return false;
  const expected = tryComputeMac(
    params.tenantId,
    params.attachmentId,
    params.expiresAtSec,
  );
  if (expected === null) return false;
  if (params.signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(params.signature),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute base URL we should embed in outbound emails.
 * Mirrors the `dispatchAppBaseUrl` resolver in
 * `server/admin-api/routes/dispatch.ts` so dev / preview / prod all
 * produce a tappable absolute URL even when the platform is behind
 * the Replit preview proxy.
 *
 * Defined here rather than imported to keep this module free of
 * server-only dependencies — the email-build path runs from the
 * dispatch route, but the token helpers themselves are pure utility
 * code that we want to be testable without spinning up Express.
 */
function dispatchAppBaseUrl(): string {
  const base =
    process.env.APP_URL
    ?? (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5173');
  return base.replace(/\/+$/, '');
}

/**
 * Build the absolute, tenant-scoped, time-limited URL the customer's
 * email client (or browser) hits to fetch a single completion photo.
 *
 * Shape: `https://<host>/api/admin/dispatch/completion-photos/<attachmentId>?t=<sig>&exp=<unixSec>&tid=<tenantId>`
 *
 * The tenant id rides in the URL so the verification path doesn't
 * need a session — the HMAC binds all three fields together, so a
 * caller cannot swap `tid` to another tenant without invalidating
 * the signature.
 */
export function buildCompletionPhotoUrl(params: {
  tenantId: string;
  attachmentId: string;
  ttlSeconds?: number;
  nowMs?: number;
}): { url: string; expiresAtSec: number } {
  const { signature, expiresAtSec } = buildCompletionPhotoToken(params);
  const tid = encodeURIComponent(params.tenantId);
  const aid = encodeURIComponent(params.attachmentId);
  const url = `${dispatchAppBaseUrl()}/api/admin/dispatch/completion-photos/${aid}`
    + `?t=${signature}&exp=${expiresAtSec}&tid=${tid}`;
  return { url, expiresAtSec };
}
