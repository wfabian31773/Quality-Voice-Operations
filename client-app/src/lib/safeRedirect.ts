/**
 * Sanitize a `redirectTo` query-string value so it can only ever land on a
 * same-origin path within our SPA.
 *
 * Background (BL-012 / B-20 / S-03):
 *   `/login?redirectTo=https://attacker.com` was an open-redirect waiting to
 *   happen — a phishing page at our domain could send users straight to the
 *   attacker's site after a "successful" login. The fix is a strict allow-
 *   list: we only honour values that are clearly relative paths under our
 *   own origin.
 *
 * Rules (a value is rejected if any of these is true):
 *   - missing / non-string
 *   - does not start with `/` (would be relative to the current document)
 *   - starts with `//` — that's a protocol-relative URL (`//evil.com/x`),
 *     which the browser resolves to `https://evil.com/x`
 *   - starts with `/\` or `/%5C` / `/%5c` — backslash bypass (some routers
 *     and older browsers normalize backslashes to forward-slashes, so
 *     `/\\evil.com` becomes `//evil.com` after normalization)
 *   - contains any whitespace or control character (defense-in-depth against
 *     `\r\n` smuggling and similar)
 *
 * Anything else is returned as-is. We deliberately do NOT try to "clean"
 * suspicious values — if anything looks off, we drop it and use the
 * caller-provided fallback.
 *
 * NOTE: this MUST be a pure function with no DOM dependencies so it can be
 * unit-tested under Vitest without a browser.
 */
export function safeRedirect(
  redirectTo: string | null | undefined,
  fallback: string,
): string {
  if (typeof redirectTo !== 'string' || redirectTo.length === 0) {
    return fallback;
  }
  if (!redirectTo.startsWith('/')) {
    return fallback;
  }
  if (redirectTo.startsWith('//')) {
    return fallback;
  }
  // Backslash bypass: `/\evil.com` and `/%5Cevil.com` (URL-encoded `\`).
  if (redirectTo.startsWith('/\\')) {
    return fallback;
  }
  if (redirectTo.toLowerCase().startsWith('/%5c')) {
    return fallback;
  }
  // Defense-in-depth: any whitespace or control char is unexpected in a
  // legitimate router path and is a classic header-injection / smuggling
  // vector.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(redirectTo)) {
    return fallback;
  }
  return redirectTo;
}
