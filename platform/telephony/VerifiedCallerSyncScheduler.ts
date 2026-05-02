import { writeAuditLog } from '../audit/AuditService';
import { createLogger } from '../core/logger';
import { fanoutInAppNotification } from '../notifications/NotificationPreferences';
import { getTenantAlertEmailRecipients } from '../integrations/connectors/ConnectorAlertRecipients';
import {
  claimVerifiedNotificationSlot,
  listPendingCallersToSync,
  syncCallerIdStatus,
  VERIFICATION_TTL_MS,
  type VerifiedCallerId,
} from './TrustedCallerService';

const logger = createLogger('VERIFIED_CALLER_SYNC');

/**
 * How often the sync loop polls Twilio for pending verifications.
 *
 * The Twilio validation code is valid for `VERIFICATION_TTL_MS` (10
 * minutes), so a 3-minute cadence gives ~3 chances to catch a successful
 * validation before the row falls out of the window and we mark it
 * `failed`. Twilio's REST API is rate-limited at ~100 req/s per account
 * which is far above what a 3-minute cadence with up to `MAX_PER_CYCLE`
 * pending rows could ever consume.
 */
const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;

/**
 * Wait 30 seconds after process boot before the first sweep so a fresh
 * deploy has time to wire up DB pools / Twilio creds before we start
 * issuing outbound HTTP. Shorter than the health scheduler because this
 * loop is more time-sensitive (the verification window is only 10
 * minutes).
 */
const INITIAL_DELAY_MS = 30 * 1000;

/**
 * Hard ceiling on how many pending rows we touch per cycle. Because
 * `syncCallerIdStatus` makes one Twilio HTTP call per pending row, this
 * also caps the number of outbound API calls per tick. A queue larger
 * than this just means stragglers are swept on the next tick — they
 * don't get stuck.
 */
const MAX_PER_CYCLE = 100;

/**
 * Per-tenant cap on rows touched in one cycle. Twilio rate-limits
 * `OutgoingCallerIds` reads at ~100 req/s per account, but a single
 * tenant going wild with hundreds of pending rows could still starve
 * the rest of the queue and burn through that budget on one tenant.
 * Capping per-tenant per-cycle ensures fair scheduling and predictable
 * Twilio load even when one tenant has a backlog. Stragglers carry
 * over to the next cycle, which still beats the previous "operator has
 * to click Sync" workflow.
 */
const MAX_PER_TENANT_PER_CYCLE = 25;

export interface VerifiedCallerSyncTenantStats {
  inspected: number;
  verified: number;
  failed: number;
  stillPending: number;
  errors: number;
  /**
   * Rows for this tenant that were skipped this cycle because the
   * per-tenant cap was hit. They'll be re-listed on the next sweep.
   */
  deferred: number;
}

export interface VerifiedCallerSyncCycleResult {
  inspected: number;
  verified: number;
  failed: number;
  stillPending: number;
  errors: number;
  notificationsSent: number;
  /**
   * Verifications where the success notification was suppressed because
   * another scheduler instance already claimed the one-shot slot.
   * Non-zero counts indicate concurrent scheduler runs (e.g. blue/green
   * deploy overlap) — expected to be ~0 in steady state.
   */
  notificationsThrottled: number;
  /**
   * Rows skipped this cycle because their tenant already hit
   * `MAX_PER_TENANT_PER_CYCLE`. Always 0 in normal operation; a
   * non-zero value means at least one tenant has a backlog larger than
   * the per-tenant cap and is being drained over multiple cycles.
   */
  deferred: number;
  /**
   * Per-tenant counts for the cycle. Keyed by tenant id so operators
   * can answer "which tenant is generating the auto-verify load?".
   */
  byTenant: Record<string, VerifiedCallerSyncTenantStats>;
}

function emptyTenantStats(): VerifiedCallerSyncTenantStats {
  return {
    inspected: 0,
    verified: 0,
    failed: 0,
    stillPending: 0,
    errors: 0,
    deferred: 0,
  };
}

function emptyCycleResult(): VerifiedCallerSyncCycleResult {
  return {
    inspected: 0,
    verified: 0,
    failed: 0,
    stillPending: 0,
    errors: 0,
    notificationsSent: 0,
    notificationsThrottled: 0,
    deferred: 0,
    byTenant: {},
  };
}

function getTenantBucket(
  stats: VerifiedCallerSyncCycleResult,
  tenantId: string,
): VerifiedCallerSyncTenantStats {
  let bucket = stats.byTenant[tenantId];
  if (!bucket) {
    bucket = emptyTenantStats();
    stats.byTenant[tenantId] = bucket;
  }
  return bucket;
}

/**
 * Resolve the audience for the success toast. Prefers the user who
 * registered the caller (so they see their own action complete) but
 * falls back to the standard tenant alert recipients (admins/owners)
 * when the registrar is unknown — e.g. callers seeded directly into
 * the table or registered by a long-since-deactivated user.
 */
async function resolveAudience(caller: VerifiedCallerId): Promise<string[] | undefined> {
  if (caller.registeredByUserId) {
    return [caller.registeredByUserId];
  }
  try {
    const recipients = await getTenantAlertEmailRecipients(caller.tenantId, 5);
    return recipients.userIds.length > 0 ? recipients.userIds : undefined;
  } catch (err) {
    logger.warn('Failed to resolve audience for verified-caller success notification', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
    return undefined;
  }
}

/**
 * Send the in-app "your caller ID is now verified" toast. Best-effort:
 * the verification has already been recorded in the DB, so a notification
 * failure must NOT bubble up and stall the cycle.
 *
 * Uses `claimVerifiedNotificationSlot` for an atomic, race-safe one-shot
 * gate so two scheduler instances racing on the same caller (e.g.
 * blue/green deploy overlap) cannot both send a duplicate toast.
 */
async function dispatchVerifiedNotification(
  caller: VerifiedCallerId,
): Promise<'sent' | 'throttled' | 'failed'> {
  let claimed: boolean;
  try {
    claimed = await claimVerifiedNotificationSlot(caller.id, caller.tenantId);
  } catch (err) {
    logger.warn('Failed to claim verified-caller notification slot', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
    return 'failed';
  }
  if (!claimed) {
    logger.debug('Verified-caller notification skipped — another instance already claimed it', {
      tenantId: caller.tenantId,
      callerId: caller.id,
    });
    return 'throttled';
  }

  try {
    const userIds = await resolveAudience(caller);
    const inserted = await fanoutInAppNotification({
      tenantId: caller.tenantId,
      type: 'trusted_caller_verified',
      title: `Caller ID ${caller.phoneNumber} verified`,
      message: caller.friendlyName
        ? `Twilio confirmed the verification call for "${caller.friendlyName}". The number is ready to use for outbound campaigns.`
        : `Twilio confirmed the verification call. The number is ready to use for outbound campaigns.`,
      metadata: {
        link: '/trusted-callers',
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        friendlyName: caller.friendlyName,
      },
      category: 'integration',
      userIds,
    });
    return inserted > 0 ? 'sent' : 'failed';
  } catch (err) {
    logger.warn('Failed to send verified-caller success notification', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
    return 'failed';
  }
}

/**
 * Write an `audit_logs` entry for an auto-state-transition done by the
 * scheduler. Best-effort: if the audit write fails the cycle continues
 * (the actual DB row was already updated by `syncCallerIdStatus`).
 *
 * Uses `actorUserId = null, actorRole = 'system'` so the row clears the
 * `audit_logs.actor_user_id` FK to `users(id)` while still letting
 * admin tooling filter scheduler-driven transitions out of human-actor
 * reports via `actor_role = 'system'` (Task #1514, F-14).
 */
async function recordAutoTransitionAudit(
  caller: VerifiedCallerId,
  transition: 'verified' | 'failed',
): Promise<void> {
  try {
    await writeAuditLog({
      tenantId: caller.tenantId,
      actorUserId: null,
      actorRole: 'system',
      action:
        transition === 'verified'
          ? 'trusted_caller.auto_verified'
          : 'trusted_caller.auto_failed',
      resourceType: 'trusted_caller',
      resourceId: caller.id,
      severity: transition === 'failed' ? 'warning' : 'info',
      changes: {
        phoneNumber: caller.phoneNumber,
        friendlyName: caller.friendlyName,
        reason:
          transition === 'failed'
            ? 'verification_window_expired'
            : 'twilio_confirmed_outgoing_caller_id',
      },
    });
  } catch {
    // writeAuditLog already logs the underlying failure; swallow so
    // the rest of the cycle can complete. The actual state change is
    // already persisted to verified_caller_ids.
  }
}

/**
 * One full sweep. Lists every pending caller (across tenants), polls
 * Twilio for each (subject to the per-tenant cap), and dispatches a
 * success notification on the `pending → verified` transition. Rows
 * that have passed `VERIFICATION_TTL_MS` get auto-flipped to `failed`
 * by `syncCallerIdStatus` (which checks the row's
 * `verificationExpiresAt` before contacting Twilio); the scheduler
 * then writes an `audit_logs` entry for the auto-transition so
 * operators can trace which rows the system flipped vs. which were
 * flipped by hand.
 *
 * Exported so admin / test code can trigger a manual cycle without
 * waiting for the next interval.
 */
export async function runVerifiedCallerSyncCycle(): Promise<VerifiedCallerSyncCycleResult> {
  const stats = emptyCycleResult();

  let pending: VerifiedCallerId[];
  try {
    pending = await listPendingCallersToSync(MAX_PER_CYCLE);
  } catch (err) {
    logger.error('Failed to list pending verified callers', { error: String(err) });
    stats.errors += 1;
    return stats;
  }

  if (pending.length === 0) {
    logger.debug('No pending verified callers to sync');
    return stats;
  }

  const perTenantTouched = new Map<string, number>();

  for (const caller of pending) {
    const tenantBucket = getTenantBucket(stats, caller.tenantId);
    const touched = perTenantTouched.get(caller.tenantId) ?? 0;
    if (touched >= MAX_PER_TENANT_PER_CYCLE) {
      stats.deferred += 1;
      tenantBucket.deferred += 1;
      continue;
    }
    perTenantTouched.set(caller.tenantId, touched + 1);

    stats.inspected += 1;
    tenantBucket.inspected += 1;

    let updated: VerifiedCallerId;
    try {
      // syncCallerIdStatus is tenant-scoped via withTenant inside the
      // service, so RLS still applies to the actual UPDATE even though
      // the listing query above ran with row-security off.
      updated = await syncCallerIdStatus(caller.tenantId, caller.id);
    } catch (err) {
      stats.errors += 1;
      tenantBucket.errors += 1;
      logger.warn('Pending caller sync failed', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        error: String(err),
      });
      continue;
    }

    if (updated.status === 'verified' && caller.status === 'pending') {
      stats.verified += 1;
      tenantBucket.verified += 1;
      await recordAutoTransitionAudit(updated, 'verified');
      const dispatch = await dispatchVerifiedNotification(updated);
      if (dispatch === 'sent') {
        stats.notificationsSent += 1;
      } else if (dispatch === 'throttled') {
        stats.notificationsThrottled += 1;
      }
      logger.info('Pending caller auto-promoted to verified', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        notification: dispatch,
      });
    } else if (updated.status === 'failed' && caller.status === 'pending') {
      stats.failed += 1;
      tenantBucket.failed += 1;
      await recordAutoTransitionAudit(updated, 'failed');
      logger.info('Pending caller expired and was marked failed', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
      });
    } else {
      stats.stillPending += 1;
      tenantBucket.stillPending += 1;
    }
  }

  if (stats.inspected > 0 || stats.deferred > 0) {
    logger.info('Verified-caller sync cycle complete', {
      inspected: stats.inspected,
      verified: stats.verified,
      failed: stats.failed,
      stillPending: stats.stillPending,
      errors: stats.errors,
      notificationsSent: stats.notificationsSent,
      notificationsThrottled: stats.notificationsThrottled,
      deferred: stats.deferred,
      tenantCount: Object.keys(stats.byTenant).length,
      byTenant: stats.byTenant,
    });
  }
  return stats;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function safeRun(label: string): Promise<void> {
  if (running) {
    logger.debug('Verified-caller sync tick skipped — previous cycle still running');
    return;
  }
  running = true;
  try {
    await runVerifiedCallerSyncCycle();
  } catch (err) {
    logger.error(`${label} verified-caller sync cycle failed`, { error: String(err) });
  } finally {
    running = false;
  }
}

export function startVerifiedCallerSyncScheduler(
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    void safeRun('Initial');
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    void safeRun('Periodic');
  }, intervalMs);

  logger.info('Verified-caller sync scheduler started', {
    intervalMs,
    initialDelayMs: INITIAL_DELAY_MS,
    verificationTtlMs: VERIFICATION_TTL_MS,
    maxPerCycle: MAX_PER_CYCLE,
    maxPerTenantPerCycle: MAX_PER_TENANT_PER_CYCLE,
  });
}

export function stopVerifiedCallerSyncScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Verified-caller sync scheduler stopped');
  }
}
