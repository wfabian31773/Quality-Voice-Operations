import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Shared, hoisted in-memory simulation of the cluster-wide `retry_attempts`
// table. Hoisting lets the same store survive `vi.resetModules()` so two
// freshly-imported "admin server processes" still see the same DB row.
const dbState = vi.hoisted(() => {
  const attempts = new Map<string, Date>();
  return { attempts };
});

vi.mock('../../platform/db', () => {
  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('INSERT INTO retry_attempts')) {
      const [key, nowIsoOrNull, cooldownSecondsRaw] = params as [
        string,
        string | null,
        number,
      ];
      const cooldownSeconds = Number(cooldownSecondsRaw);
      const now = new Date(nowIsoOrNull ?? Date.now());
      const existing = dbState.attempts.get(key);
      if (existing === undefined) {
        dbState.attempts.set(key, now);
        return { rows: [{ last_attempt_at: now }], rowCount: 1 };
      }
      const elapsedMs = now.getTime() - existing.getTime();
      if (elapsedMs >= cooldownSeconds * 1000) {
        dbState.attempts.set(key, now);
        return { rows: [{ last_attempt_at: now }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (text.startsWith('SELECT last_attempt_at,')) {
      const [key, nowIsoOrNull] = params as [string, string | null];
      const existing = dbState.attempts.get(key);
      if (existing === undefined) return { rows: [], rowCount: 0 };
      const now = new Date(nowIsoOrNull ?? Date.now());
      const elapsedSeconds = (now.getTime() - existing.getTime()) / 1000;
      return {
        rows: [{ last_attempt_at: existing, elapsed_seconds: elapsedSeconds }],
        rowCount: 1,
      };
    }

    if (text.startsWith('DELETE FROM retry_attempts')) {
      const [pattern] = params as [string];
      const prefix = pattern
        .replace(/%$/u, '')
        .replace(/\\([%_])/g, '$1');
      for (const key of [...dbState.attempts.keys()]) {
        if (key.startsWith(prefix)) dbState.attempts.delete(key);
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query in test mock: ${text}`);
  };
  return {
    getPlatformPool: () => ({ query }),
  };
});

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
  beforeEach(async () => {
    dbState.attempts.clear();
    await __resetForTesting();
    __setCooldownSecondsForTesting(60);
  });

  afterEach(async () => {
    dbState.attempts.clear();
    await __resetForTesting();
    __reloadCooldownFromEnvForTesting();
  });

  it('allows the first reservation for a reply id', async () => {
    const r = await tryReserveSupportReplyRetrySlot(42, 1_000);
    expect(r).toEqual({ allowed: true });
  });

  it('rejects a second reservation inside the cooldown window with retryAfterSeconds', async () => {
    expect(await tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    const r = await tryReserveSupportReplyRetrySlot(42, 5_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      // 60s cooldown, 4s elapsed → 56s left
      expect(r.retryAfterSeconds).toBe(56);
    }
  });

  it('reports at least 1 second remaining even when only milliseconds are left', async () => {
    expect(await tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    const r = await tryReserveSupportReplyRetrySlot(42, 60_999);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('allows another reservation once the cooldown elapses', async () => {
    expect(await tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({ allowed: true });
    expect((await tryReserveSupportReplyRetrySlot(42, 30_000)).allowed).toBe(false);
    expect(await tryReserveSupportReplyRetrySlot(42, 61_000)).toEqual({ allowed: true });
  });

  it('isolates cooldowns per reply id', async () => {
    expect(await tryReserveSupportReplyRetrySlot(1, 1_000)).toEqual({ allowed: true });
    // A different reply id is not affected by reply id 1's cooldown.
    expect(await tryReserveSupportReplyRetrySlot(2, 1_001)).toEqual({ allowed: true });
    expect((await tryReserveSupportReplyRetrySlot(1, 2_000)).allowed).toBe(false);
    expect((await tryReserveSupportReplyRetrySlot(2, 2_000)).allowed).toBe(false);
  });

  it('skips the limiter when cooldown is zero', async () => {
    __setCooldownSecondsForTesting(0);
    for (let i = 0; i < 10; i++) {
      expect(await tryReserveSupportReplyRetrySlot(99, 1_000 + i)).toEqual({ allowed: true });
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
    // Simulate N "concurrent" handlers all calling reserve. Because the
    // INSERT ... ON CONFLICT DO UPDATE is atomic at the database level,
    // only the first reservation gets allowed=true; the rest see the
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

describe('supportReplyRetryLimiter — cluster-wide enforcement', () => {
  beforeEach(async () => {
    dbState.attempts.clear();
    await __resetForTesting();
    __setCooldownSecondsForTesting(60);
  });

  afterEach(async () => {
    dbState.attempts.clear();
    await __resetForTesting();
    __reloadCooldownFromEnvForTesting();
  });

  it('blocks a fresh admin server that did not see the first reservation', async () => {
    // First "admin server" reserves the slot.
    expect(await tryReserveSupportReplyRetrySlot(42, 1_000)).toEqual({
      allowed: true,
    });

    // Simulate a second admin server booting up with no per-process state by
    // resetting the module cache and re-importing the limiter. Its in-memory
    // map (if there were one) would be empty, but it must still see the
    // shared retry_attempts row written by the first server and reject.
    vi.resetModules();
    const limiterB = await import('../../platform/help/supportReplyRetryLimiter');
    limiterB.__setCooldownSecondsForTesting(60);

    const r = await limiterB.tryReserveSupportReplyRetrySlot(42, 5_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSeconds).toBe(56);
    }
  });

  it('persists the cooldown across a process restart', async () => {
    // First boot: reserve.
    expect(await tryReserveSupportReplyRetrySlot(99, 10_000)).toEqual({
      allowed: true,
    });

    // "Process restart": brand-new module, but the shared row remains.
    vi.resetModules();
    const limiterAfterRestart = await import(
      '../../platform/help/supportReplyRetryLimiter'
    );
    limiterAfterRestart.__setCooldownSecondsForTesting(60);

    // Still inside the cooldown window — must be blocked even though the
    // restarted process has no in-memory record of the prior attempt.
    const blocked = await limiterAfterRestart.tryReserveSupportReplyRetrySlot(
      99,
      30_000,
    );
    expect(blocked.allowed).toBe(false);

    // Once the cooldown elapses, the new process can reserve again.
    const allowedAgain =
      await limiterAfterRestart.tryReserveSupportReplyRetrySlot(99, 70_001);
    expect(allowedAgain).toEqual({ allowed: true });
  });

  it('resolves a race between two admin servers via the shared row lock', async () => {
    // Race: two servers issue the very first reservation for the same
    // reply id at the same instant. The atomic upsert must let exactly one
    // win, regardless of which "process" was imported first.
    vi.resetModules();
    const serverA = await import('../../platform/help/supportReplyRetryLimiter');
    serverA.__setCooldownSecondsForTesting(60);

    vi.resetModules();
    const serverB = await import('../../platform/help/supportReplyRetryLimiter');
    serverB.__setCooldownSecondsForTesting(60);

    const fixedNow = 100;
    const [a, b] = await Promise.all([
      serverA.tryReserveSupportReplyRetrySlot(123, fixedNow),
      serverB.tryReserveSupportReplyRetrySlot(123, fixedNow),
    ]);

    const allowed = [a, b].filter((r) => r.allowed === true);
    const rejected = [a, b].filter((r) => r.allowed === false);
    expect(allowed.length).toBe(1);
    expect(rejected.length).toBe(1);
  });
});

describe('support reply retry rate limit — wiring into the route', () => {
  it('imports the limiter helper from the platform module', () => {
    expect(supportFile).toMatch(
      /import\s*\{\s*tryReserveSupportReplyRetrySlot\s*\}\s*from\s*'[^']*supportReplyRetryLimiter'/,
    );
  });

  it('awaits the reservation as the first awaited work in the support retry route', () => {
    const routeStart = supportFile.indexOf(
      "'/support/tickets/:id/replies/:replyId/retry'",
    );
    expect(routeStart).toBeGreaterThan(0);

    // The reservation is now async (it round-trips to the shared
    // retry_attempts table). It must be awaited, and that await must be
    // the *first* awaited expression in the handler so the gate is taken
    // before any other DB work.
    const reserveCall = 'await tryReserveSupportReplyRetrySlot(replyIdNum)';
    const reserveIdx = supportFile.indexOf(reserveCall, routeStart);
    expect(reserveIdx).toBeGreaterThan(routeStart);

    // Strip line and block comments from the prelude so commentary that
    // happens to use the word "await" doesn't fool the check, then assert
    // that no actual `await ...` expression appears before the reservation.
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
