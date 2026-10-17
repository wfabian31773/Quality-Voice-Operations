/**
 * Interval runner for `releaseDueDeferredSms` (registered as
 * `sms-deferred-release` in platform/runtime/schedulers.ts, so it follows
 * SCHEDULERS_ENABLED and the worker leadership like every other scheduler).
 * Each release still re-checks SMS_ENABLED and the tenant flag per message.
 */
import { createLogger } from '../../core/logger';
import { releaseDueDeferredSms, type DeferredReleaseSummary } from './send';

const logger = createLogger('SMS_DEFERRED_RELEASE');

export const SMS_DEFERRED_RELEASE_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** One release pass; skipped (null) while the previous pass is still running. */
export async function runSmsDeferredReleaseCycle(
  release: () => Promise<DeferredReleaseSummary> = () => releaseDueDeferredSms(),
): Promise<DeferredReleaseSummary | null> {
  if (running) return null;
  running = true;
  try {
    const summary = await release();
    if (summary.claimed > 0) logger.info('Deferred SMS release cycle complete', { ...summary });
    return summary;
  } catch (err) {
    logger.error('Deferred SMS release cycle failed', { error: String(err) });
    return null;
  } finally {
    running = false;
  }
}

export function startSmsDeferredReleaseScheduler(intervalMs: number = SMS_DEFERRED_RELEASE_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void runSmsDeferredReleaseCycle();
  }, intervalMs);
  logger.info('Deferred SMS release scheduler started', { intervalMs });
}

export function stopSmsDeferredReleaseScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Deferred SMS release scheduler stopped');
  }
}

/** True while a release pass is mid-flight (it may be awaiting Twilio). */
export function smsDeferredReleaseInFlight(): boolean {
  return running;
}
