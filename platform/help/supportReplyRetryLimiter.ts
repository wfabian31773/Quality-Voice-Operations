/**
 * Per-reply retry rate limiter for the support-ticket "Retry send" button.
 *
 * Mirrors `docsFeedbackRetryLimiter` but keys on `support_ticket_replies.id`
 * instead of `docs_feedback.id`. The button on a failed outbound reply re-
 * sends the same body to the same recipient on every click. With SMTP down
 * or a permanently-bouncing recipient address, an admin clicking repeatedly
 * would keep generating outbound delivery attempts and could hurt sender
 * reputation. This limiter debounces retries on a per-reply_id key so a
 * single broken inbox can only be hammered once per cooldown window,
 * regardless of who is clicking.
 *
 * The check-and-set is performed in a single synchronous step
 * (`tryReserveSupportReplyRetrySlot`) so two near-simultaneous handler
 * invocations cannot both pass the gate before either records its attempt —
 * Node is single-threaded, and the reserve happens before any `await`, so
 * the second caller always observes the first caller's reservation.
 *
 * Scope: this limiter is **in-memory and per-process**. The cooldown resets
 * on process restart and is not shared across instances. That is enough for
 * the current single-process admin API deployment; a future multi-instance
 * setup would need to back this with shared storage (Redis / DB advisory
 * lock) for cluster-wide enforcement.
 */

const DEFAULT_COOLDOWN_SECONDS = 60;

function readCooldownFromEnv(): number {
  const raw = process.env.SUPPORT_REPLY_RETRY_COOLDOWN_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_COOLDOWN_SECONDS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COOLDOWN_SECONDS;
  return parsed;
}

let cooldownSeconds = readCooldownFromEnv();

/** Last-attempt timestamp (ms) keyed on support_ticket_replies.id. */
const lastAttemptAt = new Map<number, number>();

export type ReserveResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Atomically check the cooldown for `replyId` and, if allowed, reserve
 * the slot by recording the attempt timestamp. The check and the write run
 * in a single synchronous block so concurrent callers cannot both pass.
 */
export function tryReserveSupportReplyRetrySlot(
  replyId: number,
  now: number = Date.now(),
): ReserveResult {
  if (cooldownSeconds <= 0) return { allowed: true };
  const cooldownMs = cooldownSeconds * 1000;
  const last = lastAttemptAt.get(replyId);
  if (last !== undefined) {
    const elapsedMs = now - last;
    if (elapsedMs < cooldownMs) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000)),
      };
    }
  }
  lastAttemptAt.set(replyId, now);
  return { allowed: true };
}

/** Currently configured cooldown in seconds (after env override). */
export function getSupportReplyRetryCooldownSeconds(): number {
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

/** Wipe the in-memory map — only used by tests. */
export function __resetForTesting(): void {
  lastAttemptAt.clear();
}

/**
 * Periodically prune entries whose cooldown has fully elapsed so the map
 * does not grow unbounded over the lifetime of the process. The timer is
 * unref'd so it does not hold the event loop open in tests / shutdown.
 */
const cleanupTimer = setInterval(() => {
  if (cooldownSeconds <= 0) {
    lastAttemptAt.clear();
    return;
  }
  const cutoff = Date.now() - cooldownSeconds * 1000;
  for (const [id, ts] of lastAttemptAt) {
    if (ts < cutoff) lastAttemptAt.delete(id);
  }
}, 60 * 1000);
cleanupTimer.unref?.();
