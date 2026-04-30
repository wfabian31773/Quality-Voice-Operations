-- Migration 105: extend billing_recommendation_events to capture
-- impressions / clicks / completions for the upgrade-card *discount
-- badge*. Mirrors the recommendation-banner contract introduced in 104,
-- but tied to the resolved coupon / promotion code (so we can answer
-- "which active discount surfaces are converting?").
--
-- Three new event types are recorded:
--   * 'discount_impression'      — the discount badge rendered for a
--                                   tenant on the BillingEstimator's
--                                   upgrade comparison card.
--   * 'discount_click'           — the tenant clicked the "Upgrade"
--                                   CTA on a tier with an active
--                                   discount (forwarded to checkout).
--   * 'discount_switch_completed' — Stripe confirmed the checkout
--                                   completed for a session whose
--                                   metadata carried the discount
--                                   snapshot (server-attributed).
--
-- Writers:
--   * discount_impression / discount_click — written from the
--     tenant-facing POST /billing/recommendation-event under tenant
--     RLS context.
--   * discount_switch_completed — written ONLY from the Stripe webhook
--     (handleCheckoutCompleted in platform/billing/stripe/webhook.ts)
--     when the checkout session metadata carries the discount snapshot
--     stamped at checkout creation time. The tenant-facing POST endpoint
--     rejects this event type so a tenant cannot inflate the conversion
--     count by hitting the analytics endpoint directly.
--
-- Two columns are added so the same row carries the resolved discount
-- identity:
--   * coupon_id       — Stripe `cou_*` id for the underlying coupon (may
--                       be NULL when only a raw promotion code was used).
--   * promotion_code  — the human-readable "PROMO25" tenants enter
--                       (NULL when a raw coupon was attached without a
--                       published promo code).
--
-- These columns stay NULL on the original 'impression' / 'click' /
-- 'switch_completed' rows from the recommendation banner.

ALTER TABLE billing_recommendation_events
  ADD COLUMN IF NOT EXISTS coupon_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS promotion_code VARCHAR(255);

-- Replace the event_type CHECK to also allow the three discount-flavored
-- event types. Postgres won't let us alter a CHECK in place, so drop the
-- existing one and re-add with the expanded set. The constraint name
-- below was the auto-generated default from migration 104; we look it up
-- by relation/column to stay resilient to that.
DO $$
DECLARE
  c_name text;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'billing_recommendation_events'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%event_type%'
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE billing_recommendation_events DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE billing_recommendation_events
  ADD CONSTRAINT billing_recommendation_events_event_type_check
    CHECK (event_type IN (
      'impression',
      'click',
      'switch_completed',
      'discount_impression',
      'discount_click',
      'discount_switch_completed'
    ));

-- Discount funnel grouped by (coupon_id, promotion_code, created_at):
-- the admin report aggregates discount events per coupon, ordered by
-- recency. A partial index keyed on the discount columns keeps the scan
-- bounded — discount-flavored rows are a strict subset of the table.
CREATE INDEX IF NOT EXISTS idx_billing_recommendation_events_discount
  ON billing_recommendation_events(coupon_id, promotion_code, created_at DESC)
  WHERE event_type IN (
    'discount_impression',
    'discount_click',
    'discount_switch_completed'
  );
