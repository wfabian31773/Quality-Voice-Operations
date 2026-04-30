-- Migration 104: instrumentation for the BillingEstimator's
-- "Switch to <Plan>" recommendation banner.
--
-- Three event types are recorded:
--   * 'impression'      — the recommendation card rendered for a tenant
--   * 'click'           — the tenant clicked the "Switch to <Plan>" CTA
--   * 'switch_completed' — Stripe confirmed the checkout completed for
--                          a session that originated from the banner
--
-- Writers:
--   * Impression / click rows are written from the tenant-facing
--     POST /billing/recommendation-event under tenant RLS context.
--   * switch_completed rows are written ONLY from the Stripe webhook
--     (handleCheckoutCompleted in platform/billing/stripe/webhook.ts)
--     when the checkout session metadata carries the recommendation
--     snapshot stamped at checkout creation time. The tenant-facing
--     POST endpoint rejects this event type so a tenant cannot inflate
--     the conversion count.

CREATE TABLE IF NOT EXISTS billing_recommendation_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL
    CHECK (event_type IN ('impression', 'click', 'switch_completed')),
  current_tier VARCHAR(32) NOT NULL,
  recommended_tier VARCHAR(32) NOT NULL,
  monthly_savings_cents BIGINT,
  trailing_window_months INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_recommendation_events_created
  ON billing_recommendation_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_recommendation_events_type_created
  ON billing_recommendation_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_recommendation_events_tenant_created
  ON billing_recommendation_events(tenant_id, created_at DESC);

ALTER TABLE billing_recommendation_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS tenant_isolation_billing_recommendation_events
    ON billing_recommendation_events;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY tenant_isolation_billing_recommendation_events
  ON billing_recommendation_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
