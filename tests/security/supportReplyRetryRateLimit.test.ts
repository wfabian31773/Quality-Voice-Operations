import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  tryReserveSupportReplyRetrySlot,
  getSupportReplyRetryCooldownSeconds,
  __setCooldownSecondsForTesting,
  __reloadCooldownFromEnvForTesting,
  __resetForTesting,
} from '../../platform/help/supportReplyRetryLimiter';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);

describe('supportReplyRetryLimiter — behavioral', () => {
  beforeEach(() => {
    __resetForTesting();
    __setCooldownSecondsForTesting(60);
  });

  afterEach(() => {
    __resetForTesting();
    __reloadCooldownFromEnvForTesting();
  });

  it('allows the first reservation for a reply id', () => {
    const r = tryReserveSupportReplyRetrySlot(42, 1_000);
    expect(r).toEqual({ allowed: true });
  });

  it('rejects a second reservation inside the cooldown window with retryAfterSeconds', () => {
    expect(tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    const r = tryReserveSupportReplyRetrySlot(42, 5_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      // 60s cooldown, 4s elapsed → 56s left
      expect(r.retryAfterSeconds).toBe(56);
    }
  });

  it('reports at least 1 second remaining even when only milliseconds are left', () => {
    expect(tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    const r = tryReserveSupportReplyRetrySlot(42, 60_999);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('allows another reservation once the cooldown elapses', () => {
    expect(tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    expect(tryReserveSupportReplyRetrySlot(42, 30_000).allowed).toBe(false);
    expect(tryReserveSupportReplyRetrySlot(42, 61_000)).toEqual({ allowed: true });
  });

  it('isolates cooldowns per reply id', () => {
    expect(tryReserveSupportReplyRetrySlot(1, 1_000)).toEqual({ allowed: true });
    // A different reply id is not affected by reply id 1's cooldown.
    expect(tryReserveSupportReplyRetrySlot(2, 1_001)).toEqual({ allowed: true });
    expect(tryReserveSupportReplyRetrySlot(1, 2_000).allowed).toBe(false);
    expect(tryReserveSupportReplyRetrySlot(2, 2_000).allowed).toBe(false);
  });

  it('skips the limiter when cooldown is zero', () => {
    __setCooldownSecondsForTesting(0);
    for (let i = 0; i < 10; i++) {
      expect(tryReserveSupportReplyRetrySlot(99, 1_000 + i)).toEqual({ allowed: true });
    }
  });

  it('reads the cooldown from SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS', () => {
    const original = process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS;
    try {
      process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS = '5';
      __reloadCooldownFromEnvForTesting();
      expect(getSupportReplyRetryCooldownSeconds()).toBe(5);

      process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS = '';
      __reloadCooldownFromEnvForTesting();
      expect(getSupportReplyRetryCooldownSeconds()).toBe(60); // default

      process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS = 'not-a-number';
      __reloadCooldownFromEnvForTesting();
      expect(getSupportReplyRetryCooldownSeconds()).toBe(60); // fallback to default
    } finally {
      if (original === undefined) delete process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS;
      else process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS = original;
      __reloadCooldownFromEnvForTesting();
    }
  });

  it('serializes concurrent reservations: only the first wins', async () => {
    // Simulate N "concurrent" handlers all calling reserve before any await.
    // Because tryReserveSupportReplyRetrySlot is fully synchronous and
    // atomic, only the first to run gets allowed=true; the rest see the
    // recorded slot and are rejected with retryAfterSeconds. This is the
    // property that protects against an admin (or several admins) mashing
    // the Retry button while SMTP is down.
    const fixedNow = 1_000;
    const concurrency = 25;
    const results = await Promise.all(
      Array.from({ length: concurrency }, async () =>
        tryReserveSupportReplyRetrySlot(7, fixedNow),
      ),
    );
    const allowed = results.filter((r) => r.allowed === true);
    const rejected = results.filter((r) => r.allowed === false);
    expect(allowed.length).toBe(1);
    expect(rejected.length).toBe(concurrency - 1);
    for (const r of rejected) {
      if (!r.allowed) {
        expect(r.retryAfterSeconds).toBeGreaterThan(0);
        expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    }
  });
});

describe('support reply retry rate limit — wiring into the route', () => {
  it('imports the limiter helper from the platform module', () => {
    expect(supportFile).toMatch(
      /import\s*\{\s*tryReserveSupportReplyRetrySlot\s*\}\s*from\s*'[^']*supportReplyRetryLimiter'/,
    );
  });

  it('reserves the slot before any awaited work in the support retry route', () => {
    const routeStart = supportFile.indexOf(
      "'/support/tickets/:id/replies/:replyId/retry'",
    );
    expect(routeStart).toBeGreaterThan(0);
    const reserveIdx = supportFile.indexOf(
      'tryReserveSupportReplyRetrySlot(replyIdNum)',
      routeStart,
    );
    expect(reserveIdx).toBeGreaterThan(routeStart);

    // Strip line comments and block comments from the prelude so "await"
    // wording in commentary doesn't fool the check, then assert that no
    // actual `await ...` expression appears before the reservation.
    const preReserveRaw = supportFile.slice(routeStart, reserveIdx);
    const preReserve = preReserveRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(preReserve).not.toMatch(/\bawait\s+\w/);

    // And the first awaited DB call (loading the reply row) must happen
    // *after* the reserve.
    const poolIdx = supportFile.indexOf('await pool.query', reserveIdx);
    expect(poolIdx).toBeGreaterThan(reserveIdx);
  });

  it('returns 429 with a Retry-After header and a clear "try again in X seconds" message', () => {
    const routeStart = supportFile.indexOf(
      "'/support/tickets/:id/replies/:replyId/retry'",
    );
    expect(routeStart).toBeGreaterThan(0);
    // Scope the assertions to the support retry route body so we don't
    // accidentally match the docs-feedback retry route's identical wording.
    const routeEnd = (() => {
      const candidates = [
        supportFile.indexOf('\nrouter.', routeStart + 1),
        supportFile.indexOf('\n// -----', routeStart + 1),
      ].filter((i) => i > 0);
      return candidates.length > 0 ? Math.min(...candidates) : supportFile.length;
    })();
    const routeBody = supportFile.slice(routeStart, routeEnd);

    expect(routeBody).toMatch(
      /res\.setHeader\('Retry-After',\s*String\(limit\.retryAfterSeconds\)\)/,
    );
    expect(routeBody).toMatch(/res\.status\(429\)/);
    expect(routeBody).toMatch(
      /Retry rate limit reached\. Try again in \$\{limit\.retryAfterSeconds\} second/,
    );
    expect(routeBody).toMatch(/retry_after_seconds:\s*limit\.retryAfterSeconds/);
  });

  it('does not throttle the regular reply endpoint', () => {
    // The non-retry reply route POSTs to /support/tickets/:id/replies (no
    // /retry suffix). It must not consult the support reply retry limiter
    // and must not return 429.
    const replyRouteIdx = supportFile.indexOf(
      "router.post('/support/tickets/:id/replies',",
    );
    expect(replyRouteIdx).toBeGreaterThan(0);
    const replyBodyEnd = (() => {
      const candidates = [
        supportFile.indexOf('\nrouter.', replyRouteIdx + 1),
        supportFile.indexOf('\nfunction ', replyRouteIdx + 1),
        supportFile.indexOf('\nconst ', replyRouteIdx + 1),
        supportFile.indexOf('\n/**', replyRouteIdx + 1),
      ].filter((i) => i > 0);
      return Math.min(...candidates);
    })();
    const replyBody = supportFile.slice(replyRouteIdx, replyBodyEnd);
    expect(replyBody).not.toMatch(/tryReserveSupportReplyRetrySlot/);
    expect(replyBody).not.toMatch(/status\(429\)/);
  });
});
