/**
 * One-click unsubscribe sink helpers for support emails.
 *
 * Recipients of support replies (initial ticket ack, ops replies on a ticket,
 * docs-feedback replies, and any auto-retry of those) need a way to opt out
 * without authenticating to the platform. We can't use a session — the
 * recipient may not have an account at all — so the link carries an
 * HMAC-signed token derived from the lowercased recipient address. The
 * server re-derives the token from the (untrusted) email in the request and
 * compares constant-time. A valid hit lands a row in
 * `support_email_unsubscribes`, which the existing send-side gate
 * (`checkSupportEmailSkip`) already honours and stamps as
 * `recipient_unsubscribed` on the reply row.
 *
 * Why HMAC and not a random per-send token stored in DB?
 *   - Address-scoped: an unsubscribe applies to ALL future support emails to
 *     that address, not just the one ticket the link came from. A
 *     per-send-token table would still need a final lookup keyed on the
 *     address, so we'd be paying storage for nothing.
 *   - Stateless: tokens stay valid for the lifetime of the secret, so a
 *     recipient who opens a year-old support email can still unsubscribe.
 *   - No DB write at send time: the alternative would mean every outbound
 *     reply (including silent auto-retries) inserts a row up-front.
 *
 * RFC 8058 (one-click unsubscribe) requires the URL the `List-Unsubscribe`
 * header points at to accept an HTTPS POST whose body is exactly
 * `List-Unsubscribe=One-Click` and to perform the action without further
 * confirmation. The landing-page GET is a separate, friendlier flow for
 * recipients who click the visible footer link in the email body.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../core/logger';

const logger = createLogger('SUPPORT_UNSUBSCRIBE_TOKEN');

// Stable dev fallback so unit tests and local dev can mint tokens without
// extra setup. Production MUST set SUPPORT_UNSUBSCRIBE_SECRET — if it isn't
// set, every restart would otherwise invalidate every previously-mailed
// link. We log loudly when falling back so the absence is visible in logs.
const DEV_FALLBACK_SECRET = 'support-unsubscribe-dev-secret-change-me';
let warnedAboutFallback = false;

function getSecret(): string {
  const explicit = process.env.SUPPORT_UNSUBSCRIBE_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  if (process.env.NODE_ENV === 'production' && !warnedAboutFallback) {
    warnedAboutFallback = true;
    logger.error(
      'SUPPORT_UNSUBSCRIBE_SECRET is not set in production — falling back to a dev secret. ' +
      'Existing unsubscribe links will keep working, but rotate this fallback before relying on it.',
    );
  }
  return DEV_FALLBACK_SECRET;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Mint a token for `email`. Token is the hex HMAC-SHA256 of the lowercased
 * address, truncated to 32 hex chars (~128 bits) — long enough to make
 * brute force infeasible without bloating the URL.
 */
export function buildSupportUnsubscribeToken(email: string): string {
  const normalized = normalizeEmail(email);
  const mac = createHmac('sha256', getSecret()).update(normalized).digest('hex');
  return mac.slice(0, 32);
}

/**
 * Constant-time verification of a token against the (untrusted) email in
 * the request. Returns false on any mismatch, blank input, or length
 * surprise — never throws.
 */
export function verifySupportUnsubscribeToken(
  email: string | null | undefined,
  token: string | null | undefined,
): boolean {
  if (!email || !token) return false;
  const expected = buildSupportUnsubscribeToken(email);
  // Token comes in over the wire — defend against a caller passing a longer
  // / shorter buffer that would otherwise throw inside timingSafeEqual.
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

/**
 * Resolve the public origin used to build absolute unsubscribe links. We
 * prefer an explicit `SUPPORT_PUBLIC_BASE_URL` so ops can pin the canonical
 * customer-facing host, and fall back through the same env vars we use
 * elsewhere for outbound URLs (matches the inbound-webhook docs that point
 * at https://app.qvo.ai/api/admin/...).
 */
function getPublicBaseUrl(): string {
  const candidates = [
    process.env.SUPPORT_PUBLIC_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.APP_BASE_URL,
    process.env.ADMIN_API_BASE_URL,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : undefined,
  ];
  for (const c of candidates) {
    if (c && c.length > 0) return c.replace(/\/+$/, '');
  }
  return 'https://app.qvo.ai';
}

/**
 * Absolute HTTPS URL the recipient (or the receiving MUA) hits to opt out.
 * Same path is used by the GET landing page and the RFC-8058 one-click POST.
 */
export function buildSupportUnsubscribeUrl(email: string): string {
  const token = buildSupportUnsubscribeToken(email);
  const e = encodeURIComponent(normalizeEmail(email));
  return `${getPublicBaseUrl()}/api/admin/support/unsubscribe?e=${e}&t=${token}`;
}

/**
 * mailto: target the receiving MUA can hit when one-click HTTPS isn't
 * available. The body is a no-op — Gmail and friends just need the
 * presence of a mailto entry to render the unsubscribe affordance, and the
 * inbound-parse hook on `unsubscribe@...` writes the suppression itself.
 *
 * Defaults to `unsubscribe@<EMAIL_FROM domain>` so the address always
 * lands on the same domain we sent from (avoids DMARC alignment surprises).
 */
function getMailtoTarget(): string {
  const explicit = process.env.SUPPORT_UNSUBSCRIBE_MAILTO;
  if (explicit && explicit.length > 0) return explicit;
  const from = process.env.EMAIL_FROM ?? 'noreply@qualityvoiceops.com';
  const at = from.indexOf('@');
  const domain = at >= 0 ? from.slice(at + 1) : 'qualityvoiceops.com';
  return `unsubscribe@${domain}`;
}

/**
 * Headers to attach to outbound support emails so MUAs surface the
 * unsubscribe affordance in their UI and one-click providers (Gmail,
 * Outlook) can submit the opt-out without a round-trip to the recipient.
 *
 *   List-Unsubscribe: <mailto:unsubscribe@…>, <https://…/api/admin/support/unsubscribe?…>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click   ← RFC 8058
 *
 * Per RFC 8058 the POST URL must be HTTPS; we rely on the resolver above
 * to produce an https:// origin. The mailto entry is listed first so MUAs
 * that can only handle the legacy form still work.
 */
export function buildSupportUnsubscribeEmailHeaders(
  email: string,
): Record<string, string> {
  const httpsUrl = buildSupportUnsubscribeUrl(email);
  const mailto = getMailtoTarget();
  return {
    'List-Unsubscribe': `<mailto:${mailto}?subject=unsubscribe>, <${httpsUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * Visible footer link the recipient can click in a rendering MUA. Returned
 * as `{ html, text }` so callers can splice it into the email body without
 * re-implementing the URL.
 */
export function buildSupportUnsubscribeFooter(
  email: string,
): { html: string; text: string } {
  const url = buildSupportUnsubscribeUrl(email);
  const html =
    `<p style="color:#94a3b8;font-size:11px;margin:16px 0 0">` +
    `Don\u2019t want these emails? ` +
    `<a href="${url}" style="color:#64748b;text-decoration:underline">Unsubscribe</a>.` +
    `</p>`;
  const text = `\n\nDon\u2019t want these emails? Unsubscribe: ${url}`;
  return { html, text };
}
