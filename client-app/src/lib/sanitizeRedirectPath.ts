/**
 * Strip sensitive query parameters (and the URL fragment) out of a relative
 * SPA path before we hand it to `/login?redirectTo=…`.
 *
 * Background:
 *   `ProtectedRoute` preserves `pathname + search + hash` so we can return
 *   the user to where they were headed after they sign in. The trade-off is
 *   that whatever was in the query string ends up encoded inside the login
 *   URL, which then commonly leaks via:
 *     - server access logs (`/login?redirectTo=…` shows up in plain text)
 *     - the `Referer` header on outbound CSS/font/image loads from the
 *       login page (third-party origins see the full login URL)
 *     - analytics/RUM events that capture `location.href`
 *
 *   So the login URL is roughly the worst place to stash anything that
 *   resembles a secret. This filter is a low-effort hardening pass that
 *   drops the obvious offenders before the redirectTo is built.
 *
 * Strategy:
 *   1. Drop the URL fragment unconditionally. Fragments aren't useful for
 *      "return the user where they were" routing in our app, and they DO
 *      end up in the login URL's query string after `encodeURIComponent`,
 *      so they suffer the same logging/Referer exposure as the rest.
 *   2. Drop any query parameter whose KEY matches a known-sensitive name
 *      (token, code, secret, password, otp, email, session, …).
 *   3. Drop any query parameter whose VALUE looks token-shaped, code-shaped,
 *      or email-shaped — even if the key is something innocuous like `q`
 *      or `filter`. This catches accidental copy-paste of credentials into
 *      a search box, magic-link codes that came in via a different param
 *      name, etc.
 *
 * Anything we don't recognize as sensitive is preserved as-is so that
 * legitimate UX state (`?tab=calls`, `?page=2`, `?filter=open`) survives
 * the round trip through login.
 *
 * NOTE: pure function, no DOM dependencies, so it can be unit-tested under
 * Vitest without a browser environment.
 */

/**
 * Case-insensitive substring/word patterns for query keys we never want to
 * forward through `/login?redirectTo=…`. We match generously — better to
 * drop a benign `?bookmark_token=…` than to leak a real one.
 */
const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /api[_-]?key/i,
  /\bkey\b/i,
  /\bauth\b/i,
  /authorization/i,
  /bearer/i,
  /session/i,
  /\bsid\b/i,
  /\bcode\b/i,
  /\botp\b/i,
  /\bnonce\b/i,
  /\bstate\b/i,
  /signature/i,
  /\bsig\b/i,
  /verification/i,
  /\bverify\b/i,
  /email/i,
  /\bjwt\b/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
}

/**
 * A "token-shaped" value is a long opaque string with no human-meaningful
 * punctuation — typical of JWTs, opaque session IDs, base64 / base64url
 * blobs, hex digests, etc. We deliberately set the bar high (>= 20 chars)
 * to avoid clobbering legitimate slugs / UUIDs that callers may want to
 * preserve.
 *
 * Note: a UUID like `550e8400-e29b-41d4-a716-446655440000` will match the
 * token-shaped rule (length 36, only hex+`-`). We treat that as the
 * conservative choice — UUIDs are commonly used as bearer-style tokens
 * (one-time invite IDs, magic-link IDs, share tokens), and the cost of
 * dropping one from `?orderId=…` is far smaller than the cost of leaking
 * one from `?inviteToken=…` that happened to be passed under an innocuous
 * key name.
 */
function looksTokenShaped(value: string): boolean {
  if (value.length < 20) return false;
  // JWT (three base64url segments separated by `.`).
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return true;
  }
  // Hex / base64 / base64url / UUID — anything that's purely opaque chars.
  if (/^[A-Za-z0-9_+/=-]{20,}$/.test(value)) {
    return true;
  }
  return false;
}

/**
 * A "code-shaped" value is a short numeric or alphanumeric one-time code
 * — 4–10 digit OTPs, 6–10 char alphanumeric magic-link codes, etc.
 * Anything with internal punctuation other than `-` is left alone.
 */
function looksCodeShaped(value: string): boolean {
  // Numeric OTPs (4–10 digits is the typical range).
  if (/^\d{4,10}$/.test(value)) return true;
  // Short uppercase / mixed alphanumeric codes (e.g. `ABC123`, `7K9-XQ2P`).
  if (/^[A-Za-z0-9]{6,10}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) {
    return true;
  }
  return false;
}

/**
 * An "email-shaped" value is anything that looks like a real email address.
 * We use a simple `local@domain.tld` heuristic — not RFC 5322, just enough
 * to catch the common case.
 */
function looksEmailShaped(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isSensitiveValue(value: string): boolean {
  if (value.length === 0) return false;
  return looksTokenShaped(value) || looksCodeShaped(value) || looksEmailShaped(value);
}

/**
 * Sanitize a relative SPA path for safe inclusion in `?redirectTo=…`.
 *
 * Input is expected to already be a same-origin relative path — callers
 * (e.g. `ProtectedRoute`) are responsible for that check; this function
 * only filters the query string and strips the fragment.
 */
export function sanitizeRedirectPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return path;

  // Drop the fragment unconditionally — see file-level comment.
  const hashIdx = path.indexOf('#');
  const noHash = hashIdx >= 0 ? path.slice(0, hashIdx) : path;

  const queryIdx = noHash.indexOf('?');
  if (queryIdx < 0) return noHash;

  const pathname = noHash.slice(0, queryIdx);
  const queryStr = noHash.slice(queryIdx + 1);

  // URLSearchParams handles percent-decoding of keys/values for us, and
  // `.toString()` re-encodes them in a canonical form on the way out.
  const params = new URLSearchParams(queryStr);
  const filtered = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (isSensitiveKey(key)) continue;
    if (isSensitiveValue(value)) continue;
    filtered.append(key, value);
  }

  const out = filtered.toString();
  return out.length > 0 ? `${pathname}?${out}` : pathname;
}
