import type Stripe from 'stripe';
import { TRIAL_LIMITS } from './plans';

/**
 * Trial params for a Checkout session's `subscription_data`. Every path
 * that creates a subscription checkout (POST /auth/signup and
 * `createCheckoutSession`) spreads this in, so the trial rule lives in
 * one place: a tenant's first subscription gets the `TRIAL_LIMITS`
 * trial; upgrades, interval switches and re-subscribes get none.
 */
export function buildTrialSubscriptionData(
  isFirstSubscription: boolean,
): Pick<Stripe.Checkout.SessionCreateParams.SubscriptionData, 'trial_period_days'> {
  return isFirstSubscription ? { trial_period_days: TRIAL_LIMITS.durationDays } : {};
}
