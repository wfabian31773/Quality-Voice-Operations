-- Cost-reconciliation system — schema (cost audit fix #5, commit 1 of 4).
--
-- See docs/audit/11-cost-reconciliation-design.md for the full design.
-- This migration is the safe-on-its-own data-model piece; the
-- ReconciliationService + AlertDispatcher + scheduler land in commits
-- 2, 3, and 4.
--
-- ROW MODEL
-- ---------
-- One row per (tenant_id, calendar_month). Period bounds are first
-- day of the month at 00:00:00 UTC, half-open so period_end is the
-- first of the NEXT month — `WHERE created_at >= period_start AND
-- created_at < period_end` is the join idiom.
--
-- Every tenant gets a row each month regardless of subscription
-- status. The `billing_status` enum captures whether they paid us,
-- are trialing, are the demo tenant, etc., so the daily cron can
-- surface "what we're spending on non-paying tenants" alongside the
-- usual margin tracking on paid ones. This was Wayne's explicit ask:
-- "we always want to see what we are spending on demo and trials."
--
-- IDEMPOTENCY + UPSERT SEMANTICS
-- ------------------------------
-- UNIQUE(tenant_id, period_start) means the cron can re-run safely
-- and refresh the current-month row with month-to-date totals as
-- conversation_costs accumulates and late Stripe invoices land. The
-- `alert_triggered` flag is preserved across re-runs to prevent
-- email spam — see commit 2's AlertDispatcher logic.

DO $$ BEGIN
  CREATE TYPE billing_recon_status AS ENUM (
    -- Stripe-billed states
    'invoiced_paid',          -- Stripe invoice paid in this period
    'invoiced_open',          -- Stripe invoice issued, awaiting payment
    'invoiced_failed',        -- Stripe invoice failed/uncollectible
    -- Non-billed states (revenue = 0)
    'trialing',               -- Active trial subscription, no invoice yet
    'free_tier',              -- No active subscription
    'demo',                   -- DEMO_TENANT_ID, always non-billed
    'cancelled_no_invoice'    -- Sub cancelled mid-period, no invoice issued
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS billing_reconciliation (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Calendar-month bounds (half-open). period_start at 00:00:00 UTC
  -- on the first of the month; period_end at 00:00:00 UTC on the
  -- first of the next month. TIMESTAMP without TZ matches the
  -- convention in usage_metrics + conversation_costs.
  period_start TIMESTAMP NOT NULL,
  period_end   TIMESTAMP NOT NULL,

  billing_status billing_recon_status NOT NULL,

  -- REVENUE SIDE — what Stripe collected. Zero for non-billed tenants.
  invoice_total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_currency    VARCHAR(3) NOT NULL DEFAULT 'USD',
  -- Array of Stripe invoice IDs that contributed to invoice_total_cents
  -- in this calendar month. Empty array `[]` for non-billed tenants.
  -- High-volume tenants with sub-monthly cycles or proration events
  -- can have multiple invoices land in one month, hence array.
  stripe_invoice_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  stripe_fee_cents     INTEGER NOT NULL DEFAULT 0,
  -- TRUE until commit-2.5 wires a real balance-transactions fetch.
  -- For v1 we estimate Stripe fees at 2.9% + 30¢ per invoice.
  stripe_fee_estimated BOOLEAN NOT NULL DEFAULT TRUE,

  -- COST SIDE — what we spent on this tenant in this period.
  -- BIGINT on internal_cost_cents because high-volume tenants × 12
  -- months across all tenants can push past INT max even though a
  -- single tenant-month wouldn't.
  internal_cost_cents BIGINT NOT NULL,
  conversation_count   INTEGER NOT NULL,
  openai_cost_cents    INTEGER NOT NULL,
  -- NUMERIC(12,4) for Twilio sub-cent precision (e.g. 0.85¢ rows
  -- summing across many cheap calls — see migration 110 for the
  -- conversation_costs.twilio_price_cents column rationale).
  twilio_cost_cents    NUMERIC(12,4),
  infra_cost_cents     INTEGER NOT NULL,
  -- Rows in conversation_costs whose usage_capture_source = 'estimate'
  -- (the legacy char/4 token estimator, see migration 111). Surfaced
  -- in the alert email so we know when the margin number is built on
  -- partly-trusted data.
  estimate_row_count   INTEGER NOT NULL DEFAULT 0,

  -- MARGIN
  -- BIGINT to match internal_cost_cents.
  margin_cents BIGINT NOT NULL,
  -- NULL when invoice_total_cents = 0 (no revenue to compute a %
  -- against). NUMERIC(6,2) so a 999.99% margin fits — extreme but
  -- possible for tenants we charge but barely call.
  margin_percent NUMERIC(6,2),

  -- ALERT STATE
  -- Set TRUE the first time AlertDispatcher sends an email for this
  -- row's alert_reason; reset to FALSE if alert_reason clears (margin
  -- recovers). Re-set TRUE if alert_reason escalates to a more severe
  -- value. See commit 2's AlertDispatcher for the state machine.
  alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'losing_money'             — paid tenant, margin_cents < 0
  -- 'unbilled_cost_threshold'  — non-paid tenant, cost > ceiling env var
  -- 'below_healthy_floor'      — paid tenant, margin_percent < 20
  -- NULL                        — no alert
  alert_reason VARCHAR(40),

  -- PROVENANCE
  computed_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  computed_method  VARCHAR(20) NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual'

  UNIQUE(tenant_id, period_start)
);

-- Tenant timeline scan: "show me this tenant's last 12 months of
-- margin", "what does the demo tenant's monthly spend look like?"
CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_tenant_period
  ON billing_reconciliation(tenant_id, period_start DESC);

-- Partial index for the "who's losing us money right now" dashboard
-- query. Negative-margin rows are rare so the partial index stays
-- small.
CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_negative_margin
  ON billing_reconciliation(tenant_id, computed_at DESC)
  WHERE margin_cents < 0;

-- Partial index for the "what are we spending on non-paying tenants
-- right now" dashboard — Wayne's explicit ask. Includes demo + trial
-- + free + cancelled_no_invoice.
CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_unbilled_cost
  ON billing_reconciliation(tenant_id, computed_at DESC)
  WHERE billing_status IN ('trialing', 'free_tier', 'demo', 'cancelled_no_invoice')
    AND internal_cost_cents > 0;

ALTER TABLE billing_reconciliation ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_billing_reconciliation
    ON billing_reconciliation
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_billing_reconciliation_insert
    ON billing_reconciliation
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
