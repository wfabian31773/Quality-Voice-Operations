/**
 * Hardens `/login?redirectTo=…` against accidentally smuggling sensitive
 * query parameters into server access logs / Referer / analytics.
 *
 * `sanitizeRedirectPath()` is the single source of truth for what survives
 * the round trip through the login URL. The rules:
 *   - the URL fragment (`#…`) is dropped unconditionally
 *   - any query KEY matching a sensitive name (token, code, secret, otp,
 *     email, session, …) is removed
 *   - any query VALUE that LOOKS token-shaped, code-shaped, or
 *     email-shaped is removed even if its key is innocuous
 *   - anything else (legitimate UX state like `?tab=calls`) is preserved
 *
 * These tests pin that behaviour. Loosening any of them needs a fresh
 * security review.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeRedirectPath } from '../../client-app/src/lib/sanitizeRedirectPath';

describe('sanitizeRedirectPath()', () => {
  describe('benign paths and query strings round-trip unchanged', () => {
    it.each([
      ['/dashboard'],
      ['/widget'],
      ['/admin/dashboard'],
      ['/calls/abc-123'],
      ['/dashboard?tab=calls'],
      ['/dashboard?tab=calls&filter=open'],
      ['/dashboard?page=2&sort=desc'],
      ['/calls?status=missed&priority=high'],
      ['/'],
      // A short slug-style id is fine — it doesn't look opaque enough to
      // be a credential.
      ['/orders?id=ord_42'],
    ])('preserves %s', (path) => {
      expect(sanitizeRedirectPath(path)).toBe(path);
    });
  });

  describe('drops the URL fragment unconditionally', () => {
    it('strips a plain anchor', () => {
      expect(sanitizeRedirectPath('/dashboard#section-2')).toBe('/dashboard');
    });
    it('strips an anchor that follows a query string', () => {
      expect(sanitizeRedirectPath('/dashboard?tab=calls#row-1')).toBe('/dashboard?tab=calls');
    });
    it('strips an empty fragment', () => {
      expect(sanitizeRedirectPath('/dashboard#')).toBe('/dashboard');
    });
    it('strips a fragment that itself contains a sensitive-looking value', () => {
      // A token hidden in the fragment is exactly the kind of thing we
      // never want to forward into the login URL's query string.
      expect(
        sanitizeRedirectPath('/dashboard#access_token=abcd1234efgh5678ijkl'),
      ).toBe('/dashboard');
    });
  });

  describe('drops sensitive query KEYS by name', () => {
    it.each([
      ['token'],
      ['access_token'],
      ['refresh_token'],
      ['id_token'],
      ['authToken'],
      ['auth'],
      ['authorization'],
      ['api_key'],
      ['apikey'],
      ['api-key'],
      ['key'],
      ['secret'],
      ['password'],
      ['passwd'],
      ['pwd'],
      ['otp'],
      ['code'],
      ['nonce'],
      ['state'],
      ['session'],
      ['sessionId'],
      ['sid'],
      ['signature'],
      ['sig'],
      ['verification'],
      ['verify'],
      ['email'],
      ['user_email'],
      ['jwt'],
      ['bearer'],
    ])('removes ?%s=…', (key) => {
      const out = sanitizeRedirectPath(`/dashboard?${key}=anything-here&tab=calls`);
      expect(out).toBe('/dashboard?tab=calls');
    });

    it('removes the only param and drops the trailing `?`', () => {
      expect(sanitizeRedirectPath('/dashboard?token=xyz')).toBe('/dashboard');
    });

    it('removes multiple sensitive params at once', () => {
      const out = sanitizeRedirectPath(
        '/dashboard?token=xyz&otp=123456&tab=calls&email=alice@example.com',
      );
      expect(out).toBe('/dashboard?tab=calls');
    });

    it('matches sensitive keys case-insensitively', () => {
      expect(sanitizeRedirectPath('/dashboard?TOKEN=xyz&tab=calls')).toBe('/dashboard?tab=calls');
      expect(sanitizeRedirectPath('/dashboard?Email=a@b.co&tab=calls')).toBe(
        '/dashboard?tab=calls',
      );
    });
  });

  describe('drops sensitive VALUES even under innocuous keys', () => {
    describe('token-shaped values', () => {
      it.each([
        // JWT.
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part_here'],
        // Long opaque base64-ish blob.
        ['abcd1234efgh5678ijkl9012mnop3456'],
        // UUID — commonly used as a one-time invite/share token.
        ['550e8400-e29b-41d4-a716-446655440000'],
        // Long hex digest.
        ['0123456789abcdef0123456789abcdef0123456789abcdef'],
        // Base64url with `_` and `-`.
        ['SGVsbG8gV29ybGQgdGhpcyBpcyBhIGxvbmcgdG9rZW4tbGlrZSBzdHJpbmc'],
      ])('drops ?q=%s', (token) => {
        const out = sanitizeRedirectPath(`/dashboard?q=${encodeURIComponent(token)}&tab=calls`);
        expect(out).toBe('/dashboard?tab=calls');
      });
    });

    describe('code-shaped values', () => {
      it.each([
        // Numeric OTPs.
        ['1234'],
        ['123456'],
        ['12345678'],
        // Mixed alphanumeric magic-link codes.
        ['ABC123'],
        ['7K9XQ2P4'],
        ['a1b2c3d4'],
      ])('drops ?ref=%s', (code) => {
        const out = sanitizeRedirectPath(`/dashboard?ref=${encodeURIComponent(code)}&tab=calls`);
        expect(out).toBe('/dashboard?tab=calls');
      });
    });

    describe('email-shaped values', () => {
      it.each([
        ['alice@example.com'],
        ['bob+tag@sub.example.co.uk'],
        ['ops-team@acme-corp.io'],
      ])('drops ?contact=%s', (email) => {
        const out = sanitizeRedirectPath(
          `/dashboard?contact=${encodeURIComponent(email)}&tab=calls`,
        );
        expect(out).toBe('/dashboard?tab=calls');
      });
    });
  });

  describe('preserves non-sensitive look-alikes', () => {
    it('keeps short numeric ids that are too short to be an OTP', () => {
      expect(sanitizeRedirectPath('/orders?page=2&size=20')).toBe('/orders?page=2&size=20');
    });
    it('keeps short alpha-only slugs (no digits → not code-shaped)', () => {
      expect(sanitizeRedirectPath('/calls?status=missed')).toBe('/calls?status=missed');
    });
    it('keeps strings that contain `@` but are not email-shaped', () => {
      expect(sanitizeRedirectPath('/search?q=cats%40night')).toBe('/search?q=cats%40night');
    });
    it('keeps slug-style ids that contain a hyphen and are not opaque', () => {
      // Hyphen in a short id breaks both the token-shape (length < 20) and
      // the code-shape (the strict 6–10 alnum rule) checks, so it survives.
      expect(sanitizeRedirectPath('/items?id=widget-pro')).toBe('/items?id=widget-pro');
    });
  });

  describe('edge cases', () => {
    it('handles a path with only a query separator and nothing after it', () => {
      expect(sanitizeRedirectPath('/dashboard?')).toBe('/dashboard');
    });
    it('handles a sensitive param with an empty value', () => {
      expect(sanitizeRedirectPath('/dashboard?token=&tab=calls')).toBe('/dashboard?tab=calls');
    });
    it('handles repeated query keys (drops every sensitive instance)', () => {
      expect(
        sanitizeRedirectPath('/dashboard?tab=calls&token=a&token=b&tab=missed'),
      ).toBe('/dashboard?tab=calls&tab=missed');
    });
    it('returns the input untouched for empty or non-string input', () => {
      expect(sanitizeRedirectPath('')).toBe('');
      // Cast to exercise the runtime guard.
      expect(sanitizeRedirectPath(null as unknown as string)).toBe(null as unknown as string);
      expect(sanitizeRedirectPath(undefined as unknown as string)).toBe(
        undefined as unknown as string,
      );
    });
  });
});
