import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlanPriceId } from './plans';
import type { PlanTier } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('STRIPE_PLAN_CHANGE');

export interface ScheduledDowngrade {
  scheduleId: string;
  scheduledFor: string;
  targetPlan: PlanTier;
  targetInterval: 'monthly' | 'annual';
}

interface SubscriptionLookup {
  stripeSubscriptionId: string | null;
  currentPlan: PlanTier | null;
  currentInterval: 'monthly' | 'annual' | null;
}

/**
 * Loads the tenant's Stripe subscription id, current plan, and current
 * billing interval from the local `subscriptions` table.
 */
export async function loadTenantSubscription(tenantId: string): Promise<SubscriptionLookup> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT stripe_subscription_id, plan, billing_interval
         FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');
    if (rows.length === 0) {
      return { stripeSubscriptionId: null, currentPlan: null, currentInterval: null };
    }
    const rawInterval = (rows[0].billing_interval as string | null) ?? null;
    const currentInterval: 'monthly' | 'annual' | null =
      rawInterval === 'monthly' || rawInterval === 'annual' ? rawInterval : null;
    return {
      stripeSubscriptionId: (rows[0].stripe_subscription_id as string | null) ?? null,
      currentPlan: (rows[0].plan as PlanTier | null) ?? null,
      currentInterval,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Schedule a plan downgrade for the END of the tenant's current paid
 * billing period via a Stripe Subscription Schedule.
 *
 * Why a schedule (not `subscriptions.update`)?
 * - `subscriptions.update` with a new price changes the plan immediately,
 *   which contradicts the "takes effect at next renewal" promise we make
 *   in the Billing UI confirmation copy.
 * - `subscription_schedules` lets us pin the current paid phase through
 *   `current_period_end` and queue a follow-up phase that swaps in the
 *   lower-tier price afterwards. The change is invisible to the customer
 *   until the existing period actually ends — when Stripe transitions
 *   into phase 2, `customer.subscription.updated` fires and the existing
 *   webhook handler updates our local `subscriptions` row to the new
 *   plan and limits.
 *
 * If the subscription is already attached to a schedule (e.g. the tenant
 * scheduled and then re-scheduled a downgrade), we update the existing
 * schedule in-place rather than creating a parallel one.
 */
export async function scheduleDowngrade(params: {
  tenantId: string;
  targetPlan: PlanTier;
  targetInterval: 'monthly' | 'annual';
}): Promise<ScheduledDowngrade> {
  const { tenantId, targetPlan, targetInterval } = params;
  const stripe = getStripeClient();

  const { stripeSubscriptionId } = await loadTenantSubscription(tenantId);
  if (!stripeSubscriptionId) {
    throw new Error('Tenant has no Stripe subscription to schedule a downgrade from');
  }

  const newPriceId = getPlanPriceId(targetPlan, targetInterval);
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

  // Stripe types `subscription.schedule` as `string | Stripe.SubscriptionSchedule | null`
  // — normalize to the id (or null) so we can decide whether to retrieve
  // an existing schedule or materialize a new one from the subscription.
  const existingScheduleField = (stripeSub as unknown as { schedule?: string | Stripe.SubscriptionSchedule | null }).schedule;
  const existingScheduleId =
    typeof existingScheduleField === 'string'
      ? existingScheduleField
      : existingScheduleField && 'id' in existingScheduleField
        ? existingScheduleField.id
        : null;

  let schedule: Stripe.SubscriptionSchedule;
  if (existingScheduleId) {
    schedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
  } else {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: stripeSubscriptionId,
    });
  }

  // `from_subscription` always materializes a schedule with exactly one
  // phase representing the current paid period. Anchor a second phase
  // that begins when that one ends, swapping the price to the lower
  // tier with a single iteration so renewal cadence stays the same.
  const currentPhase = schedule.phases[0];
  if (!currentPhase) {
    throw new Error('Stripe subscription schedule is missing its current phase');
  }
  const phaseEndUnix = currentPhase.end_date as number;
  if (!phaseEndUnix) {
    throw new Error('Stripe subscription schedule has no end_date for the current phase');
  }

  const currentItems = currentPhase.items.map((item) => ({
    price: typeof item.price === 'string' ? item.price : (item.price as { id: string }).id,
    quantity: item.quantity ?? 1,
  }));

  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    phases: [
      {
        items: currentItems,
        start_date: currentPhase.start_date,
        end_date: phaseEndUnix,
        proration_behavior: 'none',
      },
      {
        items: [{ price: newPriceId, quantity: 1 }],
        // One billing cycle of the new price, then `end_behavior: 'release'`
        // detaches the schedule and the subscription continues renewing on
        // the lower-tier price normally.
        duration: { interval_count: 1, interval: targetInterval === 'annual' ? 'year' : 'month' },
        proration_behavior: 'none',
      },
    ],
  });

  logger.info('Scheduled downgrade', {
    tenantId,
    targetPlan,
    targetInterval,
    scheduleId: updated.id,
    effectiveAt: new Date(phaseEndUnix * 1000).toISOString(),
  });

  return {
    scheduleId: updated.id,
    scheduledFor: new Date(phaseEndUnix * 1000).toISOString(),
    targetPlan,
    targetInterval,
  };
}

const TIER_ORDER: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };

export function isStrictDowngrade(currentPlan: PlanTier, targetPlan: PlanTier): boolean {
  return TIER_ORDER[targetPlan] < TIER_ORDER[currentPlan];
}

/**
 * Direction of a plan-change request relative to the tenant's existing
 * paid subscription:
 *   - `upgrade`         → strictly higher tier than current
 *   - `downgrade`       → strictly lower tier than current
 *   - `interval_change` → same tier, different billing cadence
 *   - `same`            → same tier and same cadence (no-op)
 *   - `new`             → tenant has no paid subscription yet
 */
export type CheckoutDirection =
  | 'upgrade'
  | 'downgrade'
  | 'interval_change'
  | 'same'
  | 'new';

export function classifyCheckoutDirection(
  currentPlan: PlanTier | null,
  currentInterval: 'monthly' | 'annual' | null,
  targetPlan: PlanTier,
  targetInterval: 'monthly' | 'annual',
): CheckoutDirection {
  if (!currentPlan) return 'new';
  if (TIER_ORDER[targetPlan] > TIER_ORDER[currentPlan]) return 'upgrade';
  if (TIER_ORDER[targetPlan] < TIER_ORDER[currentPlan]) return 'downgrade';
  // Same tier — distinguish "swapping cadence" from a true no-op.
  if (currentInterval && currentInterval !== targetInterval) {
    return 'interval_change';
  }
  return 'same';
}
