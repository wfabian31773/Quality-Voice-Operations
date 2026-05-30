/**
 * Cost-reconciliation compute logic (cost audit fix #5, commit 2/4).
 *
 * Pure function (modulo logging): takes tenant context + period bounds
 * + injected adapters for the DB and Stripe round-trips, returns a
 * `ReconciliationResult` ready for the scheduler in commit 3 to UPSERT.
 *
 * Adapters are injected so this module is unit-testable without spinning
 * up Postgres or hitting Stripe. The production scheduler in commit 3
 * builds the real adapters using `getPlatformPool()` + `getStripeClient()`.
 *
 * See docs/audit/11-cost-reconciliation-design.md for the full design.
 */

import { createLogger } from '../../core/logger';
import type {
  AlertReason,
  BillingReconStatus,
  BillingReconciliationRow,
  ReconciliationResult,
} from './types';

const logger = createLogger('RECONCILIATION_SERVICE');

// -----------------------------------------------------------------------
// Thresholds & constants (env-overridable)
// -----------------------------------------------------------------------

/**
 * Margin floor below which a paid tenant triggers `below_healthy_floor`.
 * Wayne's chosen default: 20%. Env-tunable so a v2 per-tenant floor table
 * can later override per-tenant.
 */
export const HEALTHY_FLOOR_PERCENT = parseInt(process.env.OPS_MARGIN_HEALTHY_PCT ?? '20', 10);

/**
 * Cents of internal cost above which a non-paid tenant
 * (demo/trial/free/cancelled) triggers `unbilled_cost_threshold`.
 * Default $50/month. This is Wayne's "what are we spending on demos
 * and trials" tripwire.
 */
export const UNBILLED_COST_CEILING_CENTS = parseInt(
  process.env.UNBILLED_COST_CEILING_CENTS ?? '5000',
  10,
);

/**
 * Stripe US baseline fee. We estimate (2.9% + 30¢) per invoice for v1.
 * A real per-invoice fee lookup against `balance_transactions` is a v2
 * upgrade (audit doc §1.1). Stays as constants here so a future env
 * override is a one-line change.
 */
const STRIPE_FEE_PERCENT = 0.029;
const STRIPE_FEE_FLAT_CENTS = 30;

export const DEMO_TENANT_ID = 'demo';

// -----------------------------------------------------------------------
// Injected adapter shapes (production scheduler in commit 3 fulfills these)
// -----------------------------------------------------------------------

/**
 * The subscription-side facts needed to determine `billing_status`.
 * Built from a `subscriptions` row + the tenant ID.
 */
export interface TenantBillingContext {
  /** Demo tenant short-circuits everything below. */
  isDemoTenant: boolean;
  /**
   * Whether ANY row exists in `subscriptions` for this tenant. False
   * means free_tier.
   */
  hasSubscription: boolean;
  /**
   * Raw `subscriptions.status` enum value. One of:
   * 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled'.
   * `null` when `hasSubscription = false`.
   */
  subscriptionStatus: string | null;
  /** Used to drive the Stripe `invoices.list` call. */
  stripeCustomerId: string | null;
}

/**
 * Lightweight Stripe invoice shape — only the fields we read. Keeps
 * the test fixture short and avoids depending on the full
 * `Stripe.Invoice` type.
 */
export interface StripeInvoiceLite {
  id: string;
  /** Stripe invoice status — 'paid', 'open', 'uncollectible', 'void', etc. */
  status: string;
  /** Cents actually collected. 0 for non-paid invoices. */
  amount_paid: number;
  /** ISO-4217 currency code, e.g. 'usd'. Uppercased in our row. */
  currency: string;
}

/**
 * Aggregate of `conversation_costs` rows for the (tenant, period).
 * SUM/COUNT columns; the SQL query lives in the production adapter
 * built by the scheduler in commit 3.
 */
export interface ConversationCostsAggregate {
  internalCostCents: number;
  conversationCount: number;
  openaiCostCents: number;
  twilioCostCents: number | null;
  infraCostCents: number;
  estimateRowCount: number;
}

/**
 * The three side-effecting calls the compute function needs, injected
 * so unit tests can pass mocks.
 */
export interface ReconciliationAdapters {
  fetchTenantBillingContext: (tenantId: string) => Promise<TenantBillingContext>;
  fetchStripeInvoicesInPeriod: (
    stripeCustomerId: string,
    periodStart: Date,
    periodEnd: Date,
  ) => Promise<StripeInvoiceLite[]>;
  fetchConversationCostsAggregate: (
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ) => Promise<ConversationCostsAggregate>;
}

// -----------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// -----------------------------------------------------------------------

/**
 * Choose `billing_status` from the tenant context + the invoices we
 * found in the period. Precedence is documented inline.
 */
export function determineBillingStatus(
  ctx: TenantBillingContext,
  invoices: StripeInvoiceLite[],
): BillingReconStatus {
  if (ctx.isDemoTenant) return 'demo';
  if (!ctx.hasSubscription) return 'free_tier';

  // Active trial: no invoices expected, even if the sub also has
  // `trialing` status carried over.
  if (ctx.subscriptionStatus === 'trialing' && invoices.length === 0) {
    return 'trialing';
  }

  // Has subscription. Look at the invoices to decide the state.
  const paidCount = invoices.filter((i) => i.status === 'paid').length;
  const failedCount = invoices.filter(
    (i) => i.status === 'uncollectible' || i.status === 'void',
  ).length;
  const openCount = invoices.filter((i) => i.status === 'open').length;

  // "Any paid" wins. A tenant with one paid invoice + one failed
  // refund is still effectively paid for this period.
  if (paidCount > 0) return 'invoiced_paid';
  if (failedCount > 0) return 'invoiced_failed';
  if (openCount > 0) return 'invoiced_open';

  // No invoices in period at all. If the sub is cancelled, that's
  // pre-cancellation usage we won't be paid for. Otherwise it's a
  // tenant who hasn't been billed yet (new sub, period boundary edge
  // case) — treat as 'invoiced_open' so the next run picks up the
  // expected invoice.
  if (ctx.subscriptionStatus === 'cancelled') return 'cancelled_no_invoice';
  return 'invoiced_open';
}

/**
 * Estimated Stripe processing fee for the invoice batch. Per-invoice
 * 2.9% + 30¢. A real `balance_transactions.fee` lookup is v2.
 */
export function estimateStripeFeeCents(invoices: StripeInvoiceLite[]): number {
  let fee = 0;
  for (const invoice of invoices) {
    if (invoice.status !== 'paid') continue; // unpaid invoices charge no fee
    fee += Math.round(invoice.amount_paid * STRIPE_FEE_PERCENT) + STRIPE_FEE_FLAT_CENTS;
  }
  return fee;
}

/**
 * Pick the alert reason for a freshly computed row. NULL when nothing
 * to alert on. Precedence (most→least severe):
 *   1. losing_money            — any 'invoiced_*' tenant with negative margin
 *   2. unbilled_cost_threshold — non-invoiced tenant whose cost exceeds the ceiling
 *   3. below_healthy_floor     — paid tenant whose margin% drops under the floor
 */
export function determineAlertReason(
  billingStatus: BillingReconStatus,
  marginCents: number,
  marginPercent: number | null,
  internalCostCents: number,
): AlertReason | null {
  const isInvoiced = billingStatus.startsWith('invoiced_');

  if (isInvoiced && marginCents < 0) return 'losing_money';

  if (!isInvoiced && internalCostCents > UNBILLED_COST_CEILING_CENTS) {
    return 'unbilled_cost_threshold';
  }

  if (
    billingStatus === 'invoiced_paid' &&
    marginPercent !== null &&
    marginPercent < HEALTHY_FLOOR_PERCENT
  ) {
    return 'below_healthy_floor';
  }

  return null;
}

/**
 * Numeric severity for AlertReason — used by the dispatcher to detect
 * escalations across re-runs (e.g. 'below_healthy_floor' → 'losing_money'
 * triggers a fresh email even if `alert_triggered` is already true).
 */
export function alertSeverity(reason: AlertReason | null): number {
  switch (reason) {
    case 'losing_money':
      return 3;
    case 'unbilled_cost_threshold':
      return 2;
    case 'below_healthy_floor':
      return 1;
    case null:
    case undefined:
      return 0;
  }
}

// -----------------------------------------------------------------------
// Main compute function
// -----------------------------------------------------------------------

export interface ComputeReconciliationParams {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  previousAlertTriggered?: boolean;
  previousAlertReason?: AlertReason | null;
}

/**
 * Reconcile one tenant against one calendar month.
 *
 * Pulls subscription state + Stripe invoices + conversation_costs
 * aggregate via the injected adapters, computes margin + alert reason,
 * returns the row shape ready to UPSERT. Does NOT touch the DB or send
 * email — those side effects belong to the scheduler (commit 3) and the
 * dispatcher (this commit).
 */
export async function computeReconciliation(
  params: ComputeReconciliationParams,
  adapters: ReconciliationAdapters,
): Promise<ReconciliationResult> {
  const { tenantId, periodStart, periodEnd } = params;

  const ctx = await adapters.fetchTenantBillingContext(tenantId);

  const invoices: StripeInvoiceLite[] =
    ctx.stripeCustomerId && !ctx.isDemoTenant
      ? await adapters.fetchStripeInvoicesInPeriod(
          ctx.stripeCustomerId,
          periodStart,
          periodEnd,
        )
      : [];

  const billingStatus = determineBillingStatus(ctx, invoices);

  // REVENUE side
  // `amount_paid` is in cents already; only count paid invoices.
  const paidInvoices = invoices.filter((i) => i.status === 'paid');
  const invoiceTotalCents = paidInvoices.reduce((sum, i) => sum + i.amount_paid, 0);
  const stripeInvoiceIds = invoices.map((i) => i.id);
  // First invoice's currency wins; almost always 'usd'. Uppercased for
  // consistency with the rest of the schema (we store ISO codes uppercase).
  const invoiceCurrency = (invoices[0]?.currency ?? 'usd').toUpperCase();
  const stripeFeeCents = estimateStripeFeeCents(invoices);

  // COST side
  const costs = await adapters.fetchConversationCostsAggregate(
    tenantId,
    periodStart,
    periodEnd,
  );

  // MARGIN
  const netRevenue = invoiceTotalCents - stripeFeeCents;
  const marginCents = netRevenue - costs.internalCostCents;
  const marginPercent =
    invoiceTotalCents > 0
      ? Math.round((marginCents / invoiceTotalCents) * 10000) / 100
      : null;

  const alertReason = determineAlertReason(
    billingStatus,
    marginCents,
    marginPercent,
    costs.internalCostCents,
  );

  const previousAlertTriggered = params.previousAlertTriggered ?? false;
  const previousAlertReason = params.previousAlertReason ?? null;

  // The scheduler will UPSERT this; `alert_triggered` is computed by
  // the dispatcher's `shouldSendAlert` logic, so we mirror the prior
  // value here and let the dispatcher overwrite once it decides.
  const row: Omit<BillingReconciliationRow, 'id' | 'computedAt'> = {
    tenantId,
    periodStart,
    periodEnd,
    billingStatus,
    invoiceTotalCents,
    invoiceCurrency,
    stripeInvoiceIds,
    stripeFeeCents,
    stripeFeeEstimated: true,
    internalCostCents: costs.internalCostCents,
    conversationCount: costs.conversationCount,
    openaiCostCents: costs.openaiCostCents,
    twilioCostCents: costs.twilioCostCents,
    infraCostCents: costs.infraCostCents,
    estimateRowCount: costs.estimateRowCount,
    marginCents,
    marginPercent,
    alertTriggered: previousAlertTriggered,
    alertReason,
    computedMethod: 'cron',
  };

  logger.info('Reconciliation computed', {
    tenantId,
    periodStart: periodStart.toISOString(),
    billingStatus,
    invoiceTotalCents,
    internalCostCents: costs.internalCostCents,
    marginCents,
    marginPercent,
    alertReason,
  });

  return {
    row,
    previousAlertTriggered,
    previousAlertReason,
  };
}
