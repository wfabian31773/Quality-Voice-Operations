# Cost-reconciliation system — design doc (fix #5)

**Date:** 2026-05-29
**Author:** Claude (planning, no code touched)
**Prior context:** docs/audit/10-cost-tracking-audit.md §2.4 — the
architectural HIGH finding from the cost-tracking audit. Fixes #1–#4
have already shipped (`38f475c`, `3ac112d`, `e9a45c9`, `2ac3804`); this
is the last piece.

This is the deliverable Wayne asked for before code: a written design
that closes the loop between "what we billed the customer through
Stripe" and "what the call actually cost us internally", so margin per
tenant is computable to the penny and an alert email fires when it
breaks the floor.

### Wayne's directional answers (folded into this revision)

  * Healthy margin floor = **20%**
  * Cron runs in **dev + prod** (no env-flag gating)
  * Notification channel = **email to `fabianwayne1@gmail.com`** via
    the existing email-service. There is no Slack workspace. The
    speculative `OPS_SLACK_WEBHOOK_URL` references in the existing
    `StripePriceVerificationScheduler.ts` and
    `billingBackfillCrossDayNotifier.ts` will get rerouted to the same
    email path in a small follow-up commit at the end (§9 commit 4).
  * **Include demo + trial + free-tier tenants.** Every tenant gets
    a reconciliation row regardless of whether they pay us. Demo /
    trial tenants by definition have `revenue = 0`, so the row exists
    to surface what we're spending net-negative.

---

## 1. Summary

For every tenant (paid, trialing, demo, free, cancelled) and every
calendar month, compute:

  revenue        = SUM(stripe_invoice.amount_paid where period_end in month)
                   — zero for tenants without paid invoices
  internal_cost  = SUM(conversation_costs.total_cost_cents where created_at in month)
  stripe_fee     = revenue × 2.9% + 30¢ per invoice  (estimated; real fee is v2)
  margin_cents   = revenue − stripe_fee − internal_cost
  margin_percent = margin_cents ÷ revenue × 100  (NULL when revenue = 0)

Persist one row per `(tenant_id, calendar_month)` to a new
`billing_reconciliation` table. UPSERT so daily runs refresh the
current month's row with month-to-date growth (Wayne shouldn't have to
wait for month-end to discover a tenant is bleeding margin).

Send an alert email to `fabianwayne1@gmail.com` when the row's
`alert_reason` is set:

  * `losing_money` — paid tenant with `margin_cents < 0`
  * `below_healthy_floor` — paid tenant with `margin_percent < 20`
  * `unbilled_cost_threshold` — non-paid tenant (demo/trial/free)
     whose `internal_cost_cents > UNBILLED_COST_CEILING` (env var,
     default $50/month). This is the "what are we spending on demos
     and trials" tripwire Wayne specifically called out.

Daily cron at 02:00 UTC. Webhook-triggered reconciliation is a v2
upgrade — not in scope for this commit.

---

## 2. Data flow

```
Daily cron 02:00 UTC
        │
        ▼
┌─────────────────────────────────┐
│ For each calendar month in      │
│ the rolling window (current     │
│ month + prior month, so we      │
│ refresh both):                  │
│   SELECT id, status FROM tenants│
│   WHERE NOT archived            │
└─────────────────────────────────┘
        │
        │ for each (tenant, month)
        ▼
┌─────────────────────────────────┐
│ Determine billing_status:       │
│  • paid_subscription?           │
│  • trialing?                    │
│  • cancelled?                   │
│  • demo (tenant_id='demo')?     │
│  • free_tier?                   │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ REVENUE SIDE                    │
│ if has Stripe customer:         │
│   stripe.invoices.list({        │
│     customer: stripeCustomerId, │
│     status: 'paid',             │
│     created: month bounds       │
│   })                            │
│   sum amount_paid, capture IDs  │
│ else:                           │
│   revenue = 0                   │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ COST SIDE                       │
│ SELECT                          │
│   SUM(total_cost_cents),        │
│   SUM(llm_cost_cents),          │
│   SUM(twilio_price_cents),      │
│   SUM(infra_cost_cents),        │
│   COUNT(*),                     │
│   SUM(CASE WHEN                 │
│     usage_capture_source =      │
│     'estimate' THEN 1 ELSE 0)   │
│ FROM conversation_costs         │
│ WHERE tenant_id = $1            │
│   AND created_at >=  month_start│
│   AND created_at <   month_end  │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ Compute margin + alert_reason   │
│ UPSERT billing_reconciliation   │
│ ON CONFLICT (tenant_id,         │
│   period_start)                 │
│ DO UPDATE                       │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ if alert_reason set AND         │
│    alert_triggered = false:     │
│   sendEmail(                    │
│     to: MARGIN_ALERT_EMAIL,     │
│     subject + body...)          │
│   mark alert_triggered = true   │
└─────────────────────────────────┘
```

**Why calendar months instead of Stripe billing periods?**
Two reasons: (1) non-Stripe tenants need *some* time bucket and
calendar months are the only universal one, and (2) all tenants
then bucket consistently for cross-tenant rollups in the dashboards
later. The cost of this choice: a Stripe invoice whose billing
period straddles a month boundary (e.g. tenant signed up on the
15th) gets attributed to the month its `period_end` falls in, so
that month's margin reads a bit high and the prior month reads a
bit low. Over 12 months this evens out; for single-month alerts
the skew is acceptable.

---

## 3. Schema

### 3.1 New table: `billing_reconciliation`

```sql
CREATE TYPE billing_recon_status AS ENUM (
  'invoiced_paid',          -- Stripe invoice paid, full revenue captured
  'invoiced_open',          -- Stripe invoice issued, not yet paid
  'invoiced_failed',        -- Stripe invoice failed/uncollectible
  'trialing',               -- Active trial, no revenue
  'free_tier',              -- No subscription, no revenue
  'demo',                   -- DEMO_TENANT_ID, no revenue
  'cancelled_no_invoice'    -- Sub cancelled mid-month, no invoice for the period
);

CREATE TABLE billing_reconciliation (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Calendar month bounds. period_start = first day of month at 00:00:00 UTC.
  -- period_end = first day of NEXT month at 00:00:00 UTC (half-open).
  -- One row per (tenant_id, calendar_month) regardless of how many or
  -- few Stripe invoices land in that window — see the JSONB array
  -- below for the multi-invoice case.
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,

  billing_status billing_recon_status NOT NULL,

  -- REVENUE SIDE — what Stripe collected (zero for non-billed tenants)
  invoice_total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  -- Array of Stripe invoice IDs that contributed to invoice_total_cents
  -- (a high-volume tenant could have multiple invoices in one month if
  -- their cycle is shorter than monthly, or proration events fire).
  -- Empty array for non-billed tenants.
  stripe_invoice_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  stripe_fee_cents INTEGER NOT NULL DEFAULT 0,    -- estimated 2.9% + 30¢ per invoice
  stripe_fee_estimated BOOLEAN NOT NULL DEFAULT TRUE,

  -- COST SIDE — what we spent on this tenant in this period
  internal_cost_cents BIGINT NOT NULL,
  conversation_count INTEGER NOT NULL,
  openai_cost_cents INTEGER NOT NULL,
  twilio_cost_cents NUMERIC(12,4),                -- sub-cent precision
  infra_cost_cents INTEGER NOT NULL,
  estimate_row_count INTEGER NOT NULL DEFAULT 0,  -- where usage_capture_source='estimate'

  -- MARGIN
  margin_cents BIGINT NOT NULL,                   -- revenue − stripe_fee − internal_cost
  margin_percent NUMERIC(6,2),                    -- NULL when invoice_total = 0

  -- ALERT STATE
  alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  alert_reason VARCHAR(40),
    -- 'losing_money'              — paid tenant, margin_cents < 0
    -- 'below_healthy_floor'       — paid tenant, margin_percent < 20
    -- 'unbilled_cost_threshold'   — non-paid tenant, internal_cost > ceiling
    -- NULL                        — no alert

  -- PROVENANCE
  computed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  computed_method VARCHAR(20) NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual'

  UNIQUE(tenant_id, period_start)
);

CREATE INDEX idx_billing_reconciliation_tenant_period
  ON billing_reconciliation(tenant_id, period_start DESC);
CREATE INDEX idx_billing_reconciliation_negative_margin
  ON billing_reconciliation(tenant_id, computed_at DESC)
  WHERE margin_cents < 0;
CREATE INDEX idx_billing_reconciliation_unbilled_cost
  ON billing_reconciliation(tenant_id, computed_at DESC)
  WHERE billing_status IN ('trialing', 'free_tier', 'demo', 'cancelled_no_invoice')
    AND internal_cost_cents > 0;

ALTER TABLE billing_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_billing_reconciliation
  ON billing_reconciliation
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
```

### 3.2 Why BIGINT for `internal_cost_cents` and `margin_cents`?

INTEGER max is ~$21M. A high-volume tenant doing ~$50K/month of calls
× 12 months would only hit ~$600K — INTEGER would fit. But the
aggregate across all tenants for a full year already pushes that
ceiling. BIGINT is free and removes the failure mode.

### 3.3 Why no per-tenant margin floor table?

Out of scope for v1. Hardcoded env-tunable thresholds:
  * `LOSING_MONEY_THRESHOLD_CENTS = 0` (any negative)
  * `HEALTHY_FLOOR_PERCENT = parseInt(process.env.OPS_MARGIN_HEALTHY_PCT ?? '20')`
  * `UNBILLED_COST_CEILING_CENTS = parseInt(process.env.UNBILLED_COST_CEILING_CENTS ?? '5000')`
    (default $50/month per non-paid tenant)

Per-tenant floors can come later if Wayne wants different thresholds
per enterprise contract (e.g. flagship customer floor = 35%, or a
generous demo budget for a specific prospect).

---

## 4. Module layout

```
platform/billing/
  BillingReconciliationScheduler.ts        -- daily cron, matches existing
                                              scheduler pattern
                                              (StripePriceVerificationScheduler etc.)
  reconciliation/
    index.ts                                -- public re-exports
    ReconciliationService.ts                -- compute-margin business logic
    AlertDispatcher.ts                      -- email alert sender, calls
                                              into platform/email
    types.ts                                -- ReconciliationResult,
                                              AlertContext, AlertReason
```

### 4.1 AlertDispatcher integration with the existing email-service

Calls into the existing `platform/email/` module (the same one that
powers welcome emails, billing failure notices, etc.). No new SMTP /
SES config — reuses whatever the email-service is already configured
with.

Single recipient by default: `fabianwayne1@gmail.com`. Env-overridable
via `MARGIN_ALERT_EMAIL` (and supports a comma-separated list for the
day Wayne wants to add a CFO or co-founder).

### 4.2 Repointing the legacy schedulers

`StripePriceVerificationScheduler.ts` and
`billingBackfillCrossDayNotifier.ts` currently reference
`OPS_SLACK_WEBHOOK_URL`. Since there is no Slack, their alerts have
been silently no-op'd since they shipped. Commit 4 (see §9) reroutes
both to the same `AlertDispatcher.sendOpsAlert(...)` path so all
three feeds land in the same inbox with consistent formatting.

---

## 5. Cron schedule + idempotency

**Schedule:** daily at 02:00 UTC. Same `setInterval` pattern as the
other six schedulers in `platform/billing/`.

**What each run does:** walks ALL non-archived tenants. For each tenant
× (current month + prior month) — two rows per tenant per run —
computes the reconciliation and UPSERTs. Refreshing both months means
late-arriving conversation_costs rows (Twilio Price callbacks that
land days after the call) and late-paid Stripe invoices get folded in
on the next run without manual intervention.

**Idempotency:** `UNIQUE(tenant_id, period_start)`. ON CONFLICT DO
UPDATE overwrites all the computed fields (cost, revenue, margin,
alert_reason). The `alert_triggered` flag is preserved across re-runs
so we don't double-send the same alert email — see §6.3.

**Bootstrap on first run after deploy:** walks the past 90 days
(roughly 3 months) of tenants × months to fill in any backlog.
Subsequent runs hold to the 2-month window.

**Skip conditions:**
  * Non-USD tenants for the revenue side (logged as warn; cost side
    is still recorded so we don't lose visibility) — multi-currency
    margin is v2
  * Tenants in `tenants.archived_at IS NOT NULL` (no longer active)

---

## 6. Alert thresholds and email format

### 6.1 Alert reasons

```ts
type AlertReason =
  | 'losing_money'             // paid tenant, margin_cents < 0
  | 'below_healthy_floor'      // paid tenant, margin_percent < HEALTHY_FLOOR_PERCENT
  | 'unbilled_cost_threshold'; // non-paid tenant, internal_cost > UNBILLED_COST_CEILING
```

Precedence (most→least severe): `losing_money` > `unbilled_cost_threshold`
> `below_healthy_floor`. At most one `alert_reason` per row.

### 6.2 Email format

Subject line carries the severity so it's scannable from the inbox:

  * `🚨 LOSING MONEY: <tenant_name> ($X.XX margin · YYYY-MM)`
  * `🚨 UNBILLED COSTS: <tenant_name> ($X.XX · YYYY-MM)`
  * `⚠ Margin below floor: <tenant_name> (P% · YYYY-MM)`

Body uses the existing email-service's HTML template wrapper, with
this content block:

```
Tenant:        <tenant_name>  (<tenant_id>)
Billing status: <billing_status>
Period:        <YYYY-MM-DD>  →  <YYYY-MM-DD>

Revenue:        $X.XX  (Stripe invoices: <ids> if any)
Stripe fee:    -$Y.YY  (~2.9% + 30¢, estimated)
Internal cost: -$Z.ZZ  (<N> conversations)
─────────────────────────────────────────
Margin:         $M.MM  (<P>% if revenue > 0)

Cost breakdown:
  OpenAI:    $A.AA  (avg $a per call)
  Twilio:    $B.BB  (avg $b per call)
  Infra:     $C.CC  (placeholder allocation; see audit §2.5)

[⚠] K of N conversations used ESTIMATE token counts — margin may
    be off until those rows are re-attributed via response.done.usage.

View row: <admin URL>
```

### 6.3 Alert deduplication

The `alert_triggered` boolean on each `billing_reconciliation` row
is what prevents email spam:

  * First time a row's `alert_reason` flips to non-NULL → send email,
    set `alert_triggered = true`.
  * Subsequent re-runs that find the same row still in the alert
    state → no email, row is updated in place.
  * If the `alert_reason` clears (margin recovered) → reset
    `alert_triggered = false` so the next breach re-alerts.
  * If `alert_reason` changes to a *more severe* level (e.g.
    `below_healthy_floor` → `losing_money`) → send a fresh email,
    keep `alert_triggered = true`. The email subject reflects the
    new severity.

Captured in the `ReconciliationService` via a single CASE expression
in the UPSERT.

---

## 7. Non-goals (explicit, to avoid scope creep)

  1. **Per-tenant margin floor configuration.** Use hardcoded
     `HEALTHY_FLOOR_PERCENT` env var. Per-tenant table later.
  2. **Multi-currency reconciliation.** USD only for v1. Non-USD
     tenants skipped with a warn log.
  3. **Exact Stripe fee capture.** Estimate 2.9% + 30¢ for v1; pull
     real fee from `balance_transactions` API in v2.
  4. **Webhook-triggered reconciliation.** Daily cron only; add an
     `invoice.paid` webhook listener in v2 for faster alerts.
  5. **Admin UI dashboard.** Read the table directly from Replit
     Postgres for v1. Build a Platform Admin panel later.
  6. **Per-call attribution from invoice line items.** Period-coarse
     attribution (sum all conversation_costs in the period) is
     sufficient for margin alerts. Per-call drill-down can be added
     by joining `usage_metrics.details->callSessionId` back into
     `conversation_costs` — out of scope now.
  7. **Historical backfill beyond 7 days.** Bootstrap walks 7 days.
     If Wayne wants the full historical reconciliation he can run a
     one-off script that walks `invoices.list` paginated.
  8. **Reconciling failed / refunded invoices.** v1 only handles
     `status = 'paid'`. Refunds and disputes need their own handling
     and would skew margin if mixed in naively.

---

## 8. Open questions for Wayne before code

All five original questions are now resolved:

  ✅ **Q1.** Alert channel: email to `fabianwayne1@gmail.com` via the
  existing email-service. (Slack is not used.)
  ✅ **Q2.** Default healthy margin floor: 20% (`OPS_MARGIN_HEALTHY_PCT`).
  ✅ **Q3.** Cron runs in dev + prod, no env-flag gating.
  ✅ **Q4.** Estimate-row warning is inline in the alert email body.
  ✅ **Q5.** Demo + trial + free-tier tenants are INCLUDED, with
  `revenue = 0` and the `unbilled_cost_threshold` alert reason when
  spend exceeds `UNBILLED_COST_CEILING_CENTS` (default $50/month).

No remaining open questions. Ready to ship commit 1 on your go.

---

## 9. Suggested implementation order

Four commits, each independently revertible:

  **Commit 1 — schema + types** (~80 lines, near-zero risk)
    * migration 112: `billing_recon_status` enum + `billing_reconciliation`
      table + 3 indexes + RLS policy
    * `platform/billing/reconciliation/types.ts` (BillingReconStatus,
      AlertReason, ReconciliationResult, AlertContext)
    * `platform/billing/reconciliation/index.ts` (stub re-exports)

  **Commit 2 — reconciliation logic** (~300 lines)
    * `ReconciliationService.ts` — pure compute function: takes
      (tenantId, periodStart, periodEnd, stripeClient, dbClient),
      returns ReconciliationResult. Determines billing_status, fetches
      Stripe invoices for the window if applicable, sums
      conversation_costs, computes margin + alert_reason.
    * `AlertDispatcher.ts` — builds the email subject + HTML body
      from a ReconciliationResult, calls the existing email-service
      to send. No-ops cleanly if MARGIN_ALERT_EMAIL is unset.
    * Unit-style tests for the pure compute logic against in-memory
      data (no live Stripe round-trip; Stripe lookup is a passed-in
      dependency).

  **Commit 3 — scheduler wiring** (~120 lines)
    * `BillingReconciliationScheduler.ts` — daily cron timer.
      Walks tenants × (current + prior month), calls ReconciliationService
      per pair, UPSERTs the result, dispatches alerts where appropriate.
    * Bootstrap-on-startup: detect first run (no rows in
      `billing_reconciliation`) → walk past 90 days.
    * Wire into `server/admin-api/start.ts` next to the other
      schedulers' start calls.
    * Add a manual trigger endpoint `POST /admin/billing/reconciliation/run`
      (admin-only) for ad-hoc invocation during debugging or after a
      late Stripe webhook.

  **Commit 4 — reroute legacy schedulers off OPS_SLACK_WEBHOOK_URL** (~50 lines)
    * `StripePriceVerificationScheduler.ts`: replace
      `postToSlack(OPS_SLACK_WEBHOOK_URL, ...)` with
      `AlertDispatcher.sendOpsAlert({ subject, body, severity })`.
    * `billingBackfillCrossDayNotifier.ts`: same.
    * Remove the dead `OPS_SLACK_WEBHOOK_URL` env-var references and
      the no-op Slack POST helper.
    * Sanity-test by triggering each scheduler in dev (price drift
      simulator, backfill simulator) and confirming the email arrives.

After commit 3 ships, the first real reconciliation runs on the next
02:00 UTC tick or whenever someone hits the manual-trigger endpoint.
After commit 4 ships, the two pre-existing schedulers' alerts (which
have been silently dropped) start landing in the same inbox with
consistent formatting.

---

## 10. What I will NOT do without your sign-off

  * Touch live Stripe data (the read-only `invoices.list` is fine;
    no mutations).
  * Wire a new Stripe webhook listener (out of scope for v1).
  * Add the per-tenant margin floor table (out of scope for v1).
  * Build any UI surface (out of scope for v1).
  * Re-bill any tenant or modify any invoice.

---

All open questions resolved. Ready to ship commit 1 when you say go.
