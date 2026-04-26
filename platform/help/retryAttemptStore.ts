/**
 * Shared, cluster-wide backing store for the per-key retry cooldowns used by
 * the docs-feedback and support-ticket "Retry send" buttons.
 *
 * Implementation: a single `retry_attempts(key TEXT PRIMARY KEY,
 * last_attempt_at TIMESTAMPTZ)` row per key in the platform Postgres database.
 * The check-and-reserve is performed with one atomic
 *
 *   INSERT INTO retry_attempts (key, last_attempt_at)
 *   VALUES ($1, COALESCE($2::timestamptz, NOW()))
 *   ON CONFLICT (key) DO UPDATE
 *     SET last_attempt_at = EXCLUDED.last_attempt_at
 *     WHERE retry_attempts.last_attempt_at
 *           <= COALESCE($2::timestamptz, NOW()) - make_interval(secs => $3::int)
 *   RETURNING last_attempt_at
 *
 * statement, which Postgres serializes via a row-level lock taken on the
 * conflicting tuple. Two concurrent admin servers cannot both win — exactly
 * one INSERT/UPDATE returns a row; the other sees zero rows and is rejected.
 *
 * The cooldown comparison defaults to Postgres `NOW()` so two admin nodes
 * with clock skew still compare against the *same* (DB-side) wall clock.
 * Tests can pass an explicit `now` to make the gate fully deterministic.
 *
 * If the WHERE clause rejects the upsert (cooldown not yet elapsed), no row
 * is returned and we issue a follow-up SELECT to read the persisted
 * `last_attempt_at` and the DB-computed elapsed-seconds so we can return a
 * useful `Retry-After`.
 */

import { getPlatformPool } from '../db';

export type ReserveResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Atomically check the cluster-wide cooldown for `key` against the shared
 * retry_attempts table and, if elapsed (or absent), reserve the slot by
 * writing the new attempt timestamp. Returns `{ allowed: true }` on success
 * or `{ allowed: false, retryAfterSeconds }` when another admin server (or
 * an earlier call on this server) already holds the slot.
 *
 * `cooldownSeconds <= 0` short-circuits to `{ allowed: true }` without
 * touching the database — useful for opt-out configurations and for tests
 * that exercise downstream behavior of the route.
 *
 * `now` is optional. Production callers omit it so Postgres `NOW()` is used
 * for both the stored timestamp and the cooldown comparison, which avoids
 * inter-node clock-skew effects. Tests pass a fixed `now` for determinism.
 */
export async function tryReserveSharedAttempt(
  key: string,
  cooldownSeconds: number,
  now?: number,
): Promise<ReserveResult> {
  if (cooldownSeconds <= 0) return { allowed: true };

  const pool = getPlatformPool();
  const nowParam = now === undefined ? null : new Date(now).toISOString();

  // Atomic check-and-reserve. The WHERE on the DO UPDATE ensures we only
  // overwrite the timestamp when the previous attempt is older than the
  // cooldown window; otherwise the upsert produces zero rows and we report
  // the caller as throttled. COALESCE($2, NOW()) makes the comparison fall
  // back to DB time when no explicit `now` was supplied.
  const upsert = await pool.query<{ last_attempt_at: Date | string }>(
    `INSERT INTO retry_attempts (key, last_attempt_at)
     VALUES ($1, COALESCE($2::timestamptz, NOW()))
     ON CONFLICT (key) DO UPDATE
       SET last_attempt_at = EXCLUDED.last_attempt_at
       WHERE retry_attempts.last_attempt_at
             <= COALESCE($2::timestamptz, NOW()) - make_interval(secs => $3::int)
     RETURNING last_attempt_at`,
    [key, nowParam, cooldownSeconds],
  );

  if ((upsert.rowCount ?? upsert.rows.length) > 0) {
    return { allowed: true };
  }

  // Throttled. Read the existing timestamp AND the DB-computed elapsed
  // seconds so the Retry-After we return is referenced against the same
  // (DB-side) clock that just rejected us. If the row vanished between our
  // INSERT and SELECT (e.g. an out-of-band cleanup job), retry once — the
  // cooldown should now be open.
  const existing = await pool.query<{
    last_attempt_at: Date | string;
    elapsed_seconds: string | number;
  }>(
    `SELECT last_attempt_at,
            EXTRACT(EPOCH FROM (COALESCE($2::timestamptz, NOW()) - last_attempt_at))
              AS elapsed_seconds
       FROM retry_attempts
      WHERE key = $1`,
    [key, nowParam],
  );
  const existingCount = existing.rowCount ?? existing.rows.length;
  if (existingCount === 0) {
    return tryReserveSharedAttempt(key, cooldownSeconds, now);
  }

  const elapsedSeconds = Number(existing.rows[0].elapsed_seconds);
  const remaining = cooldownSeconds - elapsedSeconds;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(remaining)),
  };
}

/**
 * Test-only: delete every retry_attempts row whose key starts with `prefix`.
 * Both limiters use distinct prefixes (`docs_feedback_retry:` and
 * `support_reply_retry:`), so each test suite resets only its own keys.
 */
export async function __deleteAttemptsByPrefixForTesting(
  prefix: string,
): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(`DELETE FROM retry_attempts WHERE key LIKE $1`, [
    prefix.replace(/[%_]/g, (m) => `\\${m}`) + '%',
  ]);
}
