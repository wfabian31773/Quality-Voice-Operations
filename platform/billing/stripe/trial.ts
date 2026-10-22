import type Stripe from 'stripe';
import { TRIAL_LIMITS } from './plans';

/**
 * Trial params for a Checkout session's `subscription_data`. Every path
 * that creates a subscription checkout (POST /auth/signup and
 * `createCheckoutSession`) spreads this in, so the trial rule lives in
 * one place: a tenant's first subscription gets the `TRIAL_LIMITS`
 * trial; upgrades, interval switches and re-subscribes get none.
 *
 * A tenant whose signup-time free trial (`tenants.trial_expires_at`) has
 * already run out has used its trial, so it gets none either, even on a
 * first subscription.
 */
export function buildTrialSubscriptionData(input: {
  isFirstSubscription: boolean;
  freeTrialExpiresAt?: Date | string | null;
  now?: number;
}): Pick<Stripe.Checkout.SessionCreateParams.SubscriptionData, 'trial_period_days'> {
  const { isFirstSubscription, freeTrialExpiresAt, now = Date.now() } = input;
  if (!isFirstSubscription) return {};
  if (freeTrialExpiresAt && new Date(freeTrialExpiresAt).getTime() <= now) return {};
  return { trial_period_days: TRIAL_LIMITS.durationDays };
}
