/**
 * Unit tests for the cost-reconciliation service (cost audit fix #5,
 * commit 2/4).
 *
 * Pure-logic tests against in-memory mocks for the three injected
 * adapters. No live Stripe round-trip; no Postgres connection. The
 * production scheduler in commit 3 wires the real adapters.
 */

import { describe, it, expect } from 'vitest';
import {
  computeReconciliation,
  determineBillingStatus,
  determineAlertReason,
  estimateStripeFeeCents,
  alertSeverity,
  shouldSendAlert,
  HEALTHY_FLOOR_PERCENT,
  UNBILLED_COST_CEILING_CENTS,
  type ReconciliationAdapters,
  type TenantBillingContext,
  type StripeInvoiceLite,
  type ConversationCostsAggregate,
} from '../../platform/billing/reconciliation';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FEB_2026_START = new Date('2026-02-01T00:00:00Z');
const FEB_2026_END = new Date('2026-03-01T00:00:00Z');

function ctx(over: Partial<TenantBillingContext> = {}): TenantBillingContext {
  return {
    isDemoTenant: false,
    hasSubscription: true,
    subscriptionStatus: 'active',
    stripeCustomerId: 'cus_test',
    ...over,
  };
}

function inv(over: Partial<StripeInvoiceLite> = {}): StripeInvoiceLite {
  return {
    id: 'in_test',
    status: 'paid',
    amount_paid: 10000,
    currency: 'usd',
    ...over,
  };
}

function costs(over: Partial<ConversationCostsAggregate> = {}): ConversationCostsAggregate {
  return {
    internalCostCents: 5000,
    conversationCount: 100,
    openaiCostCents: 4000,
    twilioCostCents: 800,
    infraCostCents: 200,
    estimateRowCount: 0,
    ...over,
  };
}

function mockAdapters(overrides: {
  context?: TenantBillingContext;
  invoices?: StripeInvoiceLite[];
  costs?: ConversationCostsAggregate;
} = {}): ReconciliationAdapters {
  return {
    fetchTenantBillingContext: async () => overrides.context ?? ctx(),
    fetchStripeInvoicesInPeriod: async () => overrides.invoices ?? [inv()],
    fetchConversationCostsAggregate: async () => overrides.costs ?? costs(),
  };
}

// ---------------------------------------------------------------------------
// determineBillingStatus
// ---------------------------------------------------------------------------

describe('determineBillingStatus', () => {
  it('returns demo when isDemoTenant', () => {
    expect(determineBillingStatus(ctx({ isDemoTenant: true }), [])).toBe('demo');
  });

  it('returns free_tier when no subscription', () => {
    expect(determineBillingStatus(ctx({ hasSubscription: false, subscriptionStatus: null }), [])).toBe('free_tier');
  });

  it('returns trialing when status=trialing and no invoices', () => {
    expect(determineBillingStatus(ctx({ subscriptionStatus: 'trialing' }), [])).toBe('trialing');
  });

  it('returns invoiced_paid when any paid invoice exists', () => {
    expect(determineBillingStatus(ctx(), [inv({ status: 'paid' })])).toBe('invoiced_paid');
  });

  it('returns invoiced_paid when paid + failed both exist (paid wins)', () => {
    expect(
      determineBillingStatus(ctx(), [
        inv({ id: 'in_1', status: 'paid' }),
        inv({ id: 'in_2', status: 'uncollectible' }),
      ]),
    ).toBe('invoiced_paid');
  });

  it('returns invoiced_failed for void/uncollectible only', () => {
    expect(determineBillingStatus(ctx(), [inv({ status: 'uncollectible' })])).toBe('invoiced_failed');
    expect(determineBillingStatus(ctx(), [inv({ status: 'void' })])).toBe('invoiced_failed');
  });

  it('returns invoiced_open for open-only invoices', () => {
    expect(determineBillingStatus(ctx(), [inv({ status: 'open' })])).toBe('invoiced_open');
  });

  it('returns cancelled_no_invoice when sub is cancelled and no invoices', () => {
    expect(determineBillingStatus(ctx({ subscriptionStatus: 'cancelled' }), [])).toBe('cancelled_no_invoice');
  });

  it('returns invoiced_open as default when active sub has no invoices yet', () => {
    expect(determineBillingStatus(ctx(), [])).toBe('invoiced_open');
  });
});

// ---------------------------------------------------------------------------
// estimateStripeFeeCents
// ---------------------------------------------------------------------------

describe('estimateStripeFeeCents', () => {
  it('charges nothing for unpaid invoices', () => {
    expect(estimateStripeFeeCents([inv({ status: 'open' })])).toBe(0);
    expect(estimateStripeFeeCents([inv({ status: 'uncollectible' })])).toBe(0);
  });

  it('applies 2.9% + 30¢ per paid invoice', () => {
    // $100 invoice: 2.9% = $2.90 = 290¢, + 30¢ = 320¢
    expect(estimateStripeFeeCents([inv({ status: 'paid', amount_paid: 10000 })])).toBe(320);
  });

  it('compounds per-invoice (two invoices, two flat fees)', () => {
    const result = estimateStripeFeeCents([
      inv({ id: 'a', status: 'paid', amount_paid: 10000 }),
      inv({ id: 'b', status: 'paid', amount_paid: 10000 }),
    ]);
    // Each: 290 + 30 = 320. Total = 640.
    expect(result).toBe(640);
  });
});

// ---------------------------------------------------------------------------
// determineAlertReason
// ---------------------------------------------------------------------------

describe('determineAlertReason', () => {
  it('losing_money fires when any invoiced_* tenant has negative margin', () => {
    expect(determineAlertReason('invoiced_paid', -100, -1, 10000)).toBe('losing_money');
    expect(determineAlertReason('invoiced_open', -100, null, 10000)).toBe('losing_money');
    expect(determineAlertReason('invoiced_failed', -100, null, 10000)).toBe('losing_money');
  });

  it('unbilled_cost_threshold fires when non-paid tenant exceeds ceiling', () => {
    const cost = UNBILLED_COST_CEILING_CENTS + 1;
    expect(determineAlertReason('demo', -cost, null, cost)).toBe('unbilled_cost_threshold');
    expect(determineAlertReason('trialing', -cost, null, cost)).toBe('unbilled_cost_threshold');
    expect(determineAlertReason('free_tier', -cost, null, cost)).toBe('unbilled_cost_threshold');
    expect(determineAlertReason('cancelled_no_invoice', -cost, null, cost)).toBe('unbilled_cost_threshold');
  });

  it('unbilled_cost_threshold does not fire at exactly the ceiling', () => {
    expect(determineAlertReason('demo', 0, null, UNBILLED_COST_CEILING_CENTS)).toBe(null);
  });

  it('below_healthy_floor fires for invoiced_paid below the percent floor', () => {
    expect(determineAlertReason('invoiced_paid', 100, HEALTHY_FLOOR_PERCENT - 1, 100)).toBe('below_healthy_floor');
  });

  it('below_healthy_floor does not fire for invoiced_open (would be premature)', () => {
    expect(determineAlertReason('invoiced_open', 100, HEALTHY_FLOOR_PERCENT - 1, 100)).toBe(null);
  });

  it('returns null when nothing tripped', () => {
    expect(determineAlertReason('invoiced_paid', 5000, 50, 5000)).toBe(null);
    expect(determineAlertReason('demo', 0, null, 100)).toBe(null);
  });

  it('losing_money takes precedence over below_healthy_floor', () => {
    // Negative margin AND below floor — should be losing_money
    expect(determineAlertReason('invoiced_paid', -100, -1, 10000)).toBe('losing_money');
  });
});

// ---------------------------------------------------------------------------
// alertSeverity + shouldSendAlert
// ---------------------------------------------------------------------------

describe('alertSeverity precedence', () => {
  it('ranks losing_money > unbilled > below_healthy > null', () => {
    expect(alertSeverity('losing_money')).toBeGreaterThan(alertSeverity('unbilled_cost_threshold'));
    expect(alertSeverity('unbilled_cost_threshold')).toBeGreaterThan(alertSeverity('below_healthy_floor'));
    expect(alertSeverity('below_healthy_floor')).toBeGreaterThan(alertSeverity(null));
  });
});

describe('shouldSendAlert', () => {
  it('does not send when no current alert', () => {
    expect(shouldSendAlert(null, false, null).shouldSend).toBe(false);
    expect(shouldSendAlert(null, true, 'losing_money').shouldSend).toBe(false);
  });

  it('sends the first time an alert appears', () => {
    const r = shouldSendAlert('below_healthy_floor', false, null);
    expect(r.shouldSend).toBe(true);
    expect(r.reason).toBe('first_alert');
  });

  it('skips when already-triggered at the same severity', () => {
    const r = shouldSendAlert('below_healthy_floor', true, 'below_healthy_floor');
    expect(r.shouldSend).toBe(false);
    expect(r.reason).toBe('severity_unchanged');
  });

  it('sends on escalation (below_healthy → losing_money)', () => {
    const r = shouldSendAlert('losing_money', true, 'below_healthy_floor');
    expect(r.shouldSend).toBe(true);
    expect(r.reason).toBe('escalation');
  });

  it('skips on de-escalation (losing_money → below_healthy)', () => {
    const r = shouldSendAlert('below_healthy_floor', true, 'losing_money');
    expect(r.shouldSend).toBe(false);
    expect(r.reason).toBe('severity_unchanged');
  });
});

// ---------------------------------------------------------------------------
// computeReconciliation — end-to-end integration with mock adapters
// ---------------------------------------------------------------------------

describe('computeReconciliation', () => {
  it('produces a healthy paid-tenant row with no alert', async () => {
    // $100 revenue, $50 cost, $3.20 stripe fee → margin $46.80 (46.8%)
    const result = await computeReconciliation(
      { tenantId: 't_healthy', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({}),
    );
    expect(result.row.billingStatus).toBe('invoiced_paid');
    expect(result.row.invoiceTotalCents).toBe(10000);
    expect(result.row.stripeFeeCents).toBe(320);
    expect(result.row.internalCostCents).toBe(5000);
    expect(result.row.marginCents).toBe(10000 - 320 - 5000);
    expect(result.row.marginPercent).toBeGreaterThan(HEALTHY_FLOOR_PERCENT);
    expect(result.row.alertReason).toBe(null);
  });

  it('detects losing_money when cost outpaces revenue', async () => {
    const result = await computeReconciliation(
      { tenantId: 't_loss', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({
        invoices: [inv({ amount_paid: 5000 })],
        costs: costs({ internalCostCents: 10000 }),
      }),
    );
    expect(result.row.alertReason).toBe('losing_money');
    expect(result.row.marginCents).toBeLessThan(0);
  });

  it('detects below_healthy_floor on thin paid margin', async () => {
    // 10% margin: revenue $100, fee $3.20, cost $86.80 → margin $10 (10%)
    const result = await computeReconciliation(
      { tenantId: 't_thin', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({
        invoices: [inv({ amount_paid: 10000 })],
        costs: costs({ internalCostCents: 8680 }),
      }),
    );
    expect(result.row.alertReason).toBe('below_healthy_floor');
  });

  it('detects unbilled_cost_threshold on a demo tenant over the ceiling', async () => {
    const result = await computeReconciliation(
      { tenantId: 'demo', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({
        context: ctx({ isDemoTenant: true, hasSubscription: false, stripeCustomerId: null }),
        invoices: [],
        costs: costs({ internalCostCents: UNBILLED_COST_CEILING_CENTS + 100 }),
      }),
    );
    expect(result.row.billingStatus).toBe('demo');
    expect(result.row.alertReason).toBe('unbilled_cost_threshold');
    expect(result.row.invoiceTotalCents).toBe(0);
    expect(result.row.marginPercent).toBe(null);
  });

  it('does not fetch invoices for the demo tenant', async () => {
    let invoiceFetchCalls = 0;
    await computeReconciliation(
      { tenantId: 'demo', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      {
        fetchTenantBillingContext: async () =>
          ctx({ isDemoTenant: true, hasSubscription: false, stripeCustomerId: null }),
        fetchStripeInvoicesInPeriod: async () => {
          invoiceFetchCalls++;
          return [];
        },
        fetchConversationCostsAggregate: async () => costs(),
      },
    );
    expect(invoiceFetchCalls).toBe(0);
  });

  it('captures all stripe_invoice_ids in the period', async () => {
    const result = await computeReconciliation(
      { tenantId: 't_multi', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({
        invoices: [
          inv({ id: 'in_aaa', status: 'paid', amount_paid: 5000 }),
          inv({ id: 'in_bbb', status: 'paid', amount_paid: 5000 }),
        ],
      }),
    );
    expect(result.row.stripeInvoiceIds).toEqual(['in_aaa', 'in_bbb']);
    expect(result.row.invoiceTotalCents).toBe(10000);
  });

  it('passes through previousAlertTriggered for the dispatcher', async () => {
    const result = await computeReconciliation(
      {
        tenantId: 't_prev',
        periodStart: FEB_2026_START,
        periodEnd: FEB_2026_END,
        previousAlertTriggered: true,
        previousAlertReason: 'below_healthy_floor',
      },
      mockAdapters({}),
    );
    expect(result.previousAlertTriggered).toBe(true);
    expect(result.previousAlertReason).toBe('below_healthy_floor');
  });

  it('uppercases the invoice currency code', async () => {
    const result = await computeReconciliation(
      { tenantId: 't_currency', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({ invoices: [inv({ currency: 'eur' })] }),
    );
    expect(result.row.invoiceCurrency).toBe('EUR');
  });

  it('rounds margin_percent to 2 decimal places', async () => {
    // revenue 999, fee 0 (open invoice → no fee), cost 0 → margin 999 / 999 = 100%
    // Use a paid invoice so fee applies, exercise the rounding
    const result = await computeReconciliation(
      { tenantId: 't_round', periodStart: FEB_2026_START, periodEnd: FEB_2026_END },
      mockAdapters({
        invoices: [inv({ amount_paid: 7777 })],
        costs: costs({ internalCostCents: 1234 }),
      }),
    );
    // Should be a number with at most 2 decimal places
    if (result.row.marginPercent !== null) {
      const decimals = result.row.marginPercent.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(2);
    }
  });
});
