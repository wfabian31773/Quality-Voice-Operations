/**
 * Public types for the cost-reconciliation system.
 *
 * See docs/audit/11-cost-reconciliation-design.md for the full design.
 *
 * This is the schema + types commit (1 of 4). The actual service +
 * dispatcher + scheduler land in subsequent commits but reference
 * these types so the wire shape is fixed up-front.
 */

/**
 * Mirrors the `billing_recon_status` Postgres enum from migration 112.
 *
 * Wayne's explicit ask was that EVERY tenant — paid, trialing, demo,
 * free, cancelled — gets a reconciliation row each month, with
 * `billing_status` telling us which bucket they're in. The cron uses
 * this to know whether to look up Stripe invoices for the revenue
 * side or default to zero.
 */
export type BillingReconStatus =
  | 'invoiced_paid'           // Stripe invoice paid in this period
  | 'invoiced_open'           // Stripe invoice issued, awaiting payment
  | 'invoiced_failed'         // Stripe invoice failed/uncollectible
  | 'trialing'                // Active trial subscription, no invoice yet
  | 'free_tier'               // No active subscription
  | 'demo'                    // DEMO_TENANT_ID, always non-billed
  | 'cancelled_no_invoice';   // Sub cancelled mid-period, no invoice issued

/**
 * Why a reconciliation row's `alert_triggered` flag was raised, if any.
 *
 * Precedence (most→least severe): `losing_money` > `unbilled_cost_threshold`
 * > `below_healthy_floor`. At most one alert_reason per row. The
 * dispatcher uses this to choose the email subject line + severity
 * emoji.
 *
 * `unbilled_cost_threshold` is the "we're spending too much on
 * non-paying tenants" tripwire — fires when a demo/trial/free/
 * cancelled tenant's internal_cost_cents exceeds
 * UNBILLED_COST_CEILING_CENTS (env default $5000 = $50/month).
 */
export type AlertReason =
  | 'losing_money'
  | 'unbilled_cost_threshold'
  | 'below_healthy_floor';

/**
 * One reconciliation row as it lives in the DB + flows through the
 * service layer. Mirrors the `billing_reconciliation` table from
 * migration 112 one-to-one.
 *
 * All cent values are integers (or NUMERIC scaled to integer cents in
 * the case of `twilioCostCents`, which preserves Twilio's sub-cent
 * precision per migration 110 §3). The "currency stored as integer
 * cents" project convention applies.
 */
export interface BillingReconciliationRow {
  id: string;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  billingStatus: BillingReconStatus;

  // Revenue side
  invoiceTotalCents: number;
  invoiceCurrency: string;
  stripeInvoiceIds: string[];
  stripeFeeCents: number;
  stripeFeeEstimated: boolean;

  // Cost side
  internalCostCents: number;
  conversationCount: number;
  openaiCostCents: number;
  /**
   * NUMERIC(12,4) in the DB — sub-cent Twilio precision preserved.
   * Carried through as a JS number; for tiny per-call values
   * (< 0.01¢) this is lossy but for the monthly aggregate it's
   * within sub-cent rounding error.
   */
  twilioCostCents: number | null;
  infraCostCents: number;
  estimateRowCount: number;

  // Margin
  marginCents: number;
  /**
   * NULL when invoiceTotalCents = 0 (can't compute % against zero
   * revenue). The dispatcher uses NULL as the signal to consider an
   * unbilled-cost alert instead of a percentage alert.
   */
  marginPercent: number | null;

  // Alert state
  alertTriggered: boolean;
  alertReason: AlertReason | null;

  // Provenance
  computedAt: Date;
  computedMethod: 'cron' | 'manual';
}

/**
 * Returned by `ReconciliationService.computeReconciliation(...)` —
 * the pure-function output that the scheduler UPSERTs into the table
 * and the dispatcher reads for alert email construction.
 *
 * `previousAlertTriggered` carries over the prior row's
 * `alert_triggered` value so the dispatcher's dedup logic in commit 2
 * can compare against it without a second DB round-trip.
 */
export interface ReconciliationResult {
  row: Omit<BillingReconciliationRow, 'id' | 'computedAt'>;
  previousAlertTriggered: boolean;
  previousAlertReason: AlertReason | null;
}

/**
 * Context passed to AlertDispatcher when an email is to be sent.
 * Built from a freshly-UPSERTed row + the tenant's display name (the
 * dispatcher doesn't read `tenants` directly so it can be unit-tested
 * without a DB).
 */
export interface AlertContext {
  tenantId: string;
  tenantName: string;
  row: BillingReconciliationRow;
  /**
   * URL of the admin page where Wayne can drill into this row. The
   * dispatcher embeds this in the email body. Constructed by the
   * scheduler from `process.env.ADMIN_BASE_URL` (no value → omitted).
   */
  adminUrl?: string;
}
