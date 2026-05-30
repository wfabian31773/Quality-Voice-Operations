/**
 * Daily cost-reconciliation scheduler (cost audit fix #5, commit 3/4).
 *
 * Walks every active tenant × (current calendar month, prior calendar
 * month), computes margin via `computeReconciliation`, UPSERTs into
 * `billing_reconciliation`, and fires alert emails via the dispatcher
 * when a threshold trips.
 *
 * On the first run after deploy (no rows in `billing_reconciliation`),
 * walks the past 3 months to bootstrap the backlog.
 *
 * Pattern mirrors the existing schedulers in this directory —
 * `setTimeout` for the initial delayed run, `setInterval` for the
 * daily cadence, idempotent `start...()` and `stop...()` for
 * lifecycle. See StripePriceVerificationScheduler.ts.
 */

import { getPlatformPool, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';
import { getStripeClient } from './stripe/client';
import {
  computeReconciliation,
  sendReconciliationAlert,
  DEMO_TENANT_ID,
  type AlertReason,
  type BillingReconStatus,
  type ConversationCostsAggregate,
  type ReconciliationAdapters,
  type StripeInvoiceLite,
  type TenantBillingContext,
} from './reconciliation';

const logger = createLogger('BILLING_RECONCILIATION');

// -----------------------------------------------------------------------
// Schedule constants
// -----------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;  // daily
const INITIAL_DELAY_MS = 60 * 1000;               // 1 min after boot
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_LOOKBACK_MONTHS = 3;
// Stripe invoice search bound: extend the calendar-month window by 7
// days on each side so we catch invoices whose period_end falls inside
// our window even if the invoice itself was created slightly outside.
const STRIPE_SEARCH_GRACE_SECONDS = 7 * 86400;

function parseIntervalEnv(): number {
  const raw = process.env.BILLING_RECONCILIATION_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) {
    logger.warn('Ignoring invalid BILLING_RECONCILIATION_INTERVAL_MS — falling back to default', {
      raw,
      default: DEFAULT_INTERVAL_MS,
    });
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let cycleInFlight = false;

// -----------------------------------------------------------------------
// Calendar-month helpers (UTC)
// -----------------------------------------------------------------------

interface MonthBounds {
  start: Date;
  end: Date;
}

function monthBounds(year: number, monthIndex: number): MonthBounds {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function currentMonth(now: Date = new Date()): MonthBounds {
  return monthBounds(now.getUTCFullYear(), now.getUTCMonth());
}

function priorMonth(now: Date = new Date()): MonthBounds {
  return monthBounds(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

function rollingMonths(count: number, now: Date = new Date()): MonthBounds[] {
  const out: MonthBounds[] = [];
  for (let i = 0; i < count; i++) {
    out.push(monthBounds(now.getUTCFullYear(), now.getUTCMonth() - i));
  }
  return out.reverse();  // oldest first so the chronological run order is natural
}

// -----------------------------------------------------------------------
// Production adapters — back the injected interfaces in
// ReconciliationService with real Postgres + Stripe calls.
// -----------------------------------------------------------------------

async function productionFetchTenantBillingContext(
  tenantId: string,
): Promise<TenantBillingContext> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT s.status::text AS sub_status, s.stripe_customer_id
         FROM subscriptions s
         WHERE s.tenant_id = $1
         LIMIT 1`,
      [tenantId],
    );
    const row = rows[0] as { sub_status: string | null; stripe_customer_id: string | null } | undefined;
    return {
      isDemoTenant: tenantId === DEMO_TENANT_ID,
      hasSubscription: row !== undefined,
      subscriptionStatus: row?.sub_status ?? null,
      stripeCustomerId: row?.stripe_customer_id ?? null,
    };
  });
}

async function productionFetchStripeInvoicesInPeriod(
  stripeCustomerId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<StripeInvoiceLite[]> {
  const stripe = getStripeClient();
  const result: StripeInvoiceLite[] = [];
  const startTs = Math.floor(periodStart.getTime() / 1000) - STRIPE_SEARCH_GRACE_SECONDS;
  const endTs = Math.floor(periodEnd.getTime() / 1000) + STRIPE_SEARCH_GRACE_SECONDS;

  // Stripe SDK supports `for await` auto-pagination, so a tenant with
  // many invoices doesn't blow past the default 10-row first page.
  for await (const invoice of stripe.invoices.list({
    customer: stripeCustomerId,
    created: { gte: startTs, lte: endTs },
    limit: 100,
  })) {
    // Filter by period_end if available — subscription invoices carry
    // their billing period at the invoice top level, which is the
    // bucketing signal we want (the audit doc explicitly chose this
    // attribution rule). One-off invoices without a period_end fall
    // back to using `created` for the bucket.
    const periodEndSec = invoice.period_end ?? invoice.created ?? null;
    if (periodEndSec === null) continue;
    const periodEndMs = periodEndSec * 1000;
    if (periodEndMs < periodStart.getTime() || periodEndMs >= periodEnd.getTime()) {
      continue;
    }

    result.push({
      id: invoice.id ?? '',
      status: invoice.status ?? 'unknown',
      amount_paid: invoice.amount_paid ?? 0,
      currency: invoice.currency ?? 'usd',
    });
  }

  return result;
}

async function productionFetchConversationCostsAggregate(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ConversationCostsAggregate> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         COALESCE(SUM(total_cost_cents),  0)::bigint  AS internal_cost,
         COUNT(*)::bigint                              AS conversation_count,
         COALESCE(SUM(llm_cost_cents),    0)::bigint  AS openai_cost,
         COALESCE(SUM(twilio_price_cents), NULL)       AS twilio_cost,
         COALESCE(SUM(infra_cost_cents),  0)::bigint  AS infra_cost,
         COALESCE(SUM(CASE WHEN usage_capture_source = 'estimate' THEN 1 ELSE 0 END), 0)::bigint AS estimate_count
         FROM conversation_costs
         WHERE tenant_id = $1
           AND created_at >= $2
           AND created_at <  $3`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString()],
    );
    const row = rows[0] as {
      internal_cost: string | null;
      conversation_count: string | null;
      openai_cost: string | null;
      twilio_cost: string | null;
      infra_cost: string | null;
      estimate_count: string | null;
    } | undefined;
    return {
      internalCostCents: parseInt(row?.internal_cost ?? '0', 10),
      conversationCount: parseInt(row?.conversation_count ?? '0', 10),
      openaiCostCents: parseInt(row?.openai_cost ?? '0', 10),
      twilioCostCents: row?.twilio_cost !== null && row?.twilio_cost !== undefined
        ? parseFloat(row.twilio_cost)
        : null,
      infraCostCents: parseInt(row?.infra_cost ?? '0', 10),
      estimateRowCount: parseInt(row?.estimate_count ?? '0', 10),
    };
  });
}

const productionAdapters: ReconciliationAdapters = {
  fetchTenantBillingContext: productionFetchTenantBillingContext,
  fetchStripeInvoicesInPeriod: productionFetchStripeInvoicesInPeriod,
  fetchConversationCostsAggregate: productionFetchConversationCostsAggregate,
};

// -----------------------------------------------------------------------
// DB helpers (read prior row, UPSERT new row)
// -----------------------------------------------------------------------

interface PriorReconRow {
  alert_triggered: boolean;
  alert_reason: AlertReason | null;
}

async function readPriorReconRow(
  tenantId: string,
  periodStart: Date,
): Promise<PriorReconRow | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT alert_triggered, alert_reason
         FROM billing_reconciliation
         WHERE tenant_id = $1 AND period_start = $2`,
      [tenantId, periodStart.toISOString()],
    );
    return (rows[0] as unknown as PriorReconRow | undefined) ?? null;
  });
}

interface UpsertParams {
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  billingStatus: BillingReconStatus;
  invoiceTotalCents: number;
  invoiceCurrency: string;
  stripeInvoiceIds: string[];
  stripeFeeCents: number;
  internalCostCents: number;
  conversationCount: number;
  openaiCostCents: number;
  twilioCostCents: number | null;
  infraCostCents: number;
  estimateRowCount: number;
  marginCents: number;
  marginPercent: number | null;
  alertTriggered: boolean;
  alertReason: AlertReason | null;
  computedMethod: 'cron' | 'manual';
}

async function upsertReconciliationRow(params: UpsertParams): Promise<string> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO billing_reconciliation (
         tenant_id, period_start, period_end, billing_status,
         invoice_total_cents, invoice_currency, stripe_invoice_ids,
         stripe_fee_cents, stripe_fee_estimated,
         internal_cost_cents, conversation_count, openai_cost_cents,
         twilio_cost_cents, infra_cost_cents, estimate_row_count,
         margin_cents, margin_percent,
         alert_triggered, alert_reason,
         computed_method
       ) VALUES (
         $1, $2, $3, $4::billing_recon_status,
         $5, $6, $7::jsonb,
         $8, TRUE,
         $9, $10, $11,
         $12, $13, $14,
         $15, $16,
         $17, $18,
         $19
       )
       ON CONFLICT (tenant_id, period_start) DO UPDATE SET
         billing_status        = EXCLUDED.billing_status,
         period_end            = EXCLUDED.period_end,
         invoice_total_cents   = EXCLUDED.invoice_total_cents,
         invoice_currency      = EXCLUDED.invoice_currency,
         stripe_invoice_ids    = EXCLUDED.stripe_invoice_ids,
         stripe_fee_cents      = EXCLUDED.stripe_fee_cents,
         stripe_fee_estimated  = EXCLUDED.stripe_fee_estimated,
         internal_cost_cents   = EXCLUDED.internal_cost_cents,
         conversation_count    = EXCLUDED.conversation_count,
         openai_cost_cents     = EXCLUDED.openai_cost_cents,
         twilio_cost_cents     = EXCLUDED.twilio_cost_cents,
         infra_cost_cents      = EXCLUDED.infra_cost_cents,
         estimate_row_count    = EXCLUDED.estimate_row_count,
         margin_cents          = EXCLUDED.margin_cents,
         margin_percent        = EXCLUDED.margin_percent,
         alert_triggered       = EXCLUDED.alert_triggered,
         alert_reason          = EXCLUDED.alert_reason,
         computed_at           = NOW(),
         computed_method       = EXCLUDED.computed_method
       RETURNING id`,
      [
        params.tenantId,
        params.periodStart.toISOString(),
        params.periodEnd.toISOString(),
        params.billingStatus,
        params.invoiceTotalCents,
        params.invoiceCurrency,
        JSON.stringify(params.stripeInvoiceIds),
        params.stripeFeeCents,
        params.internalCostCents,
        params.conversationCount,
        params.openaiCostCents,
        params.twilioCostCents,
        params.infraCostCents,
        params.estimateRowCount,
        params.marginCents,
        params.marginPercent,
        params.alertTriggered,
        params.alertReason,
        params.computedMethod,
      ],
    );
    return (rows[0] as { id: string }).id;
  });
}

async function isBootstrapNeeded(): Promise<boolean> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM billing_reconciliation) AS exists`,
    );
    const row = rows[0] as { exists: boolean } | undefined;
    return !(row?.exists ?? false);
  });
}

interface ActiveTenant {
  id: string;
  name: string;
}

async function listActiveTenants(): Promise<ActiveTenant[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, name FROM tenants
         WHERE status = 'active'
         ORDER BY created_at`,
    );
    return rows as unknown as ActiveTenant[];
  });
}

// -----------------------------------------------------------------------
// Cycle orchestration
// -----------------------------------------------------------------------

export interface ReconciliationCycleSummary {
  tenantsProcessed: number;
  monthsProcessed: number;
  rowsUpserted: number;
  alertsSent: number;
  errors: number;
  durationMs: number;
  bootstrap: boolean;
}

/**
 * Single (tenant, month) reconciliation pass. Reads prior alert state,
 * computes via the pure service, UPSERTs the row, dispatches an alert
 * email if the dedup state machine says we should.
 */
async function reconcileOne(
  tenantId: string,
  tenantName: string,
  bounds: MonthBounds,
  source: 'cron' | 'manual',
): Promise<{ rowUpserted: boolean; alertSent: boolean }> {
  const prior = await readPriorReconRow(tenantId, bounds.start);

  const result = await computeReconciliation(
    {
      tenantId,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      previousAlertTriggered: prior?.alert_triggered ?? false,
      previousAlertReason: prior?.alert_reason ?? null,
    },
    productionAdapters,
  );

  // Decide alert dispatch BEFORE persisting the row so the
  // `alert_triggered` flag we write reflects the dispatcher's decision.
  // The dispatcher is pure-ish — it builds + sends the email but the
  // SHOULD-WE-SEND decision lives in shouldSendAlert (pure).
  let alertSent = false;

  // Construct AlertContext using a placeholder id; the dispatcher does
  // not read id, only tenant_id / tenant_name / row. We pass a
  // synthetic createdAt so the type lines up.
  const placeholderRow = {
    ...result.row,
    id: 'pending',
    computedAt: new Date(),
  };
  const dispatch = await sendReconciliationAlert(
    {
      tenantId,
      tenantName,
      row: placeholderRow,
    },
    {
      triggered: result.previousAlertTriggered,
      reason: result.previousAlertReason,
    },
  );
  alertSent = dispatch.sent;

  // Compute the final alert_triggered to persist.
  //
  // Rules:
  //   * Current alertReason null    → reset to FALSE (recovery)
  //   * Dispatch sent THIS run       → set TRUE
  //   * Otherwise                    → preserve prior value
  const newAlertTriggered =
    result.row.alertReason === null
      ? false
      : alertSent
      ? true
      : result.previousAlertTriggered;

  await upsertReconciliationRow({
    tenantId,
    periodStart: bounds.start,
    periodEnd: bounds.end,
    billingStatus: result.row.billingStatus,
    invoiceTotalCents: result.row.invoiceTotalCents,
    invoiceCurrency: result.row.invoiceCurrency,
    stripeInvoiceIds: result.row.stripeInvoiceIds,
    stripeFeeCents: result.row.stripeFeeCents,
    internalCostCents: result.row.internalCostCents,
    conversationCount: result.row.conversationCount,
    openaiCostCents: result.row.openaiCostCents,
    twilioCostCents: result.row.twilioCostCents,
    infraCostCents: result.row.infraCostCents,
    estimateRowCount: result.row.estimateRowCount,
    marginCents: result.row.marginCents,
    marginPercent: result.row.marginPercent,
    alertTriggered: newAlertTriggered,
    alertReason: result.row.alertReason,
    computedMethod: source,
  });

  return { rowUpserted: true, alertSent };
}

/**
 * Run one full reconciliation cycle across all active tenants × the
 * relevant months (bootstrap on first run, otherwise current + prior).
 * Exported so the manual-trigger admin endpoint can call this directly.
 *
 * Cycle-in-flight guard means a manual trigger fired mid-cron does
 * not double-process; the manual call returns a synthetic skipped
 * summary instead.
 */
export async function runReconciliationCycle(
  source: 'cron' | 'manual' = 'cron',
): Promise<ReconciliationCycleSummary> {
  if (cycleInFlight) {
    logger.warn('Reconciliation cycle already in flight — skipping', { source });
    return {
      tenantsProcessed: 0,
      monthsProcessed: 0,
      rowsUpserted: 0,
      alertsSent: 0,
      errors: 0,
      durationMs: 0,
      bootstrap: false,
    };
  }
  cycleInFlight = true;

  const startedAt = Date.now();
  let rowsUpserted = 0;
  let alertsSent = 0;
  let errors = 0;
  let tenantsProcessed = 0;
  let bootstrap = false;

  try {
    bootstrap = await isBootstrapNeeded();
    const months: MonthBounds[] = bootstrap
      ? rollingMonths(BOOTSTRAP_LOOKBACK_MONTHS)
      : [priorMonth(), currentMonth()];

    const tenants = await listActiveTenants();
    tenantsProcessed = tenants.length;

    logger.info('Reconciliation cycle starting', {
      source,
      bootstrap,
      tenantCount: tenants.length,
      monthCount: months.length,
    });

    for (const tenant of tenants) {
      for (const bounds of months) {
        try {
          const r = await reconcileOne(tenant.id, tenant.name, bounds, source);
          if (r.rowUpserted) rowsUpserted++;
          if (r.alertSent) alertsSent++;
        } catch (err) {
          errors++;
          logger.error('reconcileOne failed', {
            tenantId: tenant.id,
            periodStart: bounds.start.toISOString(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info('Reconciliation cycle complete', {
      source,
      bootstrap,
      tenantsProcessed,
      monthsProcessed: months.length,
      rowsUpserted,
      alertsSent,
      errors,
      durationMs,
    });

    return {
      tenantsProcessed,
      monthsProcessed: months.length,
      rowsUpserted,
      alertsSent,
      errors,
      durationMs,
      bootstrap,
    };
  } finally {
    cycleInFlight = false;
  }
}

// -----------------------------------------------------------------------
// Scheduler lifecycle (matches the pattern of the other six schedulers)
// -----------------------------------------------------------------------

export function startBillingReconciliationScheduler(
  intervalMs: number = parseIntervalEnv(),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runReconciliationCycle('cron').catch((err) => {
      logger.error('Initial reconciliation cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runReconciliationCycle('cron').catch((err) => {
      logger.error('Reconciliation cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Billing reconciliation scheduler started', { intervalMs });
}

export function stopBillingReconciliationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Billing reconciliation scheduler stopped');
  }
}

// Exported for unit tests (no-op surface).
export const _testing = {
  currentMonth,
  priorMonth,
  rollingMonths,
};
