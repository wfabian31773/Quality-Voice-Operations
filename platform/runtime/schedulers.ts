/**
 * Single registry of the background schedulers (PR-00, Render migration).
 *
 * Before PR-00 this list lived inline in `server/admin-api/start.ts`. It is
 * now shared by:
 *   - the admin API, which starts schedulers only for role `all` (Replit) so
 *     behavior there is unchanged, in the same order as before;
 *   - `server/worker/start.ts` (role `worker`, Render), which starts them only
 *     while it holds the Postgres advisory-lock leadership;
 *   - `server/jobs/run.ts nightly` (role `cron`, Render), which calls the
 *     run-once function of every scheduler marked `nightly`.
 *
 * Names are stable identifiers used by SCHEDULERS_ENABLED, logs and docs.
 * Do not rename an entry without updating docs/deploy/render.md and any
 * SCHEDULERS_ENABLED values set in Render/Replit.
 */
import { startUsageMeteringWorker, stopUsageMeteringWorker } from '../billing/stripe/usage';
import {
  type CampaignScheduler,
  startCampaignScheduler,
  stopCampaignScheduler,
  startFederalDncSyncScheduler,
  stopFederalDncSyncScheduler,
} from '../campaigns';
import { startMetricsRollup, stopMetricsRollup, startSystemMetricsWriter, stopSystemMetricsWriter } from '../core/observability';
import { startUsageGuardrailsScheduler, stopUsageGuardrailsScheduler } from '../billing/guardrails/UsageGuardrails';
import { startInsightsScheduler, stopInsightsScheduler, startCallViewDigestScheduler, stopCallViewDigestScheduler, startCsatExpirationScheduler, stopCsatExpirationScheduler } from '../analytics';
import { startWorkforceScheduler, stopWorkforceScheduler } from '../workforce/WorkforceScheduler';
import { startGinScheduler, stopGinScheduler } from '../gin';
import { startMilestoneScheduler, stopMilestoneScheduler } from '../analytics/MilestoneScheduler';
import { startDocsFeedbackAlertScheduler, stopDocsFeedbackAlertScheduler, runDocsFeedbackAlertCycle, runDocsFeedbackPendingReplyAlertCycle } from '../help/DocsFeedbackAlertScheduler';
import { startDocsFeedbackReplyDigestScheduler, stopDocsFeedbackReplyDigestScheduler, runDocsFeedbackReplyDigestCycle } from '../help/DocsFeedbackReplyDigestScheduler';
import { startDocsFeedbackReplyRetryScheduler, stopDocsFeedbackReplyRetryScheduler } from '../help/DocsFeedbackReplyRetryScheduler';
import { startSupportReplyRetryScheduler, stopSupportReplyRetryScheduler } from '../help/SupportReplyRetryScheduler';
import { startRetryAttemptsCleanupScheduler, stopRetryAttemptsCleanupScheduler } from '../help/RetryAttemptsCleanupScheduler';
import { startConnectorAuthAlertScheduler, stopConnectorAuthAlertScheduler } from '../integrations/connectors/ConnectorAuthAlertScheduler';
import { startConnectorStaleAlertScheduler, stopConnectorStaleAlertScheduler, runConnectorStaleAlertCycle, type StaleAlertCycleResult } from '../integrations/connectors/ConnectorStaleAlertScheduler';
import { startVerifiedCallerHealthScheduler, stopVerifiedCallerHealthScheduler, startTrustHubStatusScheduler, stopTrustHubStatusScheduler } from '../telephony/VerifiedCallerHealthScheduler';
import { startVerifiedCallerSyncScheduler, stopVerifiedCallerSyncScheduler } from '../telephony/VerifiedCallerSyncScheduler';
import {
  startConnectorOutboxDrainScheduler,
  stopConnectorOutboxDrainScheduler,
  startOutboxArchiveSweepScheduler,
  stopOutboxArchiveSweepScheduler,
  runOutboxArchiveSweepCycle,
} from '../integrations/connectors/ConnectorOutboxDrainScheduler';
import { startSchedulingDriftAlertScheduler, stopSchedulingDriftAlertScheduler } from '../integrations/connectors/SchedulingDriftAlertScheduler';
import { startOAuthTokenRefreshScheduler, stopOAuthTokenRefreshScheduler, startCrmCallerIdentityRevalidationScheduler, stopCrmCallerIdentityRevalidationScheduler, startCrmStaleCacheRetentionScheduler, stopCrmStaleCacheRetentionScheduler } from '../integrations/connectors';
import { runCrmStaleCacheRetentionCycle } from '../integrations/connectors/CrmStaleCacheRetentionScheduler';
import { startCallEventsRetentionScheduler, stopCallEventsRetentionScheduler, runCallEventsRetentionCycle } from '../billing/CallEventsRetentionScheduler';
import { startTenantIsolationScheduler, stopTenantIsolationScheduler, runTenantIsolationScheduledCycle, type IsolationSchedulerCycleResult } from '../security/TenantIsolationScheduler';
import { startEncryptionReminderScheduler, stopEncryptionReminderScheduler, runEncryptionReminderCycle, type ReminderCycleResult } from '../security/EncryptionReminderScheduler';
import { startRouteExportArchiveCleanupScheduler, stopRouteExportArchiveCleanupScheduler } from '../dispatch/RouteExportArchiveCleanupScheduler';
import { startPlanRecommendationDigestScheduler, stopPlanRecommendationDigestScheduler, runPlanRecommendationDigestCycle, type RecommendationCycleResult } from '../billing/PlanRecommendationDigestScheduler';
import { startRecommendationDirectionDigestScheduler, stopRecommendationDirectionDigestScheduler, runRecommendationDirectionDigestCycle, type DirectionDigestCycleResult } from '../billing/RecommendationDirectionDigestScheduler';
import { startStripePriceVerificationScheduler, stopStripePriceVerificationScheduler, runStripePriceVerificationCycle } from '../billing/StripePriceVerificationScheduler';
import { startMarketplaceDiscountBackfillScheduler, stopMarketplaceDiscountBackfillScheduler } from '../billing/MarketplaceDiscountBackfillScheduler';
import { startPortalConfigCleanupScheduler, stopPortalConfigCleanupScheduler, runPortalConfigCleanupCycle, type PortalConfigCleanupSnapshot } from '../billing/PortalConfigCleanupScheduler';
import { startBillingReconciliationScheduler, stopBillingReconciliationScheduler, runReconciliationCycle, type ReconciliationCycleSummary } from '../billing/BillingReconciliationScheduler';
import type { ProcessRole } from './processRole';

export interface SchedulerContext {
  /** Public voice-gateway base URL used for campaign TwiML/status callbacks. */
  voiceGatewayBaseUrl: string;
}

export interface SchedulerDefinition {
  /** Stable name (SCHEDULERS_ENABLED, logs, docs). */
  name: string;
  start: (ctx: SchedulerContext) => void;
  stop: () => void;
  /**
   * Run-once body of a daily scheduler. Entries that have one run from the
   * `qvo-nightly` cron on Render (`server/jobs/run.ts nightly`), and the
   * worker never starts their interval version, so they cannot run twice.
   */
  nightly?: () => Promise<unknown>;
  /**
   * Reads the result `nightly` resolved with and returns a short failure
   * reason when the run-once function caught its own error and reported it
   * in the result instead of throwing. Fixed strings only (no values).
   */
  nightlyFailed?: (result: unknown) => string | null;
  /** Returns a skip reason when the scheduler cannot run in this environment. */
  skipReason?: (env: Record<string, string | undefined>) => string | null;
  /**
   * True while a tick is mid-flight (it may hold no DB client, e.g. while
   * awaiting Twilio). The worker's shutdown waits for this to clear.
   */
  inFlight?: () => boolean;
}

/**
 * Last campaign scheduler started here. Kept after stop() (which only clears
 * the interval) so shutdown can still see a tick that is mid-flight.
 */
let campaignScheduler: CampaignScheduler | null = null;

/**
 * CampaignScheduler's private `running` flag is set for the whole tick
 * (cleared in its finally). Read-only access here until it exposes a public
 * `isTicking()` getter (requested from the campaigns lane).
 */
function campaignTickInFlight(): boolean {
  return (campaignScheduler as unknown as { running?: boolean } | null)?.running === true;
}

/** Order matches the pre-PR-00 start order in server/admin-api/start.ts. */
export const SCHEDULERS: readonly SchedulerDefinition[] = [
  { name: 'usage-metering', start: () => startUsageMeteringWorker(), stop: stopUsageMeteringWorker },
  { name: 'metrics-rollup', start: () => startMetricsRollup(), stop: stopMetricsRollup },
  { name: 'system-metrics', start: () => startSystemMetricsWriter(), stop: stopSystemMetricsWriter },
  { name: 'usage-guardrails', start: () => startUsageGuardrailsScheduler(), stop: stopUsageGuardrailsScheduler },
  {
    name: 'campaigns',
    start: (ctx) => {
      campaignScheduler = startCampaignScheduler({
        outboundCallbackBaseUrl: ctx.voiceGatewayBaseUrl,
        statusCallbackUrl: `${ctx.voiceGatewayBaseUrl}/twilio/status`,
        pollIntervalMs: 15_000,
      });
    },
    stop: stopCampaignScheduler,
    inFlight: campaignTickInFlight,
  },
  { name: 'insights', start: () => startInsightsScheduler(), stop: stopInsightsScheduler },
  { name: 'call-view-digest', start: () => startCallViewDigestScheduler(), stop: stopCallViewDigestScheduler },
  { name: 'csat-expiration', start: () => startCsatExpirationScheduler(), stop: stopCsatExpirationScheduler },
  { name: 'workforce', start: () => startWorkforceScheduler(), stop: stopWorkforceScheduler },
  { name: 'gin', start: () => startGinScheduler(), stop: stopGinScheduler },
  { name: 'milestones', start: () => startMilestoneScheduler(), stop: stopMilestoneScheduler },
  {
    name: 'docs-feedback-alert',
    start: () => startDocsFeedbackAlertScheduler(),
    stop: stopDocsFeedbackAlertScheduler,
    nightly: async () => {
      await runDocsFeedbackAlertCycle();
      await runDocsFeedbackPendingReplyAlertCycle();
    },
  },
  {
    name: 'docs-feedback-reply-digest',
    start: () => startDocsFeedbackReplyDigestScheduler(),
    stop: stopDocsFeedbackReplyDigestScheduler,
    nightly: () => runDocsFeedbackReplyDigestCycle(),
  },
  { name: 'docs-feedback-reply-retry', start: () => startDocsFeedbackReplyRetryScheduler(), stop: stopDocsFeedbackReplyRetryScheduler },
  { name: 'support-reply-retry', start: () => startSupportReplyRetryScheduler(), stop: stopSupportReplyRetryScheduler },
  { name: 'retry-attempts-cleanup', start: () => startRetryAttemptsCleanupScheduler(), stop: stopRetryAttemptsCleanupScheduler },
  { name: 'connector-auth-alert', start: () => startConnectorAuthAlertScheduler(), stop: stopConnectorAuthAlertScheduler },
  {
    name: 'connector-stale-alert',
    start: () => startConnectorStaleAlertScheduler(),
    stop: stopConnectorStaleAlertScheduler,
    nightly: () => runConnectorStaleAlertCycle(),
    nightlyFailed: (r) => ((r as StaleAlertCycleResult).snapshotLoadFailed ? 'connector snapshot load failed' : null),
  },
  { name: 'verified-caller-health', start: () => startVerifiedCallerHealthScheduler(), stop: stopVerifiedCallerHealthScheduler },
  { name: 'verified-caller-sync', start: () => startVerifiedCallerSyncScheduler(), stop: stopVerifiedCallerSyncScheduler },
  { name: 'trusthub-status', start: () => startTrustHubStatusScheduler(), stop: stopTrustHubStatusScheduler },
  { name: 'connector-outbox-drain', start: () => startConnectorOutboxDrainScheduler(), stop: stopConnectorOutboxDrainScheduler },
  {
    name: 'outbox-archive-sweep',
    start: () => startOutboxArchiveSweepScheduler(),
    stop: stopOutboxArchiveSweepScheduler,
    nightly: () => runOutboxArchiveSweepCycle(),
  },
  { name: 'scheduling-drift-alert', start: () => startSchedulingDriftAlertScheduler(), stop: stopSchedulingDriftAlertScheduler },
  { name: 'oauth-token-refresh', start: () => startOAuthTokenRefreshScheduler(), stop: stopOAuthTokenRefreshScheduler },
  { name: 'crm-caller-identity-revalidation', start: () => startCrmCallerIdentityRevalidationScheduler(), stop: stopCrmCallerIdentityRevalidationScheduler },
  {
    name: 'crm-stale-cache-retention',
    start: () => startCrmStaleCacheRetentionScheduler(),
    stop: stopCrmStaleCacheRetentionScheduler,
    nightly: () => runCrmStaleCacheRetentionCycle(),
  },
  {
    name: 'call-events-retention',
    start: () => startCallEventsRetentionScheduler(),
    stop: stopCallEventsRetentionScheduler,
    nightly: () => runCallEventsRetentionCycle(),
  },
  {
    name: 'tenant-isolation',
    start: () => startTenantIsolationScheduler(),
    stop: stopTenantIsolationScheduler,
    nightly: () => runTenantIsolationScheduledCycle(),
    nightlyFailed: (r) => ((r as IsolationSchedulerCycleResult).skippedReason ? 'isolation cycle threw' : null),
  },
  {
    name: 'encryption-reminder',
    start: () => startEncryptionReminderScheduler(),
    stop: stopEncryptionReminderScheduler,
    nightly: () => runEncryptionReminderCycle(),
    nightlyFailed: (r) => ((r as ReminderCycleResult).failed > 0 ? 'reminder emails failed' : null),
  },
  {
    name: 'route-export-archive-cleanup',
    start: () => startRouteExportArchiveCleanupScheduler(),
    stop: stopRouteExportArchiveCleanupScheduler,
    // Deletes archives through the Replit object-storage sidecar. Without
    // PRIVATE_OBJECT_DIR (Render until PR-00b) there is nothing to clean up
    // and every call would fail against 127.0.0.1:1106.
    skipReason: (env) => (env.PRIVATE_OBJECT_DIR?.trim() ? null : 'PRIVATE_OBJECT_DIR not set (object storage not configured)'),
  },
  {
    name: 'plan-recommendation-digest',
    start: () => startPlanRecommendationDigestScheduler(),
    stop: stopPlanRecommendationDigestScheduler,
    nightly: () => runPlanRecommendationDigestCycle(),
    nightlyFailed: (r) => ((r as RecommendationCycleResult).failed > 0 ? 'recommendation emails failed' : null),
  },
  {
    name: 'recommendation-direction-digest',
    start: () => startRecommendationDirectionDigestScheduler(),
    stop: stopRecommendationDirectionDigestScheduler,
    nightly: () => runRecommendationDirectionDigestCycle(),
    nightlyFailed: (r) => ((r as DirectionDigestCycleResult).failed ? 'direction digest failed' : null),
  },
  {
    name: 'stripe-price-verification',
    start: () => startStripePriceVerificationScheduler(),
    stop: stopStripePriceVerificationScheduler,
    nightly: () => runStripePriceVerificationCycle({ source: 'scheduled' }),
  },
  { name: 'marketplace-discount-backfill', start: () => startMarketplaceDiscountBackfillScheduler(), stop: stopMarketplaceDiscountBackfillScheduler },
  {
    name: 'portal-config-cleanup',
    start: () => startPortalConfigCleanupScheduler(),
    stop: stopPortalConfigCleanupScheduler,
    nightly: () => runPortalConfigCleanupCycle(),
    nightlyFailed: (r) => ((r as PortalConfigCleanupSnapshot).status === 'failure' ? 'portal config cleanup failed' : null),
  },
  {
    name: 'billing-reconciliation',
    start: () => startBillingReconciliationScheduler(),
    stop: stopBillingReconciliationScheduler,
    nightly: () => runReconciliationCycle('cron'),
    nightlyFailed: (r) => ((r as ReconciliationCycleSummary).errors > 0 ? 'reconciliation errors' : null),
  },
  { name: 'federal-dnc-sync', start: () => startFederalDncSyncScheduler(), stop: stopFederalDncSyncScheduler },
];

export const SCHEDULER_NAMES: readonly string[] = SCHEDULERS.map((s) => s.name);

export interface SchedulerSelection {
  /** Schedulers to start, in registry order. */
  enabled: SchedulerDefinition[];
  /** Registry entries not started, with a reason (for the boot log). */
  skipped: Array<{ name: string; reason: string }>;
  /** Names in SCHEDULERS_ENABLED that do not match any registry entry. */
  unknown: string[];
  /** The effective SCHEDULERS_ENABLED value after applying the role default. */
  setting: string;
}

/**
 * Decide which schedulers this process runs.
 *
 * SCHEDULERS_ENABLED = `all` | `none` | comma-separated names. When unset:
 *   - role `all` (Replit) → `all`, i.e. exactly today's behavior;
 *   - role `worker` (Render) → `none`, so a fresh Render deploy is safe in
 *     shadow mode until someone opts in;
 *   - other roles never run interval schedulers.
 *
 * Role `worker` additionally never starts a scheduler that has a `nightly`
 * run-once body: on Render those run from the `qvo-nightly` cron instead.
 */
export function selectSchedulers(
  role: ProcessRole,
  env: Record<string, string | undefined> = process.env,
  registry: readonly SchedulerDefinition[] = SCHEDULERS,
): SchedulerSelection {
  const skipped: SchedulerSelection['skipped'] = [];
  if (role !== 'all' && role !== 'worker') {
    return {
      enabled: [],
      skipped: registry.map((s) => ({ name: s.name, reason: `role ${role} does not run schedulers` })),
      unknown: [],
      setting: 'none',
    };
  }

  const raw = env.SCHEDULERS_ENABLED?.trim().toLowerCase();
  const setting = raw || (role === 'worker' ? 'none' : 'all');

  let wanted: Set<string> | 'all';
  const unknown: string[] = [];
  if (setting === 'all') {
    wanted = 'all';
  } else if (setting === 'none') {
    wanted = new Set();
  } else {
    const names = setting.split(',').map((n) => n.trim()).filter(Boolean);
    const known = new Set(registry.map((s) => s.name));
    for (const n of names) if (!known.has(n)) unknown.push(n);
    wanted = new Set(names);
  }

  const enabled: SchedulerDefinition[] = [];
  for (const s of registry) {
    if (wanted !== 'all' && !wanted.has(s.name)) {
      skipped.push({ name: s.name, reason: `not in SCHEDULERS_ENABLED=${setting}` });
      continue;
    }
    if (role === 'worker' && s.nightly) {
      skipped.push({ name: s.name, reason: 'runs from the nightly cron job' });
      continue;
    }
    const reason = s.skipReason?.(env) ?? null;
    if (reason) {
      skipped.push({ name: s.name, reason });
      continue;
    }
    enabled.push(s);
  }

  return { enabled, skipped, unknown, setting };
}

export function startSchedulers(list: readonly SchedulerDefinition[], ctx: SchedulerContext): void {
  for (const s of list) s.start(ctx);
}

/** Stop every scheduler in the list; one failing stop never blocks the rest. */
export function stopSchedulers(
  list: readonly SchedulerDefinition[],
  onError?: (name: string, err: unknown) => void,
): void {
  for (const s of list) {
    try {
      s.stop();
    } catch (err) {
      onError?.(s.name, err);
    }
  }
}

/** Registry entries that make up the `nightly` cron job, in registry order. */
export function nightlySchedulers(registry: readonly SchedulerDefinition[] = SCHEDULERS): SchedulerDefinition[] {
  return registry.filter((s) => typeof s.nightly === 'function');
}
