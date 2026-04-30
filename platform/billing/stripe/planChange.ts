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

/**
 * Banner-attributed recommendation snapshot forwarded from
 * `/billing/schedule-downgrade` when the downgrade originates from the
 * BillingEstimator's "Switch to <Plan>" CTA. Mirrors
 * `CheckoutRecommendationAttribution` so the upgrade and downgrade
 * surfaces stamp the same shape into Stripe metadata and the
 * `billing_recommendation_events` table.
 */
export interface ScheduleDowngradeRecommendation {
  currentTier: PlanTier;
  recommendedTier: PlanTier;
  monthlySavingsCents: number;
  trailingWindowMonths?: number;
  pitch: 'tier-switch' | 'annual-only';
}

/**
 * `proration_behavior` used on both the downgrade preview
 * (`getTenantDowngradePreview`) and the schedule's lower-tier phase
 * (`scheduleDowngrade`). Importing the same constant in both call
 * sites guarantees the preview quotes the same next-invoice total
 * Stripe will actually generate when the schedule transitions.
 *
 * Why `'none'`: scheduleDowngrade defers the price swap to
 * `current_period_end`, so the new phase starts with no time-overlap
 * against the higher tier — there is no unused time to prorate.
 * `'create_prorations'` would not change that (Stripe would still
 * compute zero unused time at the phase boundary). The downgrade UX
 * promises "Takes effect at next renewal", which means the tenant
 * gets the full value of what they already paid — there is, by
 * design, no credit to issue here.
 */
export const DOWNGRADE_PRORATION_BEHAVIOR: 'create_prorations' | 'none' = 'none';

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
  /**
   * Optional banner-attributed recommendation snapshot forwarded from
   * the BillingEstimator's "Switch to <Plan>" CTA. When present:
   *   - It is stamped onto the Stripe Subscription Schedule's metadata
   *     so a downstream operator inspecting the schedule can trace the
   *     downgrade back to the recommendation banner the same way the
   *     upgrade arm's checkout session metadata does.
   *   - A `switch_completed` row is written to
   *     `billing_recommendation_events` so the conversion funnel
   *     captures downgrades. (For upgrades the equivalent row is
   *     written when `checkout.session.completed` fires; downgrades
   *     have no checkout step, so the row is written here at schedule
   *     creation time — the user has taken the explicit "switch" action
   *     and Stripe has accepted the schedule.)
   */
  recommendation?: ScheduleDowngradeRecommendation;
}): Promise<ScheduledDowngrade> {
  const { tenantId, targetPlan, targetInterval, recommendation } = params;
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

  // Banner-attributed recommendation snapshot, stamped onto the
  // schedule's metadata so an operator inspecting the schedule in
  // Stripe can trace it back to the recommendation banner the same
  // way the upgrade arm's checkout session metadata does. Stripe
  // metadata values must be strings.
  const recommendationMetadata: Record<string, string> = recommendation
    ? {
        recommendationSource: 'billing_estimator_recommendation',
        recommendationCurrentTier: recommendation.currentTier,
        recommendationRecommendedTier: recommendation.recommendedTier,
        recommendationMonthlySavingsCents: String(recommendation.monthlySavingsCents),
        recommendationPitch: recommendation.pitch,
        ...(recommendation.trailingWindowMonths !== undefined
          ? { recommendationTrailingWindowMonths: String(recommendation.trailingWindowMonths) }
          : {}),
      }
    : {};

  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    phases: [
      {
        items: currentItems,
        start_date: currentPhase.start_date,
        end_date: phaseEndUnix,
        // Phase 0 = current paid period; no re-crediting time already
        // consumed on the higher tier.
        proration_behavior: 'none',
      },
      {
        items: [{ price: newPriceId, quantity: 1 }],
        // One billing cycle of the new price, then `end_behavior: 'release'`
        // detaches the schedule and the subscription continues renewing on
        // the lower-tier price normally.
        duration: { interval_count: 1, interval: targetInterval === 'annual' ? 'year' : 'month' },
        proration_behavior: DOWNGRADE_PRORATION_BEHAVIOR,
      },
    ],
    ...(recommendation ? { metadata: recommendationMetadata } : {}),
  });

  logger.info('Scheduled downgrade', {
    tenantId,
    targetPlan,
    targetInterval,
    scheduleId: updated.id,
    effectiveAt: new Date(phaseEndUnix * 1000).toISOString(),
    recommended: recommendation ? true : false,
  });

  // Server-authoritative attribution for the BillingEstimator's
  // "Switch to <Plan>" recommendation banner — downgrade arm. The
  // upgrade arm writes this row from the Stripe webhook on
  // `checkout.session.completed`, but downgrades have no checkout
  // step (the change is queued through a Subscription Schedule and
  // doesn't fire `checkout.session.completed`). The user clicked the
  // banner CTA and Stripe accepted the schedule update, so the
  // "switch" is effectively complete from the funnel's point of view.
  // Failures here are logged but do not roll back the schedule —
  // attribution is best-effort once the billing change is locked in.
  if (recommendation) {
    try {
      const pool = getPlatformPool();
      const writeClient = await pool.connect();
      try {
        await writeClient.query('BEGIN');
        await withTenantContext(writeClient, tenantId, async () => {});
        await writeClient.query(
          `INSERT INTO billing_recommendation_events
             (tenant_id, event_type, current_tier, recommended_tier,
              monthly_savings_cents, trailing_window_months, metadata,
              pitch)
           VALUES ($1, 'switch_completed', $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            tenantId,
            recommendation.currentTier,
            recommendation.recommendedTier,
            Number.isFinite(recommendation.monthlySavingsCents) && recommendation.monthlySavingsCents >= 0
              ? Math.round(recommendation.monthlySavingsCents)
              : null,
            recommendation.trailingWindowMonths === 3
              || recommendation.trailingWindowMonths === 6
              || recommendation.trailingWindowMonths === 12
              ? recommendation.trailingWindowMonths
              : null,
            JSON.stringify({
              source: 'schedule_downgrade',
              stripeScheduleId: updated.id,
              stripeSubscriptionId,
              scheduledFor: new Date(phaseEndUnix * 1000).toISOString(),
              targetInterval,
            }),
            recommendation.pitch,
          ],
        );
        await writeClient.query('COMMIT');
      } catch (err) {
        await writeClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        writeClient.release();
      }
    } catch (err) {
      logger.warn('Failed to record recommendation switch_completed event for downgrade', {
        tenantId,
        scheduleId: updated.id,
        error: String(err),
      });
    }
  }

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
