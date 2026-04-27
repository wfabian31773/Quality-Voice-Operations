import { createLogger } from '../core/logger';
import { syncFederalDncRegistry } from './FederalDncService';

const logger = createLogger('FEDERAL_DNC_SCHEDULER');

/**
 * Weekly cadence. The FTC publishes registry deltas daily but a tenant who
 * scrubs at most weekly is already TCPA-compliant — and the full snapshot is
 * large enough (~250M numbers) that pulling more often than necessary just
 * burns the subscription's bandwidth allowance.
 */
const SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Wait 10 minutes after process boot before kicking off the first sync. The
 * load is heavy (a few minutes of bulk insert against the federal table) so
 * we'd rather not contend with the rest of the boot sequence (DB pool warm-
 * up, Twilio creds, scheduler startup).
 */
const INITIAL_DELAY_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Wraps `syncFederalDncRegistry()` with the standard fire-and-log pattern so
 * thrown errors don't crash the timer. Exported so tests + an admin-API
 * "sync now" endpoint can invoke a single cycle without going through the
 * timer plumbing.
 */
export async function runFederalDncSyncCycle(): Promise<void> {
  try {
    const result = await syncFederalDncRegistry();
    logger.info('Federal DNC sync cycle finished', {
      status: result.status,
      registryVersion: result.registryVersion,
      recordCount: result.recordCount,
      durationMs: result.durationMs,
      reason: result.reason,
    });
  } catch (err) {
    // syncFederalDncRegistry already swallows expected failures and writes
    // them to the sync-state row. A throw here would mean a programming bug
    // (e.g. db pool gone) — log loudly but don't kill the timer.
    logger.error('Federal DNC sync cycle threw unexpectedly', { error: String(err) });
  }
}

export function startFederalDncSyncScheduler(intervalMs: number = SYNC_INTERVAL_MS): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runFederalDncSyncCycle().catch((err) => {
      logger.error('Initial federal DNC sync failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runFederalDncSyncCycle().catch((err) => {
      logger.error('Scheduled federal DNC sync failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Federal DNC sync scheduler started', { intervalMs });
}

export function stopFederalDncSyncScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Federal DNC sync scheduler stopped');
  }
}
