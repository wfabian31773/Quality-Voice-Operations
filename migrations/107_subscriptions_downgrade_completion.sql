-- Task #1366 — Surface scheduled-downgrade completion to the Billing UI.
--
-- The Billing page already shows a "Downgrade to <Plan> scheduled for
-- <date>" notice when a tenant clicks the in-card downgrade button
-- (set client-side from the /billing/schedule-downgrade response). That
-- notice only confirms the *scheduling* — when Stripe transitions the
-- Subscription Schedule's second phase at current_period_end and the
-- new lower-tier price actually takes effect, the tenant gets no
-- tailored confirmation that the swap landed.
--
-- These two columns let `handleSubscriptionUpdated` stamp the tenant's
-- subscription row when it detects a strict tier downgrade applied via
-- the webhook. The Billing page then surfaces a one-time
-- "Your downgrade to <Plan> is now active" banner on the next visit
-- and clears these fields via /billing/acknowledge-downgrade-completion
-- once the tenant dismisses it.
--
-- Both columns are nullable so the existing rows / pre-rollout tenants
-- carry no notice (the banner only fires when they're populated).

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS downgrade_completed_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS downgrade_completed_to_plan VARCHAR(50) NULL;
