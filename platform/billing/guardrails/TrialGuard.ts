import { getPlatformPool, withTenantContext } from '../../db';
import { TRIAL_LIMITS } from '../stripe/plans';
import type { TenantId } from '../../core/types';
import { createLogger } from '../../core/logger';

const logger = createLogger('TRIAL_GUARD');

export interface TrialCheckResult {
  isTrial: boolean;
  allowed: boolean;
  reason?: string;
  usage: {
    totalCalls: number;
    maxCalls: number;
    toolExecutions: number;
    maxToolExecutions: number;
    agentCount: number;
    maxAgents: number;
  };
  trialExpiresAt?: string;
}

type TrialSubscriptionRow = { status?: unknown; stripe_subscription_id?: unknown; trial_end?: unknown };

/**
 * How long past `trial_end` a Stripe-backed trial keeps working while we
 * wait for the trialing → active (or past_due) webhook.
 */
export const STRIPE_TRIAL_GRACE_MS = 24 * 60 * 60 * 1000;

export const STRIPE_TRIAL_LAPSED_REASON =
  'Your trial has ended and your first payment has not been confirmed yet. Please check your billing details to continue.';

/**
 * Plan-row statuses that block usage until billing is fixed. 'paused' is
 * what Stripe sets when a trial ends with no payment method under
 * end_behavior=pause; it's unpaid, same as past_due. Shared by
 * `checkBudget` and `checkTrialLimits` so both guards agree.
 */
const UNPAID_SUBSCRIPTION_STATUSES: ReadonlySet<unknown> = new Set(['past_due', 'paused', 'cancelled']);

export function isUnpaidSubscriptionStatus(status: unknown): boolean {
  return UNPAID_SUBSCRIPTION_STATUSES.has(status);
}

export function unpaidSubscriptionReason(status: string): string {
  return `Subscription is ${status}. Please update your billing to continue.`;
}

/**
 * Stripe trial: a paid plan inside Stripe's trial period (checkout done,
 * `stripe_subscription_id` set). Gets the plan's own limits, not TRIAL_LIMITS.
 */
export function isStripeTrial(sub: TrialSubscriptionRow | undefined): boolean {
  return !!sub && sub.status === 'trialing' && !!sub.stripe_subscription_id;
}

/**
 * Free trial (TRIAL_LIMITS): no subscription row yet, or a `trialing` row
 * with no Stripe subscription behind it.
 */
export function isTrialSubscription(sub: TrialSubscriptionRow | undefined): boolean {
  return !sub || (sub.status === 'trialing' && !sub.stripe_subscription_id);
}

/** True once a Stripe trial is past `trial_end` plus the grace window. */
export function stripeTrialLapsed(sub: TrialSubscriptionRow | undefined, now: number = Date.now()): boolean {
  if (!isStripeTrial(sub)) return false;
  const end = trialEndFor(sub, null);
  return end !== null && new Date(end).getTime() + STRIPE_TRIAL_GRACE_MS < now;
}

/** Trial end: the subscription's Stripe `trial_end` if set, else the tenant's signup-time `trial_expires_at`. */
export function trialEndFor(
  sub: { trial_end?: unknown } | undefined,
  tenantTrialExpiresAt: unknown,
): string | null {
  const raw = sub?.trial_end ?? tenantTrialExpiresAt;
  if (raw === null || raw === undefined) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

export async function checkTrialLimits(tenantId: TenantId): Promise<TrialCheckResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: subRows } = await client.query(
      `SELECT status, trial_end, stripe_subscription_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const isTrial = isTrialSubscription(subRows[0]);

    if (!isTrial) {
      await client.query('COMMIT');
      // An unpaid plan row is blocked, same as in checkBudget. A Stripe
      // trial runs on its paid plan's limits; it is only blocked if the
      // conversion webhook still hasn't landed after the grace window.
      const status = subRows[0]?.status;
      const unpaid = isUnpaidSubscriptionStatus(status);
      const lapsed = stripeTrialLapsed(subRows[0]);
      const stripeTrialEnd = isStripeTrial(subRows[0]) ? trialEndFor(subRows[0], null) : null;
      return {
        isTrial: false,
        allowed: !unpaid && !lapsed,
        reason: unpaid
          ? unpaidSubscriptionReason(String(status))
          : lapsed ? STRIPE_TRIAL_LAPSED_REASON : undefined,
        trialExpiresAt: stripeTrialEnd ?? undefined,
        usage: {
          totalCalls: 0,
          maxCalls: TRIAL_LIMITS.maxTotalCalls,
          toolExecutions: 0,
          maxToolExecutions: TRIAL_LIMITS.maxToolExecutions,
          agentCount: 0,
          maxAgents: TRIAL_LIMITS.maxAgents,
        },
      };
    }

    const { rows: tenantRows } = await client.query(
      `SELECT trial_expires_at FROM tenants WHERE id = $1`,
      [tenantId],
    );

    // A Stripe trial's own end date wins: the Stripe trial starts at
    // checkout, which can be later than the signup-time estimate on
    // tenants.trial_expires_at.
    const trialExpiresAt = trialEndFor(subRows[0], tenantRows[0]?.trial_expires_at);
    if (trialExpiresAt && new Date(trialExpiresAt) < new Date()) {
      await client.query('COMMIT');
      return {
        isTrial: true,
        allowed: false,
        reason: 'Your 7-day trial has expired. Please upgrade to a paid plan to continue using the platform.',
        usage: { totalCalls: 0, maxCalls: TRIAL_LIMITS.maxTotalCalls, toolExecutions: 0, maxToolExecutions: TRIAL_LIMITS.maxToolExecutions, agentCount: 0, maxAgents: TRIAL_LIMITS.maxAgents },
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    const { rows: usageRows } = await client.query(
      `SELECT metric_type, SUM(quantity) AS total
       FROM usage_metrics
       WHERE tenant_id = $1
       GROUP BY metric_type`,
      [tenantId],
    );

    let totalCalls = 0;
    let toolExecutions = 0;
    for (const row of usageRows) {
      const metricType = row.metric_type as string;
      const total = parseInt(row.total as string, 10);
      if (metricType === 'calls_inbound' || metricType === 'calls_outbound') totalCalls += total;
      if (metricType === 'tool_executions') toolExecutions += total;
    }

    const { rows: agentRows } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const agentCount = parseInt(agentRows[0]?.count as string, 10) || 0;

    await client.query('COMMIT');

    const usage = {
      totalCalls,
      maxCalls: TRIAL_LIMITS.maxTotalCalls,
      toolExecutions,
      maxToolExecutions: TRIAL_LIMITS.maxToolExecutions,
      agentCount,
      maxAgents: TRIAL_LIMITS.maxAgents,
    };

    if (totalCalls >= TRIAL_LIMITS.maxTotalCalls) {
      logger.warn('Trial call limit reached', { tenantId, totalCalls });
      return {
        isTrial: true,
        allowed: false,
        reason: `Trial call limit reached (${totalCalls}/${TRIAL_LIMITS.maxTotalCalls}). Upgrade your plan to make more calls.`,
        usage,
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    if (toolExecutions >= TRIAL_LIMITS.maxToolExecutions) {
      logger.warn('Trial tool execution limit reached', { tenantId, toolExecutions });
      return {
        isTrial: true,
        allowed: false,
        reason: `Trial tool execution limit reached (${toolExecutions}/${TRIAL_LIMITS.maxToolExecutions}). Upgrade your plan to continue using tools.`,
        usage,
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    return {
      isTrial: true,
      allowed: true,
      usage,
      trialExpiresAt: trialExpiresAt ?? undefined,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Trial check failed', { tenantId, error: String(err) });
    return {
      isTrial: false,
      allowed: true,
      usage: { totalCalls: 0, maxCalls: TRIAL_LIMITS.maxTotalCalls, toolExecutions: 0, maxToolExecutions: TRIAL_LIMITS.maxToolExecutions, agentCount: 0, maxAgents: TRIAL_LIMITS.maxAgents },
    };
  } finally {
    client.release();
  }
}

export async function checkTrialAgentLimit(tenantId: TenantId): Promise<{ allowed: boolean; reason?: string }> {
  const result = await checkTrialLimits(tenantId);
  // Paid plans have no agent cap, but an unpaid or lapsed row is still blocked.
  if (!result.isTrial) return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason };

  if (result.usage.agentCount >= TRIAL_LIMITS.maxAgents) {
    return {
      allowed: false,
      reason: `Trial agent limit reached (${result.usage.agentCount}/${TRIAL_LIMITS.maxAgents}). Upgrade your plan to create more agents.`,
    };
  }

  return { allowed: true };
}
