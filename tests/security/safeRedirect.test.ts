/**
 * BL-012: open-redirect defense for `/login?redirectTo=…`.
 *
 * `safeRedirect()` is the single source of truth for whether a query-string
 * redirect target is safe to navigate to. The rules are intentionally
 * strict — an absolute URL, a protocol-relative URL, a backslash bypass,
 * or anything containing whitespace gets dropped to the caller-provided
 * fallback.
 */
import { describe, it, expect } from 'vitest';
import { safeRedirect } from '../../client-app/src/lib/safeRedirect';

const FALLBACK = '/dashboard';

describe('safeRedirect()', () => {
  describe('honours legitimate same-origin paths', () => {
    it.each([
      ['/dashboard'],
      ['/widget'],
      ['/admin/dashboard'],
      ['/calls/abc-123'],
      ['/dashboard?tab=calls'],
      ['/dashboard?tab=calls&filter=open'],
      ['/dashboard#anchor'],
      ['/dashboard?tab=calls#row-1'],
      // Single character path is still a path.
      ['/'],
    ])('returns %s unchanged', (path) => {
      expect(safeRedirect(path, FALLBACK)).toBe(path);
    });
  });

  describe('falls back when input is missing or malformed', () => {
    it('falls back on null', () => {
      expect(safeRedirect(null, FALLBACK)).toBe(FALLBACK);
    });
    it('falls back on undefined', () => {
      expect(safeRedirect(undefined, FALLBACK)).toBe(FALLBACK);
    });
    it('falls back on empty string', () => {
      expect(safeRedirect('', FALLBACK)).toBe(FALLBACK);
    });
    it('falls back on non-string input', () => {
      // Cast through unknown to satisfy TS while we exercise the runtime
      // guard — `useSearchParams().get()` can theoretically return non-string
      // values in older react-router versions.
      expect(safeRedirect(42 as unknown as string, FALLBACK)).toBe(FALLBACK);
      expect(safeRedirect({} as unknown as string, FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('drops cross-origin / open-redirect payloads', () => {
    it.each([
      // Absolute URLs.
      ['https://attacker.com/phish'],
      ['http://attacker.com'],
      ['HTTPS://ATTACKER.COM'],
      // Protocol-relative URL — browsers turn this into https://attacker.com.
      ['//attacker.com'],
      ['//attacker.com/phish'],
      ['///attacker.com'],
      // Backslash bypass — some routers normalize `\` → `/`.
      ['/\\attacker.com'],
      ['/\\\\attacker.com'],
      // URL-encoded backslash bypass.
      ['/%5Cattacker.com'],
      ['/%5cattacker.com'],
      // javascript: / data: schemes.
      ['javascript:alert(1)'],
      // eslint-disable-next-line no-script-url
      ['JavaScript:alert(1)'],
      ['data:text/html,<script>alert(1)</script>'],
      // Path-relative — still ambiguous, drop it.
      ['dashboard'],
      ['./dashboard'],
      ['../admin'],
    ])('falls back for %s', (payload) => {
      expect(safeRedirect(payload, FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('drops payloads containing whitespace or control characters', () => {
    it.each([
      ['/dashboard\r\nSet-Cookie: x=y'],
      ['/dashboard\nLocation: https://attacker.com'],
      ['/dashboard\tfoo'],
      ['/dash board'],
      ['/dashboard\u0000'],
    ])('falls back for %s', (payload) => {
      expect(safeRedirect(payload, FALLBACK)).toBe(FALLBACK);
    });
  });

  it('lets the caller pass any fallback path', () => {
    expect(safeRedirect('https://evil.com', '/admin/dashboard')).toBe('/admin/dashboard');
    expect(safeRedirect(null, '/ops/monitor')).toBe('/ops/monitor');
  });
});
