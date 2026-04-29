import { createLogger } from '../core/logger';
import {
  sendEmail,
  verifiedCallerExpiringEmail,
  verifiedCallerRevokedEmail,
  verifiedCallerTrustHubRejectedEmail,
} from '../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
} from '../notifications/NotificationPreferences';
import { getTenantAlertEmailRecipients } from '../integrations/connectors/ConnectorAlertRecipients';
import { getPlatformPool } from '../db';
import {
  attachTrustHubRegistration,
  EXPIRING_SOON_THRESHOLD_DAYS,
  checkCallerHealth,
  claimExpiryAlertSlot,
  listCallersDueForHealthCheck,
  listCallersWithPendingTrustHub,
  promoteCallerAttestation,
  readTrustHubSnapshot,
  recordCallerHealth,
  stampExpiryAlertSlot,
  type CallerHealthResult,
  type VerifiedCallerId,
} from './TrustedCallerService';
import {
  fetchTrustHubStatus,
  simplifyStatus,
  type TrustHubResourceSnapshot,
  type TrustHubSnapshot,
} from './TrustHubService';

const logger = createLogger('VERIFIED_CALLER_HEALTH');

/**
 * Run the full sweep once a week. The check is fairly cheap (a few HTTP
 * calls per verified caller) but Twilio rate-limits the trust-hub APIs at
 * ~100 req/s per account, so a weekly cadence covers the slowest
 * `valid_until` rotation we've seen in production (90 days) with three
 * weeks of advance warning.
 */
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Wait five minutes after process boot before the first sweep so a fresh
 * deploy can finish wiring up DB pools / Twilio creds before we start
 * issuing outbound HTTP. Mirrors `ConnectorAuthAlertScheduler.INITIAL_DELAY_MS`.
 */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Treat a row as "due for re-check" once its last check is older than this.
 * Slightly less than CHECK_INTERVAL_MS so a single missed cycle can still
 * pick the row up on the next tick without waiting another full week.
 */
const STALE_AFTER_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * One alert per caller per week — matches the cycle cadence so each weekly
 * sweep can either re-alert (if the caller is still unhealthy) or stay
 * quiet (after the operator re-registered).
 */
const ALERT_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cap per-tenant email recipients to mirror the connector alert cap so a
 * single tenant with hundreds of admins can't fan out a flood of mail.
 */
const MAX_RECIPIENTS_PER_TENANT = 5;

/**
 * How many callers to fetch per DB round-trip. The cycle drains all due
 * callers by looping through batches of this size, so this is just a
 * pagination knob — not a per-cycle ceiling. Sized to keep the in-flight
 * memory + open Twilio connections bounded for very large tenants.
 */
const BATCH_SIZE = 500;

/**
 * Hard ceiling on batches per cycle. Each batch processes up to BATCH_SIZE
 * rows, so the default ceiling covers 500 * 100 = 50,000 verified callers
 * in a single weekly run — well above any realistic deployment. Mostly a
 * safety net against an infinite loop if `recordCallerHealth` keeps failing
 * for the same row (those rows would otherwise reappear in every batch
 * because their `last_health_check_at` is never advanced).
 */
const MAX_BATCHES_PER_CYCLE = 100;

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

async function getTenantName(tenantId: string): Promise<string | undefined> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ name: string | null }>(
      `SELECT name FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    return rows.length > 0 ? rows[0].name ?? undefined : undefined;
  } catch (err) {
    logger.warn('Failed to look up tenant name for verified-caller alert', {
      tenantId,
      error: String(err),
    });
    return undefined;
  }
}

export interface VerifiedCallerHealthCycleResult {
  inspected: number;
  recorded: number;
  alertsSent: number;
  emailedRecipients: number;
  throttled: number;
  unknown: number;
  errors: number;
}

interface DispatchInput {
  caller: VerifiedCallerId;
  result: CallerHealthResult;
  /**
   * When true, bypasses the weekly throttle slot (`claimExpiryAlertSlot`)
   * but still stamps `expiry_alert_sent_at` so the next automated cycle
   * keeps respecting the freshly-stamped throttle window. Used by the
   * Platform Admin "Re-issue alert" action so support can nudge a tenant
   * even if the scheduler already alerted this week.
   */
  force?: boolean;
}

function emptyCycleResult(): VerifiedCallerHealthCycleResult {
  return {
    inspected: 0,
    recorded: 0,
    alertsSent: 0,
    emailedRecipients: 0,
    throttled: 0,
    unknown: 0,
    errors: 0,
  };
}

/**
 * Send the in-app + email alert for a single caller's health result. Called
 * only for `expiring_soon`, `expired`, and `revoked` outcomes — `healthy`
 * and `unknown` are silently recorded by the cycle loop.
 *
 * Uses `claimExpiryAlertSlot` for an atomic, race-safe weekly throttle
 * that mirrors `ConnectorAuthAlertScheduler.claimAuthAlertSlot`. Two
 * scheduler instances (e.g. blue/green deploy overlap) cannot both win
 * the claim for the same caller in the same week.
 */
export async function dispatchVerifiedCallerAlert(
  input: DispatchInput,
): Promise<{ status: 'sent' | 'throttled' | 'no_recipients'; emailedRecipients: number }> {
  const { caller, result, force } = input;

  if (force) {
    // Operator-triggered re-issue: skip the conditional claim and
    // unconditionally stamp the slot so the next automated cycle still
    // respects the freshly-stamped throttle window. Mirrors the
    // `stampAuthAlertSlot` path in `ConnectorAuthAlertScheduler`.
    await stampExpiryAlertSlot(caller.id, caller.tenantId);
  } else {
    const claimed = await claimExpiryAlertSlot(
      caller.id,
      caller.tenantId,
      ALERT_THROTTLE_MS,
    );
    if (!claimed) {
      logger.debug('Verified-caller alert throttled (slot claim lost)', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        status: result.status,
      });
      return { status: 'throttled', emailedRecipients: 0 };
    }
  }

  const tenantName = await getTenantName(caller.tenantId);
  const recipientsResult = await getTenantAlertEmailRecipients(
    caller.tenantId,
    MAX_RECIPIENTS_PER_TENANT,
  );

  const trustedCallersUrl = `${appBaseUrl().replace(/\/$/, '')}/trusted-callers`;
  const isRevoked = result.status === 'revoked';
  const isExpired = result.status === 'expired';

  // Title / message tuned per status so the in-app feed reads naturally.
  let title: string;
  let inAppMessage: string;
  if (isRevoked) {
    title = `Verified caller ${caller.phoneNumber} was revoked by Twilio`;
    inAppMessage =
      result.message ??
      'Twilio no longer reports this number as verified. Re-verify to restore A-attestation.';
  } else if (isExpired) {
    title = `Verified caller ${caller.phoneNumber} has expired`;
    inAppMessage =
      'Carrier attestation lapsed. Re-register to keep outbound calls at level A.';
  } else {
    const daysRemaining = result.expiresAt
      ? Math.max(
          0,
          Math.ceil((result.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        )
      : EXPIRING_SOON_THRESHOLD_DAYS;
    title = `Verified caller ${caller.phoneNumber} expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
    inAppMessage =
      result.message ??
      `Re-register before the Trust Hub product expires to keep A-attestation.`;
  }

  // Notification type drives the user-preferences mapping in
  // categoryForNotificationType — both flavors map to the `integration`
  // toggle so a tenant that silenced connector alerts also silences these.
  const notificationType = isRevoked ? 'trusted_caller_revoked' : 'trusted_caller_expiry';

  try {
    await fanoutInAppNotification({
      tenantId: caller.tenantId,
      type: notificationType,
      title,
      message: inAppMessage,
      metadata: {
        link: '/trusted-callers',
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        friendlyName: caller.friendlyName,
        status: result.status,
        expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
        detail: result.message,
      },
      category: 'integration',
      userIds: recipientsResult.userIds,
    });
  } catch (err) {
    logger.warn('Failed to fan out verified-caller in-app alert', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
  }

  if (recipientsResult.emails.length === 0) {
    logger.info('Verified-caller alert: no admin recipients', {
      tenantId: caller.tenantId,
      callerId: caller.id,
    });
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  const recipients = await filterEmailRecipientsByPreference(
    caller.tenantId,
    recipientsResult.emails,
    'integration',
  );
  if (recipients.length === 0) {
    logger.info('Verified-caller alert: all recipients opted out of integration emails', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      removed: recipientsResult.emails.length,
    });
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  let subject: string;
  let html: string;
  let text: string;
  if (isRevoked) {
    const tpl = verifiedCallerRevokedEmail({
      tenantName,
      phoneNumber: caller.phoneNumber,
      friendlyName: caller.friendlyName,
      trustedCallersUrl,
      detail:
        result.message ??
        'Twilio no longer reports this number as a verified outbound caller.',
    });
    subject = tpl.subject;
    html = tpl.html;
    text = tpl.text;
  } else {
    const expiresAt = result.expiresAt ?? new Date(Date.now() + ALERT_THROTTLE_MS);
    const daysRemaining = Math.max(
      0,
      Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    );
    const tpl = verifiedCallerExpiringEmail({
      tenantName,
      phoneNumber: caller.phoneNumber,
      friendlyName: caller.friendlyName,
      daysRemaining,
      expiresAt: expiresAt.toUTCString(),
      trustedCallersUrl,
      detail: result.message,
    });
    subject = tpl.subject;
    html = tpl.html;
    text = tpl.text;
  }

  let delivered = 0;
  for (const to of recipients) {
    try {
      const sendResult = await sendEmail({ to, subject, html, text });
      if (sendResult.success) {
        delivered += 1;
      } else {
        logger.warn('Verified-caller alert email send failed', {
          tenantId: caller.tenantId,
          callerId: caller.id,
          to,
          error: sendResult.error,
        });
      }
    } catch (err) {
      logger.warn('Verified-caller alert email threw', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        to,
        error: String(err),
      });
    }
  }

  if (delivered === 0 && recipients.length > 0) {
    logger.error('Verified-caller alert claim succeeded but zero emails delivered', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      attemptedRecipients: recipients.length,
      status: result.status,
    });
  }

  logger.info('Verified-caller alert dispatched', {
    tenantId: caller.tenantId,
    callerId: caller.id,
    phoneNumber: caller.phoneNumber,
    status: result.status,
    recipients: recipients.length,
    delivered,
  });

  return { status: 'sent', emailedRecipients: delivered };
}

/**
 * One full sweep. Drains every caller currently due for a re-check by
 * looping through batches of `BATCH_SIZE` rows — `recordCallerHealth`
 * advances `last_health_check_at` so processed rows naturally drop out
 * of the next batch query. Continues until either no more rows are due
 * or `MAX_BATCHES_PER_CYCLE` is reached (the latter is a safety net,
 * not a per-cycle ceiling).
 *
 * Exported so admin / test code can trigger a manual cycle without
 * waiting a week.
 */
export async function runVerifiedCallerHealthCycle(): Promise<VerifiedCallerHealthCycleResult> {
  const stats = emptyCycleResult();

  // Track caller IDs we've already attempted in this cycle. If a row's
  // `recordCallerHealth` write fails, its `last_health_check_at` is not
  // advanced and the next batch query would return it again forever — the
  // skip-set breaks that loop within a single cycle while still letting
  // the next weekly tick retry from scratch.
  const alreadySeen = new Set<string>();
  let ceilingHit = true;

  for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_CYCLE; batchIndex += 1) {
    let batch: VerifiedCallerId[];
    try {
      batch = await listCallersDueForHealthCheck(STALE_AFTER_MS, BATCH_SIZE);
    } catch (err) {
      logger.error('Failed to list verified callers due for health check', {
        batchIndex,
        error: String(err),
      });
      ceilingHit = false;
      break;
    }

    if (batch.length === 0) {
      ceilingHit = false;
      break;
    }

    // Filter out anything we've already attempted this cycle. If the
    // entire batch is "already-seen" we're stuck and need to bail rather
    // than spin forever.
    const fresh = batch.filter((c) => !alreadySeen.has(c.id));
    if (fresh.length === 0) {
      logger.warn('Verified-caller health cycle bailing: due batch is entirely already-seen rows', {
        batchIndex,
        batchSize: batch.length,
      });
      ceilingHit = false;
      break;
    }

    stats.inspected += fresh.length;

    for (const caller of fresh) {
      alreadySeen.add(caller.id);

      let result: CallerHealthResult;
      try {
        result = await checkCallerHealth(caller);
      } catch (err) {
        // Should not normally happen — checkCallerHealth catches network
        // errors itself and returns `unknown`. Defensive: treat any
        // leaked throw as `unknown` and keep moving so one bad caller
        // doesn't kill the cycle.
        logger.warn('checkCallerHealth threw unexpectedly; recording as unknown', {
          tenantId: caller.tenantId,
          callerId: caller.id,
          error: String(err),
        });
        stats.errors += 1;
        result = {
          status: 'unknown',
          expiresAt: null,
          message: `Health check threw: ${String(err).slice(0, 200)}`,
          demoteAttestation: false,
        };
      }

      try {
        await recordCallerHealth(caller.id, caller.tenantId, result);
        stats.recorded += 1;
      } catch (err) {
        logger.warn('Failed to record verified caller health result', {
          tenantId: caller.tenantId,
          callerId: caller.id,
          error: String(err),
        });
        stats.errors += 1;
        // Keep going — we still want to alert on this cycle if the alert
        // dispatch can succeed despite the DB write failure. The
        // alreadySeen guard prevents the row from re-appearing in the
        // next batch.
      }

      if (result.status === 'unknown') {
        stats.unknown += 1;
        continue;
      }
      if (result.status === 'healthy') {
        continue;
      }

      const dispatch = await dispatchVerifiedCallerAlert({ caller, result });
      if (dispatch.status === 'sent') {
        stats.alertsSent += 1;
        stats.emailedRecipients += dispatch.emailedRecipients;
      } else if (dispatch.status === 'throttled') {
        stats.throttled += 1;
      }
    }

    // If this batch wasn't full, there can't be more due rows after
    // this — short-circuit instead of paying for a final empty query.
    if (batch.length < BATCH_SIZE) {
      ceilingHit = false;
      break;
    }
  }

  if (stats.inspected === 0) {
    logger.debug('No verified callers due for health check');
    return stats;
  }

  if (ceilingHit) {
    // We exhausted MAX_BATCHES_PER_CYCLE without ever getting a partial
    // / empty batch. That means more callers were still due when we
    // stopped, so this run did NOT cover every verified caller in one
    // weekly tick — operators should know coverage was partial so they
    // can either lift the ceiling or shorten the cycle interval.
    logger.error('Verified-caller health cycle hit MAX_BATCHES_PER_CYCLE — coverage was partial', {
      maxBatchesPerCycle: MAX_BATCHES_PER_CYCLE,
      batchSize: BATCH_SIZE,
      inspected: stats.inspected,
    });
  }

  logger.info('Verified-caller health cycle complete', { ...stats });
  return stats;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startVerifiedCallerHealthScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runVerifiedCallerHealthCycle().catch((err) => {
      logger.error('Initial verified-caller health cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runVerifiedCallerHealthCycle().catch((err) => {
      logger.error('Verified-caller health cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Verified-caller health scheduler started', {
    intervalMs,
    expiringSoonThresholdDays: EXPIRING_SOON_THRESHOLD_DAYS,
  });
}

export function stopVerifiedCallerHealthScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Verified-caller health scheduler stopped');
  }
}

// ============================================================================
// Trust Hub status poll
//
// Twilio Trust Hub bundles (Customer Profile, SHAKEN/STIR Trust Product,
// A2P Brand Registration) take days to be reviewed by carriers. Until
// they flip to a terminal state nothing in the product surfaces the
// updated status — the row only refreshes when an admin re-opens the
// wizard. The daily poll below calls `fetchTrustHubStatus` for every
// caller whose bundle is still in flight, persists the live snapshot
// via `attachTrustHubRegistration`, and reacts to two transitions:
//
//   1. Any resource flipped from non-rejected to `twilio-rejected` /
//      `FAILED` / `REJECTED` / `SUSPENDED`. We notify the operator with
//      the Twilio `failure_reason` so they can re-submit the bundle.
//   2. The SHAKEN/STIR Trust Product flipped from non-approved to
//      `twilio-approved`. We promote the row's stored attestation level
//      to `A` so outbound campaigns immediately benefit from carrier
//      attestation without waiting for the operator to click around.
//
// De-duplication is structural rather than slot-based: the diff is
// computed against the prior `metadata.trustHub` snapshot. After a
// transition fires, the new snapshot is persisted, so the next cycle
// sees prior == current and stays quiet.
// ============================================================================

/**
 * Daily cadence — Twilio's carrier review SLA is measured in days, not
 * hours, so polling more often just burns rate-limit budget. A daily
 * sweep gives us at least one detection per business day per pending
 * bundle.
 */
const TRUST_HUB_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Wait five minutes after process boot before the first sweep. Mirrors
 * the health scheduler's INITIAL_DELAY_MS so the daily and weekly
 * timers stagger naturally and never both fire on the same boot tick.
 */
const TRUST_HUB_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Page size for the pending-bundle drain. Each row makes up to three
 * Twilio Trust Hub HTTP calls (Customer Profile, Trust Product, Brand)
 * via `fetchTrustHubStatus`. 200 rows × 3 = 600 calls — well under
 * Twilio's ~100 req/s account ceiling even for back-to-back retries.
 * The cycle keeps fetching pages until every pending bundle has been
 * processed (see `TRUST_HUB_MAX_BATCHES_PER_CYCLE` for the safety
 * ceiling that protects us from runaway loops).
 */
const TRUST_HUB_BATCH_SIZE = 200;

/**
 * Hard ceiling on number of pages drained per cycle as a runaway
 * guard. 50 batches × 200 rows = 10 000 callers per cycle — more than
 * enough headroom for any realistic tenant footprint while still
 * preventing an infinite loop if `lastSyncedAt` ordering breaks for
 * some reason. If this ceiling is ever reached we log loudly so
 * operators know coverage was partial and can lift the cap.
 */
const TRUST_HUB_MAX_BATCHES_PER_CYCLE = 50;

const TRUST_HUB_REJECTED_VALUES = new Set([
  'twilio-rejected',
  'rejected',
  'failed',
  'suspended',
]);

const TRUST_HUB_APPROVED_VALUES = new Set([
  'twilio-approved',
  'approved',
]);

interface ResourceTransition {
  resource: 'customerProfile' | 'trustProduct' | 'brand';
  prior: TrustHubResourceSnapshot | null;
  next: TrustHubResourceSnapshot;
}

function pickResource(snapshot: TrustHubSnapshot, key: ResourceTransition['resource']): TrustHubResourceSnapshot | null {
  if (key === 'brand') return snapshot.brand;
  if (key === 'customerProfile') return snapshot.customerProfile;
  return snapshot.trustProduct;
}

function isRejected(status: string | null | undefined): boolean {
  return TRUST_HUB_REJECTED_VALUES.has((status ?? '').toLowerCase());
}

function isApproved(status: string | null | undefined): boolean {
  return TRUST_HUB_APPROVED_VALUES.has((status ?? '').toLowerCase());
}

function resourceLabel(resource: ResourceTransition['resource']):
  'Customer Profile' | 'SHAKEN/STIR Trust Product' | 'A2P Brand Registration' {
  if (resource === 'customerProfile') return 'Customer Profile';
  if (resource === 'trustProduct') return 'SHAKEN/STIR Trust Product';
  return 'A2P Brand Registration';
}

/**
 * Returns true when the live snapshot looks like a fetch failure —
 * every resource we have a SID for came back without a status. Without
 * this guard a transient Twilio 5xx / 401 would erase the prior status
 * from `metadata.trustHub`, flip the badge to "draft", and never
 * recover until the operator re-opened the wizard.
 */
function isEmptyLiveSnapshot(live: TrustHubSnapshot): boolean {
  const cpMissing = live.customerProfile.sid !== null && !live.customerProfile.status;
  const tpMissing = live.trustProduct.sid !== null && !live.trustProduct.status;
  const brandMissing = live.brand !== null && live.brand.sid !== null && !live.brand.status;
  // If we had SIDs for every present resource and got nothing back, treat as a fetch miss.
  if (live.customerProfile.sid && cpMissing && live.trustProduct.sid && tpMissing) {
    if (!live.brand || !live.brand.sid) return true;
    if (brandMissing) return true;
  }
  return false;
}

export interface TrustHubStatusCycleResult {
  inspected: number;
  refreshed: number;
  rejectionsAlerted: number;
  approvalsPromoted: number;
  emailedRecipients: number;
  unchanged: number;
  fetchFailures: number;
  errors: number;
}

function emptyTrustHubCycleResult(): TrustHubStatusCycleResult {
  return {
    inspected: 0,
    refreshed: 0,
    rejectionsAlerted: 0,
    approvalsPromoted: 0,
    emailedRecipients: 0,
    unchanged: 0,
    fetchFailures: 0,
    errors: 0,
  };
}

/**
 * Fan out the in-app + email alert for a Trust Hub bundle that just
 * flipped to a rejected state. The detail payload includes Twilio's
 * `failure_reason` so operators can act without bouncing into the
 * Twilio console.
 *
 * Best-effort: failures are logged but do not bubble up — the rejection
 * is already persisted on the row, so we don't want a flaky email
 * provider to block the snapshot write.
 */
export async function dispatchTrustHubRejectionAlert(input: {
  caller: VerifiedCallerId;
  transition: ResourceTransition;
}): Promise<{ status: 'sent' | 'no_recipients'; emailedRecipients: number }> {
  const { caller, transition } = input;
  const failureReason =
    transition.next.failureReason && transition.next.failureReason.trim().length > 0
      ? transition.next.failureReason
      : 'Twilio did not return a specific failure reason.';
  const tenantName = await getTenantName(caller.tenantId);
  const recipientsResult = await getTenantAlertEmailRecipients(
    caller.tenantId,
    MAX_RECIPIENTS_PER_TENANT,
  );
  const trustedCallersUrl = `${appBaseUrl().replace(/\/$/, '')}/trusted-callers`;
  const label = resourceLabel(transition.resource);
  const title = `Trust Hub ${label} rejected for ${caller.phoneNumber}`;
  const inAppMessage = failureReason;

  try {
    await fanoutInAppNotification({
      tenantId: caller.tenantId,
      type: 'trusted_caller_trust_hub_rejected',
      title,
      message: inAppMessage,
      metadata: {
        link: '/trusted-callers',
        callerId: caller.id,
        phoneNumber: caller.phoneNumber,
        friendlyName: caller.friendlyName,
        resource: transition.resource,
        priorStatus: transition.prior?.status ?? null,
        nextStatus: transition.next.status,
        failureReason,
      },
      category: 'integration',
      userIds: recipientsResult.userIds,
    });
  } catch (err) {
    logger.warn('Failed to fan out Trust Hub rejection in-app alert', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
  }

  if (recipientsResult.emails.length === 0) {
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  const recipients = await filterEmailRecipientsByPreference(
    caller.tenantId,
    recipientsResult.emails,
    'integration',
  );
  if (recipients.length === 0) {
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  const tpl = verifiedCallerTrustHubRejectedEmail({
    tenantName,
    phoneNumber: caller.phoneNumber,
    friendlyName: caller.friendlyName,
    resourceLabel: label,
    failureReason,
    trustedCallersUrl,
  });

  let delivered = 0;
  for (const to of recipients) {
    try {
      const sendResult = await sendEmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
      if (sendResult.success) {
        delivered += 1;
      } else {
        logger.warn('Trust Hub rejection alert email send failed', {
          tenantId: caller.tenantId,
          callerId: caller.id,
          to,
          error: sendResult.error,
        });
      }
    } catch (err) {
      logger.warn('Trust Hub rejection alert email threw', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        to,
        error: String(err),
      });
    }
  }

  logger.info('Trust Hub rejection alert dispatched', {
    tenantId: caller.tenantId,
    callerId: caller.id,
    phoneNumber: caller.phoneNumber,
    resource: transition.resource,
    failureReason,
    recipients: recipients.length,
    delivered,
  });

  return { status: 'sent', emailedRecipients: delivered };
}

/**
 * Diff a prior snapshot against a freshly fetched one and return the
 * resource-level transitions worth acting on this cycle. Only emits a
 * transition when the current status is rejected (worth alerting) or
 * the trust product is newly approved (worth promoting). Approvals on
 * the customer profile or brand registration ride along in the
 * persisted snapshot but don't fire a separate notification — only the
 * trust product gates SHAKEN/STIR attestation.
 */
function diffTransitions(
  prior: TrustHubSnapshot | null,
  next: TrustHubSnapshot,
): {
  rejections: ResourceTransition[];
  trustProductApproved: ResourceTransition | null;
} {
  const rejections: ResourceTransition[] = [];
  let trustProductApproved: ResourceTransition | null = null;

  for (const key of ['customerProfile', 'trustProduct', 'brand'] as const) {
    const nextRes = pickResource(next, key);
    if (!nextRes) continue;
    const priorRes = prior ? pickResource(prior, key) : null;

    if (isRejected(nextRes.status) && !isRejected(priorRes?.status)) {
      rejections.push({ resource: key, prior: priorRes, next: nextRes });
    }

    if (
      key === 'trustProduct' &&
      isApproved(nextRes.status) &&
      !isApproved(priorRes?.status)
    ) {
      trustProductApproved = { resource: key, prior: priorRes, next: nextRes };
    }
  }

  return { rejections, trustProductApproved };
}

/**
 * One full sweep of pending Trust Hub bundles. Polls Twilio for each
 * caller, persists the live snapshot, and reacts to rejection /
 * approval transitions. Best-effort per-row: a failure for one caller
 * does not stall the cycle — the row is logged and the loop continues.
 *
 * Exported so admin / test code can trigger a manual cycle without
 * waiting for the daily timer.
 */
export async function runTrustHubStatusCycle(): Promise<TrustHubStatusCycleResult> {
  const stats = emptyTrustHubCycleResult();

  // Drain pending bundles page-by-page rather than capping at a single
  // batch — the daily SLA only holds if every pending caller is
  // actually polled. `seenIds` defends against the same row reappearing
  // in subsequent pages: after we persist a refreshed snapshot the row
  // sorts to the back of the `lastSyncedAt` ordering, but the SQL
  // predicate doesn't *exclude* it (it might still be pending), so
  // without de-dup we'd loop forever on a single tenant's queue.
  const seenIds = new Set<string>();
  let batchIndex = 0;

  while (batchIndex < TRUST_HUB_MAX_BATCHES_PER_CYCLE) {
    let page: VerifiedCallerId[];
    try {
      page = await listCallersWithPendingTrustHub(TRUST_HUB_BATCH_SIZE);
    } catch (err) {
      logger.error('Failed to list callers with pending Trust Hub bundles', {
        error: String(err),
        batchIndex,
      });
      stats.errors += 1;
      return stats;
    }

    if (page.length === 0) {
      if (batchIndex === 0) {
        logger.debug('No pending Trust Hub bundles to refresh');
      }
      break;
    }

    const fresh = page.filter((c) => !seenIds.has(c.id));
    if (fresh.length === 0) {
      // Every row in this page has already been processed this cycle —
      // they are still pending after a Twilio refresh, so we're done
      // for the day. The remainder will reorder naturally for the next
      // sweep.
      break;
    }

    for (const caller of fresh) {
      seenIds.add(caller.id);
      await processPendingTrustHubCaller(caller, stats);
    }

    batchIndex += 1;
  }

  if (batchIndex >= TRUST_HUB_MAX_BATCHES_PER_CYCLE) {
    logger.error(
      'Trust Hub status cycle hit MAX_BATCHES_PER_CYCLE — coverage was partial',
      {
        maxBatches: TRUST_HUB_MAX_BATCHES_PER_CYCLE,
        batchSize: TRUST_HUB_BATCH_SIZE,
        inspected: stats.inspected,
      },
    );
  }

  logger.info('Trust Hub status cycle complete', { ...stats });
  return stats;
}

/**
 * Refresh a single pending caller in-place. Extracted from
 * `runTrustHubStatusCycle` so the per-row work has a clean unit test
 * and so the drain loop reads as a thin orchestrator. Mutates the
 * shared `stats` object — best-effort: failures are logged and the
 * loop continues.
 */
async function processPendingTrustHubCaller(
  caller: VerifiedCallerId,
  stats: TrustHubStatusCycleResult,
): Promise<void> {
  stats.inspected += 1;
  const prior = readTrustHubSnapshot(caller);

  let live: TrustHubSnapshot | null = null;
  try {
    live = await fetchTrustHubStatus({
      customerProfileSid: caller.trustHubProfileSid,
      trustProductSid: caller.trustProductSid,
      brandSid: caller.brandSid,
      businessInfoEndUserSid: prior?.businessInfoEndUserSid ?? null,
      addressEndUserSid: prior?.addressEndUserSid ?? null,
      representativeEndUserSid: prior?.representativeEndUserSid ?? null,
    });
  } catch (err) {
    stats.fetchFailures += 1;
    logger.warn('Trust Hub fetch failed for caller; will retry next cycle', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
    return;
  }

  if (!live || isEmptyLiveSnapshot(live)) {
    stats.fetchFailures += 1;
    logger.warn('Trust Hub fetch returned empty snapshot; preserving prior state', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      hadCreds: live !== null,
    });
    return;
  }
  const fresh: TrustHubSnapshot = live;

  try {
    await attachTrustHubRegistration(caller.tenantId, caller.id, fresh, { source: 'sync' });
    stats.refreshed += 1;
  } catch (err) {
    stats.errors += 1;
    logger.warn('Failed to persist refreshed Trust Hub snapshot', {
      tenantId: caller.tenantId,
      callerId: caller.id,
      error: String(err),
    });
    // Do not bail on the diff — the fetched snapshot is still in
    // memory so we can still act on transitions. Worst case the next
    // cycle re-detects them after a successful write.
  }

  const { rejections, trustProductApproved } = diffTransitions(prior, fresh);

  if (
    rejections.length === 0 &&
    !trustProductApproved &&
    simplifyStatus(prior?.customerProfile.status) === simplifyStatus(fresh.customerProfile.status) &&
    simplifyStatus(prior?.trustProduct.status) === simplifyStatus(fresh.trustProduct.status) &&
    simplifyStatus(prior?.brand?.status) === simplifyStatus(fresh.brand?.status)
  ) {
    stats.unchanged += 1;
  }

  for (const transition of rejections) {
    try {
      const dispatch = await dispatchTrustHubRejectionAlert({ caller, transition });
      if (dispatch.status === 'sent') {
        stats.rejectionsAlerted += 1;
        stats.emailedRecipients += dispatch.emailedRecipients;
      }
    } catch (err) {
      stats.errors += 1;
      logger.warn('Trust Hub rejection alert dispatch threw', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        resource: transition.resource,
        error: String(err),
      });
    }
  }

  if (trustProductApproved) {
    try {
      const promoted = await promoteCallerAttestation(caller.tenantId, caller.id, 'A');
      if (promoted) {
        stats.approvalsPromoted += 1;
        logger.info('Promoted caller to A-attestation after SHAKEN/STIR approval', {
          tenantId: caller.tenantId,
          callerId: caller.id,
          phoneNumber: caller.phoneNumber,
          priorAttestation: caller.attestationLevel,
        });
        // Fire-and-forget in-app toast so the operator hears the
        // good news without polling. No email — approvals are not
        // urgent enough to warrant inbox interruption.
        try {
          await fanoutInAppNotification({
            tenantId: caller.tenantId,
            type: 'trusted_caller_trust_hub_approved',
            title: `SHAKEN/STIR approved for ${caller.phoneNumber}`,
            message: caller.friendlyName
              ? `Twilio approved the SHAKEN/STIR Trust Product for "${caller.friendlyName}". Outbound campaigns now attest at level A.`
              : `Twilio approved the SHAKEN/STIR Trust Product. Outbound campaigns now attest at level A.`,
            metadata: {
              link: '/trusted-callers',
              callerId: caller.id,
              phoneNumber: caller.phoneNumber,
              friendlyName: caller.friendlyName,
              attestationLevel: 'A',
            },
            category: 'integration',
          });
        } catch (err) {
          logger.warn('Failed to fan out SHAKEN/STIR approval toast', {
            tenantId: caller.tenantId,
            callerId: caller.id,
            error: String(err),
          });
        }
      }
    } catch (err) {
      stats.errors += 1;
      logger.warn('Failed to promote caller attestation after approval', {
        tenantId: caller.tenantId,
        callerId: caller.id,
        error: String(err),
      });
    }
  }
}

let trustHubTimer: ReturnType<typeof setInterval> | null = null;
let trustHubInitialTimer: ReturnType<typeof setTimeout> | null = null;
let trustHubRunning = false;

async function safeRunTrustHub(label: string): Promise<void> {
  if (trustHubRunning) {
    logger.debug('Trust Hub status tick skipped — previous cycle still running');
    return;
  }
  trustHubRunning = true;
  try {
    await runTrustHubStatusCycle();
  } catch (err) {
    logger.error(`${label} Trust Hub status cycle failed`, { error: String(err) });
  } finally {
    trustHubRunning = false;
  }
}

export function startTrustHubStatusScheduler(
  intervalMs: number = TRUST_HUB_INTERVAL_MS,
): void {
  if (trustHubTimer) return;

  trustHubInitialTimer = setTimeout(() => {
    void safeRunTrustHub('Initial');
  }, TRUST_HUB_INITIAL_DELAY_MS);

  trustHubTimer = setInterval(() => {
    void safeRunTrustHub('Periodic');
  }, intervalMs);

  logger.info('Trust Hub status scheduler started', {
    intervalMs,
    initialDelayMs: TRUST_HUB_INITIAL_DELAY_MS,
    batchSize: TRUST_HUB_BATCH_SIZE,
    maxBatchesPerCycle: TRUST_HUB_MAX_BATCHES_PER_CYCLE,
  });
}

export function stopTrustHubStatusScheduler(): void {
  if (trustHubInitialTimer) {
    clearTimeout(trustHubInitialTimer);
    trustHubInitialTimer = null;
  }
  if (trustHubTimer) {
    clearInterval(trustHubTimer);
    trustHubTimer = null;
    logger.info('Trust Hub status scheduler stopped');
  }
}
