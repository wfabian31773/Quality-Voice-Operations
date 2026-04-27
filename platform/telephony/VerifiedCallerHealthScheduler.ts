import { createLogger } from '../core/logger';
import {
  sendEmail,
  verifiedCallerExpiringEmail,
  verifiedCallerRevokedEmail,
} from '../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
} from '../notifications/NotificationPreferences';
import { getTenantAlertEmailRecipients } from '../integrations/connectors/ConnectorAlertRecipients';
import { getPlatformPool } from '../db';
import {
  EXPIRING_SOON_THRESHOLD_DAYS,
  checkCallerHealth,
  claimExpiryAlertSlot,
  listCallersDueForHealthCheck,
  recordCallerHealth,
  type CallerHealthResult,
  type VerifiedCallerId,
} from './TrustedCallerService';

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
  const { caller, result } = input;

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

  logger.info('Verified-caller health cycle complete', stats);
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
