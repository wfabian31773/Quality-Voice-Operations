import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every scheduler module is replaced by spies that record call order, so the
// test proves the registry starts exactly what server/admin-api/start.ts
// started before PR-00, in the same order, with the same arguments.
const h = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const mod = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => { calls.push({ fn: n, args }); }]));
  // Stand-in for the CampaignScheduler instance (its private `running` flag).
  const campaign = { running: false };
  const holdSweep = { running: false };
  return { calls, mod, campaign, holdSweep };
});

vi.mock('../billing/stripe/usage', () => h.mod('startUsageMeteringWorker', 'stopUsageMeteringWorker'));
vi.mock('../campaigns', () => {
  const m = h.mod('startCampaignScheduler', 'stopCampaignScheduler', 'startFederalDncSyncScheduler', 'stopFederalDncSyncScheduler');
  const record = m.startCampaignScheduler;
  return { ...m, startCampaignScheduler: (...args: unknown[]) => (record(...args), h.campaign) };
});
vi.mock('../core/observability', () => h.mod('startMetricsRollup', 'stopMetricsRollup', 'startSystemMetricsWriter', 'stopSystemMetricsWriter'));
vi.mock('../billing/guardrails/UsageGuardrails', () => h.mod('startUsageGuardrailsScheduler', 'stopUsageGuardrailsScheduler'));
vi.mock('../analytics', () => h.mod('startInsightsScheduler', 'stopInsightsScheduler', 'startCallViewDigestScheduler', 'stopCallViewDigestScheduler', 'startCsatExpirationScheduler', 'stopCsatExpirationScheduler'));
vi.mock('../workforce/WorkforceScheduler', () => h.mod('startWorkforceScheduler', 'stopWorkforceScheduler'));
vi.mock('../gin', () => h.mod('startGinScheduler', 'stopGinScheduler'));
vi.mock('../analytics/MilestoneScheduler', () => h.mod('startMilestoneScheduler', 'stopMilestoneScheduler'));
vi.mock('../help/DocsFeedbackAlertScheduler', () => h.mod('startDocsFeedbackAlertScheduler', 'stopDocsFeedbackAlertScheduler', 'runDocsFeedbackAlertCycle', 'runDocsFeedbackPendingReplyAlertCycle'));
vi.mock('../help/DocsFeedbackReplyDigestScheduler', () => h.mod('startDocsFeedbackReplyDigestScheduler', 'stopDocsFeedbackReplyDigestScheduler', 'runDocsFeedbackReplyDigestCycle'));
vi.mock('../help/DocsFeedbackReplyRetryScheduler', () => h.mod('startDocsFeedbackReplyRetryScheduler', 'stopDocsFeedbackReplyRetryScheduler'));
vi.mock('../help/SupportReplyRetryScheduler', () => h.mod('startSupportReplyRetryScheduler', 'stopSupportReplyRetryScheduler'));
vi.mock('../help/RetryAttemptsCleanupScheduler', () => h.mod('startRetryAttemptsCleanupScheduler', 'stopRetryAttemptsCleanupScheduler'));
vi.mock('../integrations/connectors/ConnectorAuthAlertScheduler', () => h.mod('startConnectorAuthAlertScheduler', 'stopConnectorAuthAlertScheduler'));
vi.mock('../integrations/connectors/ConnectorStaleAlertScheduler', () => h.mod('startConnectorStaleAlertScheduler', 'stopConnectorStaleAlertScheduler', 'runConnectorStaleAlertCycle'));
vi.mock('../telephony/VerifiedCallerHealthScheduler', () => h.mod('startVerifiedCallerHealthScheduler', 'stopVerifiedCallerHealthScheduler', 'startTrustHubStatusScheduler', 'stopTrustHubStatusScheduler'));
vi.mock('../telephony/VerifiedCallerSyncScheduler', () => h.mod('startVerifiedCallerSyncScheduler', 'stopVerifiedCallerSyncScheduler'));
vi.mock('../integrations/connectors/ConnectorOutboxDrainScheduler', () => h.mod('startConnectorOutboxDrainScheduler', 'stopConnectorOutboxDrainScheduler', 'startOutboxArchiveSweepScheduler', 'stopOutboxArchiveSweepScheduler', 'runOutboxArchiveSweepCycle'));
vi.mock('../integrations/connectors/SchedulingDriftAlertScheduler', () => h.mod('startSchedulingDriftAlertScheduler', 'stopSchedulingDriftAlertScheduler'));
vi.mock('../integrations/connectors', () => h.mod('startOAuthTokenRefreshScheduler', 'stopOAuthTokenRefreshScheduler', 'startCrmCallerIdentityRevalidationScheduler', 'stopCrmCallerIdentityRevalidationScheduler', 'startCrmStaleCacheRetentionScheduler', 'stopCrmStaleCacheRetentionScheduler'));
vi.mock('../integrations/connectors/CrmStaleCacheRetentionScheduler', () => h.mod('runCrmStaleCacheRetentionCycle'));
vi.mock('../billing/CallEventsRetentionScheduler', () => h.mod('startCallEventsRetentionScheduler', 'stopCallEventsRetentionScheduler', 'runCallEventsRetentionCycle'));
vi.mock('../security/TenantIsolationScheduler', () => h.mod('startTenantIsolationScheduler', 'stopTenantIsolationScheduler', 'runTenantIsolationScheduledCycle'));
vi.mock('../security/EncryptionReminderScheduler', () => h.mod('startEncryptionReminderScheduler', 'stopEncryptionReminderScheduler', 'runEncryptionReminderCycle'));
vi.mock('../dispatch/RouteExportArchiveCleanupScheduler', () => h.mod('startRouteExportArchiveCleanupScheduler', 'stopRouteExportArchiveCleanupScheduler'));
vi.mock('../billing/PlanRecommendationDigestScheduler', () => h.mod('startPlanRecommendationDigestScheduler', 'stopPlanRecommendationDigestScheduler', 'runPlanRecommendationDigestCycle'));
vi.mock('../billing/RecommendationDirectionDigestScheduler', () => h.mod('startRecommendationDirectionDigestScheduler', 'stopRecommendationDirectionDigestScheduler', 'runRecommendationDirectionDigestCycle'));
vi.mock('../billing/StripePriceVerificationScheduler', () => h.mod('startStripePriceVerificationScheduler', 'stopStripePriceVerificationScheduler', 'runStripePriceVerificationCycle'));
vi.mock('../billing/MarketplaceDiscountBackfillScheduler', () => h.mod('startMarketplaceDiscountBackfillScheduler', 'stopMarketplaceDiscountBackfillScheduler'));
vi.mock('../billing/PortalConfigCleanupScheduler', () => h.mod('startPortalConfigCleanupScheduler', 'stopPortalConfigCleanupScheduler', 'runPortalConfigCleanupCycle'));
vi.mock('../billing/BillingReconciliationScheduler', () => h.mod('startBillingReconciliationScheduler', 'stopBillingReconciliationScheduler', 'runReconciliationCycle'));
vi.mock('../actions/sms/deferredReleaseScheduler', () => ({
  ...h.mod('startSmsDeferredReleaseScheduler', 'stopSmsDeferredReleaseScheduler'),
  smsDeferredReleaseInFlight: () => false,
}));
vi.mock('../actions/scheduling/holdSweeper', () => ({
  ...h.mod('startHoldSweeper', 'stopHoldSweeper'),
  holdSweepInFlight: () => h.holdSweep.running,
}));

import {
  SCHEDULERS,
  SCHEDULER_NAMES,
  selectSchedulers,
  startSchedulers,
  stopSchedulers,
  nightlySchedulers,
  type SchedulerDefinition,
} from './schedulers';

/** The start sequence of server/admin-api/start.ts at main@6a98241 (pre-PR-00). */
const PRE_PR00_START_ORDER = [
  'startUsageMeteringWorker', 'startMetricsRollup', 'startSystemMetricsWriter', 'startUsageGuardrailsScheduler',
  'startCampaignScheduler', 'startInsightsScheduler', 'startCallViewDigestScheduler', 'startCsatExpirationScheduler',
  'startWorkforceScheduler', 'startGinScheduler', 'startMilestoneScheduler', 'startDocsFeedbackAlertScheduler',
  'startDocsFeedbackReplyDigestScheduler', 'startDocsFeedbackReplyRetryScheduler', 'startSupportReplyRetryScheduler',
  'startRetryAttemptsCleanupScheduler', 'startConnectorAuthAlertScheduler', 'startConnectorStaleAlertScheduler',
  'startVerifiedCallerHealthScheduler', 'startVerifiedCallerSyncScheduler', 'startTrustHubStatusScheduler',
  'startConnectorOutboxDrainScheduler', 'startOutboxArchiveSweepScheduler', 'startSchedulingDriftAlertScheduler',
  'startOAuthTokenRefreshScheduler', 'startCrmCallerIdentityRevalidationScheduler', 'startCrmStaleCacheRetentionScheduler',
  'startCallEventsRetentionScheduler', 'startTenantIsolationScheduler', 'startEncryptionReminderScheduler',
  'startRouteExportArchiveCleanupScheduler', 'startPlanRecommendationDigestScheduler',
  'startRecommendationDirectionDigestScheduler', 'startStripePriceVerificationScheduler',
  'startMarketplaceDiscountBackfillScheduler', 'startPortalConfigCleanupScheduler',
  'startBillingReconciliationScheduler', 'startFederalDncSyncScheduler',
];

/** Schedulers registered after PR-00, appended in this order. */
const POST_PR00_START_ORDER = ['startSmsDeferredReleaseScheduler', 'startHoldSweeper'];

const START_ORDER = [...PRE_PR00_START_ORDER, ...POST_PR00_START_ORDER];

const NIGHTLY = [
  'docs-feedback-alert', 'docs-feedback-reply-digest', 'connector-stale-alert', 'outbox-archive-sweep',
  'crm-stale-cache-retention', 'call-events-retention', 'tenant-isolation', 'encryption-reminder',
  'plan-recommendation-digest', 'recommendation-direction-digest', 'stripe-price-verification',
  'portal-config-cleanup', 'billing-reconciliation',
];

const REPLIT_ENV = { PRIVATE_OBJECT_DIR: '/bucket/private' };

beforeEach(() => {
  h.calls.length = 0;
});

describe('scheduler registry', () => {
  it('has unique, stable kebab-case names', () => {
    expect(new Set(SCHEDULER_NAMES).size).toBe(SCHEDULER_NAMES.length);
    for (const n of SCHEDULER_NAMES) expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(SCHEDULERS).toHaveLength(START_ORDER.length);
  });

  it('role all (Replit, no new env) starts the pre-PR-00 list in the same order, then later additions', () => {
    const sel = selectSchedulers('all', REPLIT_ENV);
    expect(sel.setting).toBe('all');
    expect(sel.skipped).toEqual([]);
    startSchedulers(sel.enabled, { voiceGatewayBaseUrl: 'https://qvo.replit.app/vg' });
    expect(h.calls.map((c) => c.fn)).toEqual(START_ORDER);
    const campaign = h.calls.find((c) => c.fn === 'startCampaignScheduler');
    expect(campaign?.args).toEqual([
      {
        outboundCallbackBaseUrl: 'https://qvo.replit.app/vg',
        statusCallbackUrl: 'https://qvo.replit.app/vg/twilio/status',
        pollIntervalMs: 15_000,
      },
    ]);
    // Same default arguments as before: none of the other starts get args.
    for (const c of h.calls.filter((x) => x.fn !== 'startCampaignScheduler')) expect(c.args).toEqual([]);
  });

  it('startSchedulers starts schedulers (and their timers) in the privileged DB scope', async () => {
    const { isPrivilegedScope, runWithTenantScope } = await import('../db/tenantScope');
    const seen: boolean[] = [];
    const probe: SchedulerDefinition = {
      name: 'probe',
      start: () => {
        seen.push(isPrivilegedScope());
        setTimeout(() => seen.push(isPrivilegedScope()), 0);
      },
      stop: () => {},
    };
    // Even when started from inside a tenant request scope.
    runWithTenantScope('t1', () => startSchedulers([probe], { voiceGatewayBaseUrl: 'https://voice.example' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([true, true]);
  });

  it('stopSchedulers stops every started scheduler and survives a throwing stop', () => {
    const boom: SchedulerDefinition = { name: 'boom', start: () => {}, stop: () => { throw new Error('x'); } };
    const errors: string[] = [];
    stopSchedulers([boom, ...SCHEDULERS], (name) => errors.push(name));
    expect(errors).toEqual(['boom']);
    expect(h.calls.filter((c) => c.fn.startsWith('stop'))).toHaveLength(SCHEDULERS.length);
  });

  it('role all honors SCHEDULERS_ENABLED=none (cutover switch on Replit)', () => {
    const sel = selectSchedulers('all', { ...REPLIT_ENV, SCHEDULERS_ENABLED: 'none' });
    expect(sel.enabled).toEqual([]);
  });

  it('role all skips route-export cleanup without PRIVATE_OBJECT_DIR', () => {
    const sel = selectSchedulers('all', {});
    expect(sel.enabled.map((s) => s.name)).not.toContain('route-export-archive-cleanup');
    expect(sel.skipped).toEqual([
      { name: 'route-export-archive-cleanup', reason: 'PRIVATE_OBJECT_DIR not set (object storage not configured)' },
    ]);
  });

  it('role worker defaults to none (shadow-safe)', () => {
    const sel = selectSchedulers('worker', REPLIT_ENV);
    expect(sel.setting).toBe('none');
    expect(sel.enabled).toEqual([]);
  });

  it('role worker with all excludes every nightly scheduler so nothing runs twice', () => {
    const sel = selectSchedulers('worker', { ...REPLIT_ENV, SCHEDULERS_ENABLED: 'all' });
    const names = sel.enabled.map((s) => s.name);
    for (const n of NIGHTLY) expect(names).not.toContain(n);
    expect(names).toContain('campaigns');
    expect(names).toContain('gin');
    expect(names).toContain('marketplace-discount-backfill');
    expect(names.length + NIGHTLY.length).toBe(SCHEDULERS.length);
  });

  it('role worker with a list starts only those (minus nightly), reports unknown names', () => {
    const sel = selectSchedulers('worker', { SCHEDULERS_ENABLED: ' Campaigns, tenant-isolation,nope ' });
    expect(sel.enabled.map((s) => s.name)).toEqual(['campaigns']);
    expect(sel.unknown).toEqual(['nope']);
    expect(sel.skipped.find((s) => s.name === 'tenant-isolation')?.reason).toBe('runs from the nightly cron job');
  });

  it.each(['api', 'voice', 'cron'] as const)('role %s never runs interval schedulers', (role) => {
    const sel = selectSchedulers(role, { SCHEDULERS_ENABLED: 'all' });
    expect(sel.enabled).toEqual([]);
    expect(sel.setting).toBe('none');
  });

  it('nightly = every daily scheduler with an existing run-once function', async () => {
    const nightly = nightlySchedulers();
    expect(nightly.map((s) => s.name)).toEqual(NIGHTLY);
    for (const s of nightly) await s.nightly!();
    expect(h.calls.map((c) => c.fn)).toEqual([
      'runDocsFeedbackAlertCycle', 'runDocsFeedbackPendingReplyAlertCycle', 'runDocsFeedbackReplyDigestCycle',
      'runConnectorStaleAlertCycle', 'runOutboxArchiveSweepCycle', 'runCrmStaleCacheRetentionCycle',
      'runCallEventsRetentionCycle', 'runTenantIsolationScheduledCycle', 'runEncryptionReminderCycle',
      'runPlanRecommendationDigestCycle', 'runRecommendationDirectionDigestCycle', 'runStripePriceVerificationCycle',
      'runPortalConfigCleanupCycle', 'runReconciliationCycle',
    ]);
    expect(h.calls.find((c) => c.fn === 'runReconciliationCycle')?.args).toEqual(['cron']);
  });

  describe('sms-deferred-release (PR-09)', () => {
    const NAME = 'sms-deferred-release';
    const enabledNames = (role: Parameters<typeof selectSchedulers>[0], env: Record<string, string | undefined>) =>
      selectSchedulers(role, env).enabled.map((s) => s.name);

    it('is registered as an interval scheduler with an inFlight probe', () => {
      const entry = SCHEDULERS.find((s) => s.name === NAME)!;
      expect(entry).toBeDefined();
      expect(entry.nightly).toBeUndefined();
      expect(entry.inFlight!()).toBe(false);
      entry.start({ voiceGatewayBaseUrl: 'https://voice.example.com' });
      entry.stop();
      expect(h.calls.map((c) => c.fn)).toEqual(['startSmsDeferredReleaseScheduler', 'stopSmsDeferredReleaseScheduler']);
    });

    it('is gated by SCHEDULERS_ENABLED and the role, like its neighbors', () => {
      // Render worker default (schedulers off) and explicit none: not started.
      expect(enabledNames('worker', {})).not.toContain(NAME);
      expect(enabledNames('worker', { SCHEDULERS_ENABLED: 'none' })).not.toContain(NAME);
      expect(enabledNames('all', { SCHEDULERS_ENABLED: 'none' })).not.toContain(NAME);
      expect(enabledNames('worker', { SCHEDULERS_ENABLED: 'campaigns' })).not.toContain(NAME);
      // Opted in: by name or via all.
      expect(enabledNames('worker', { SCHEDULERS_ENABLED: `campaigns,${NAME}` })).toEqual(['campaigns', NAME]);
      expect(enabledNames('worker', { SCHEDULERS_ENABLED: 'all' })).toContain(NAME);
      expect(enabledNames('all', REPLIT_ENV)).toContain(NAME);
      // Non-scheduler roles never run it.
      for (const role of ['api', 'voice', 'cron'] as const) {
        expect(enabledNames(role, { SCHEDULERS_ENABLED: 'all' })).not.toContain(NAME);
      }
    });
  });

  it('campaigns reports inFlight while its tick is running, also after stop()', () => {
    const campaigns = SCHEDULERS.find((s) => s.name === 'campaigns')!;
    campaigns.start({ voiceGatewayBaseUrl: 'https://voice.example.com' });
    expect(campaigns.inFlight!()).toBe(false);
    h.campaign.running = true;
    campaigns.stop();
    expect(campaigns.inFlight!()).toBe(true);
    h.campaign.running = false;
    expect(campaigns.inFlight!()).toBe(false);
  });

  describe('scheduling-hold-sweeper', () => {
    const sweeper = () => SCHEDULERS.find((s) => s.name === 'scheduling-hold-sweeper')!;

    it('is registered as an interval scheduler (not nightly) wired to the hold sweeper', () => {
      expect(sweeper()).toBeDefined();
      expect(sweeper().nightly).toBeUndefined();
      sweeper().start({ voiceGatewayBaseUrl: 'https://voice.example.com' });
      sweeper().stop();
      expect(h.calls.map((c) => c.fn)).toEqual(['startHoldSweeper', 'stopHoldSweeper']);
      expect(h.calls[0].args).toEqual([]);
    });

    it('is off on the Render worker until named in SCHEDULERS_ENABLED', () => {
      expect(selectSchedulers('worker', {}).enabled.map((s) => s.name)).not.toContain('scheduling-hold-sweeper');
      const named = selectSchedulers('worker', { SCHEDULERS_ENABLED: 'scheduling-hold-sweeper' });
      expect(named.enabled.map((s) => s.name)).toEqual(['scheduling-hold-sweeper']);
      expect(named.unknown).toEqual([]);
      expect(selectSchedulers('all', { SCHEDULERS_ENABLED: 'none' }).enabled).toEqual([]);
      expect(selectSchedulers('api', { SCHEDULERS_ENABLED: 'scheduling-hold-sweeper' }).enabled).toEqual([]);
    });

    it('reports inFlight while a sweep is running', () => {
      expect(sweeper().inFlight!()).toBe(false);
      h.holdSweep.running = true;
      expect(sweeper().inFlight!()).toBe(true);
      h.holdSweep.running = false;
    });
  });
});
