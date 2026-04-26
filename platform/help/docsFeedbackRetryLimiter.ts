/**
 * Per-feedback retry rate limiter for the docs-feedback "Retry send" button.
 *
 * The button on the failed-reply banner re-sends the most recent reply on
 * every click. With SMTP down or a permanently-bouncing recipient, an admin
 * clicking repeatedly would keep generating docs_feedback_replies rows and
 * outbound attempts. This limiter debounces retries on a per-feedback_id key
 * so a single broken inbox can only be hammered once per cooldown window,
 * regardless of who is clicking.
 *
 * Storage: cooldowns are persisted in the shared `retry_attempts` table via
 * `platform/help/retryAttemptStore.ts` so the gate is enforced cluster-wide.
 * A horizontally-scaled admin API where two clicks land on different
 * instances still sees a single shared `last_attempt_at` row, and the
 * underlying `INSERT ... ON CONFLICT DO UPDATE WHERE` is atomic at the
 * Postgres level so concurrent reservations cannot both pass.
 *
 * Only the cooldown duration is per-process state — the *attempt history*
 * lives entirely in Postgres.
 */

import {
  tryReserveSharedAttempt,
  __deleteAttemptsByPrefixForTesting,
  type ReserveResult,
} from './retryAttemptStore';

export type { ReserveResult };

const KEY_PREFIX = 'docs_feedback_retry:';
const DEFAULT_COOLDOWN_SECONDS = 60;

function readCooldownFromEnv(): number {
  const raw = process.env.DOCS_FEEDBACK_RETRY_COOLDOWN_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_COOLDOWN_SECONDS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COOLDOWN_SECONDS;
  return parsed;
}

let cooldownSeconds = readCooldownFromEnv();

/**
 * Atomically check the cluster-wide cooldown for `feedbackId` and, if
 * allowed, reserve the slot by recording the attempt timestamp in the shared
 * `retry_attempts` table. The check and the write run in a single Postgres
 * statement so concurrent callers — even on different admin servers —
 * cannot both pass the gate.
 *
 * `now` is optional. Production callers omit it so the comparison uses
 * Postgres `NOW()` and is therefore immune to clock skew between admin
 * nodes. Tests pass an explicit `now` for determinism.
 */
export async function tryReserveRetrySlot(
  feedbackId: number,
  now?: number,
): Promise<ReserveResult> {
  return tryReserveSharedAttempt(`${KEY_PREFIX}${feedbackId}`, cooldownSeconds, now);
}

/** Currently configured cooldown in seconds (after env override). */
export function getRetryCooldownSeconds(): number {
  return cooldownSeconds;
}

/** Override the cooldown at runtime — only used by tests. */
export function __setCooldownSecondsForTesting(seconds: number): void {
  cooldownSeconds = seconds;
}

/** Re-read the cooldown from process.env — only used by tests. */
export function __reloadCooldownFromEnvForTesting(): void {
  cooldownSeconds = readCooldownFromEnv();
}

/**
 * Wipe this limiter's rows from the shared `retry_attempts` table. Only the
 * docs-feedback prefix is touched, so concurrent suites using the same DB
 * (e.g. the support-reply limiter) are not affected.
 */
export async function __resetForTesting(): Promise<void> {
  await __deleteAttemptsByPrefixForTesting(KEY_PREFIX);
}
