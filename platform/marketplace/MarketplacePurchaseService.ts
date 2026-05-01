import { randomUUID } from 'node:crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import type { UpgradeDiscount } from '../billing/stripe/effectiveRate';

const logger = createLogger('MARKETPLACE_PURCHASES');

/**
 * Compact view of a coupon applied to a marketplace purchase, mirrored
 * from the discount badge metadata that `handleInvoiceFinalized` stamps
 * on the underlying Stripe invoice. Sent to the in-app purchase history
 * view so it can render the same "Discount applied" badge that lands on
 * the receipt PDF (Task #1351).
 */
export interface PurchaseDiscountSummary {
  couponId: string | null;
  name: string | null;
  promotionCode: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
}

export interface PurchaseHistoryRow {
  id: string;
  templateId: string;
  templateName: string | null;
  amountCents: number;
  currency: string;
  priceModel: string;
  status: string;
  subscriptionStatus: string | null;
  createdAt: string;
  completedAt: string | null;
  discount: PurchaseDiscountSummary | null;
}

export interface PurchaseInput {
  tenantId: TenantId;
  userId: string;
  templateId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PurchaseRecord {
  id: string;
  tenantId: string;
  userId: string;
  templateId: string;
  amountCents: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export async function createMarketplacePurchase(input: PurchaseInput): Promise<{
  success: boolean;
  error?: string;
  checkoutUrl?: string;
  purchaseId?: string;
  isFree?: boolean;
}> {
  const { tenantId, userId, templateId } = input;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: templateRows } = await client.query(
      `SELECT id, display_name, price_model, price_cents, stripe_price_id
       FROM template_registry WHERE id = $1 AND status = 'active'`,
      [templateId],
    );

    if (templateRows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Template not found or not active' };
    }

    const template = templateRows[0];
    const priceModel = template.price_model as string;
    const priceCents = template.price_cents as number;

    if (priceModel === 'free' || priceCents === 0) {
      await client.query('COMMIT');
      return { success: true, isFree: true };
    }

    const { rows: existingPurchase } = await client.query(
      `SELECT id FROM marketplace_purchases
       WHERE tenant_id = $1 AND template_id = $2 AND status = 'completed'`,
      [tenantId, templateId],
    );

    if (existingPurchase.length > 0 && priceModel === 'one_time') {
      await client.query('COMMIT');
      return { success: true, isFree: true, purchaseId: existingPurchase[0].id as string };
    }

    const { rows: purchaseRows } = await client.query(
      `INSERT INTO marketplace_purchases (tenant_id, user_id, template_id, amount_cents, price_model, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [tenantId, userId, templateId, priceCents, priceModel],
    );

    const purchaseId = purchaseRows[0].id as string;

    let checkoutUrl = '';
    try {
      const { getStripeClient } = await import('../billing/stripe/client');
      const { loadActiveCustomerDiscount } = await import('../billing/stripe/effectiveRate');
      const stripe = getStripeClient();

      const { rows: subRows } = await client.query(
        `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const customerId = subRows[0]?.stripe_customer_id as string | undefined;

      // Forward the buyer's existing customer-level Stripe discount (if
      // any) so the marketplace hosted page shows the same coupon the
      // tenant already sees on their subscription invoices. Mirrors the
      // subscription Checkout path in
      // `platform/billing/stripe/checkout.ts`. Stripe rejects sessions
      // that combine `discounts` with `allow_promotion_codes`, so the
      // session-shape branch below drops `allow_promotion_codes` when a
      // discount is being forwarded.
      let sessionDiscounts: Array<{ coupon?: string; promotion_code?: string }> | undefined;
      if (customerId) {
        const customerDiscount = await loadActiveCustomerDiscount(
          stripe,
          customerId,
          { tenantId, surface: 'marketplace_checkout_session' },
        );
        if (customerDiscount?.promotionCodeId) {
          sessionDiscounts = [{ promotion_code: customerDiscount.promotionCodeId }];
        } else if (customerDiscount?.couponId) {
          sessionDiscounts = [{ coupon: customerDiscount.couponId }];
        }
      }

      const allowedOrigin = process.env.APP_URL
        ? process.env.APP_URL
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}`
          : 'http://localhost:5000';
      const safeSuccessUrl = input.successUrl.startsWith(allowedOrigin)
        ? input.successUrl
        : `${allowedOrigin}/marketplace?purchase=success`;
      const safeCancelUrl = input.cancelUrl.startsWith(allowedOrigin)
        ? input.cancelUrl
        : `${allowedOrigin}/marketplace?purchase=cancelled`;

      const isSubscription = priceModel === 'monthly_subscription' || priceModel === 'usage_based';
      const sessionParams: Record<string, unknown> = {
        mode: isSubscription ? 'subscription' : 'payment',
        payment_method_types: ['card'],
        success_url: safeSuccessUrl,
        cancel_url: safeCancelUrl,
        metadata: { tenantId, templateId, purchaseId, type: 'marketplace_purchase' },
      };

      if (sessionDiscounts) {
        // Stripe rejects sessions that combine `discounts` with
        // `allow_promotion_codes`, so we omit the manual-entry box
        // when forwarding an existing discount.
        sessionParams.discounts = sessionDiscounts;
      } else {
        // Let buyers redeem a Stripe-managed promo code at the marketplace
        // checkout. Combined with the `invoice_creation` block below, this
        // is what makes the coupon-aware "Discount applied" badge from the
        // `invoice.finalized` webhook (see Task #1311) actually fire on
        // one-off marketplace purchases — without an invoice, Stripe never
        // emits the event the badge stamper hooks.
        sessionParams.allow_promotion_codes = true;
      }

      // For one-off marketplace purchases (mode: 'payment') Stripe does
      // NOT create an invoice by default — only a Charge + receipt email.
      // Enable `invoice_creation` so the same `invoice.finalized` webhook
      // that powers the discount badge on subscription invoices also
      // fires for marketplace add-on purchases. Mirror the session
      // metadata onto the invoice so Finance/Support can trace the
      // receipt PDF back to the originating marketplace purchase row
      // without joining through the Charge.
      if (!isSubscription) {
        sessionParams.invoice_creation = {
          enabled: true,
          invoice_data: {
            metadata: {
              tenantId,
              templateId,
              purchaseId,
              type: 'marketplace_purchase',
            },
          },
        };
      }

      if (customerId) {
        sessionParams.customer = customerId;
      }

      if (template.stripe_price_id) {
        sessionParams.line_items = [{ price: template.stripe_price_id, quantity: 1 }];
      } else if (priceModel === 'usage_based') {
        sessionParams.line_items = [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${template.display_name} - Marketplace (Usage)` },
            unit_amount: priceCents,
            recurring: { interval: 'month', usage_type: 'metered' },
          },
        }];
      } else {
        sessionParams.line_items = [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${template.display_name} - Marketplace` },
            unit_amount: priceCents,
            ...(priceModel === 'monthly_subscription' ? { recurring: { interval: 'month' } } : {}),
          },
          quantity: 1,
        }];
      }

      const session = await stripe.checkout.sessions.create(sessionParams as Parameters<typeof stripe.checkout.sessions.create>[0]);

      await client.query(
        `UPDATE marketplace_purchases SET stripe_checkout_session_id = $1 WHERE id = $2`,
        [session.id, purchaseId],
      );

      checkoutUrl = session.url!;
    } catch (stripeErr) {
      logger.warn('Stripe checkout creation failed, storing purchase as pending', {
        tenantId, templateId, error: String(stripeErr),
      });
      const fallbackOrigin = process.env.APP_URL
        ? process.env.APP_URL
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}`
          : 'http://localhost:5000';
      checkoutUrl = `${fallbackOrigin}/marketplace?purchase_pending=true`;
    }

    await client.query('COMMIT');

    logger.info('Marketplace purchase initiated', { tenantId, templateId, purchaseId, priceCents });
    return { success: true, checkoutUrl, purchaseId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to create marketplace purchase', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Failed to initiate purchase' };
  } finally {
    client.release();
  }
}

export async function completePurchase(
  purchaseId: string,
  stripePaymentId: string,
  stripeSubscriptionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE marketplace_purchases
       SET status = 'completed', stripe_payment_id = $1, completed_at = NOW(),
           stripe_subscription_id = $3,
           subscription_status = CASE WHEN $3 IS NOT NULL THEN 'active' ELSE NULL END
       WHERE id = $2 AND status = 'pending'
       RETURNING tenant_id, template_id, amount_cents`,
      [stripePaymentId, purchaseId, stripeSubscriptionId ?? null],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Purchase not found or already completed' };
    }

    const purchase = rows[0];
    const templateId = purchase.template_id as string;
    const amountCents = purchase.amount_cents as number;

    const { rows: templateRows } = await client.query(
      `SELECT developer_id, developer_revenue_share_pct FROM template_registry WHERE id = $1`,
      [templateId],
    );

    const developerId = templateRows[0]?.developer_id as string | null;
    const sharePercent = parseFloat(templateRows[0]?.developer_revenue_share_pct as string ?? '70');
    const developerShare = Math.round(amountCents * (sharePercent / 100));
    const platformFee = amountCents - developerShare;

    await client.query(
      `INSERT INTO marketplace_revenue_events
         (purchase_id, template_id, developer_id, gross_amount_cents, platform_fee_cents, developer_share_cents, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'sale')`,
      [purchaseId, templateId, developerId, amountCents, platformFee, developerShare],
    );

    await client.query('COMMIT');

    logger.info('Marketplace purchase completed', { purchaseId, templateId, amountCents });
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to complete purchase', { purchaseId, error: String(err) });
    return { success: false, error: 'Failed to complete purchase' };
  } finally {
    client.release();
  }
}

/**
 * Persist the coupon-aware discount badge fields on the matching
 * `marketplace_purchases` row. Called from `handleInvoiceFinalized`
 * once it resolves a discount on a marketplace_purchase invoice so the
 * in-app purchase history view can render the same badge that lands on
 * the receipt PDF without an extra Stripe round-trip per row.
 *
 * Uses raw `getPlatformPool().query` (no `withTenantContext`) on
 * purpose: the webhook runs without a tenant session, and the
 * `purchaseId` is already a globally-unique UUID we just looked up via
 * the invoice's own metadata stamped at session creation. Idempotent —
 * later finalize retries just rewrite the same fields.
 */
export async function applyInvoiceDiscountToPurchase(
  purchaseId: string,
  discount: UpgradeDiscount,
): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE marketplace_purchases
         SET discount_badge_applied = TRUE,
             discount_coupon_id = $2,
             discount_promotion_code = $3,
             discount_name = $4,
             discount_percent_off = $5,
             discount_amount_off_cents = $6,
             discount_currency = $7
       WHERE id = $1`,
      [
        purchaseId,
        discount.couponId,
        discount.promotionCode,
        discount.name,
        discount.percentOff,
        discount.amountOffCents,
        discount.currency,
      ],
    );
  } catch (err) {
    logger.warn('Failed to persist discount badge on marketplace purchase', {
      purchaseId, error: String(err),
    });
  }
}

/**
 * Return the tenant's marketplace purchases (newest first) with the
 * coupon-aware discount badge fields the in-app history view renders.
 * Includes `pending` rows so a buyer who just kicked off checkout can
 * see the in-flight order; the UI greys those out.
 */
export async function listPurchasesForTenant(
  tenantId: TenantId,
): Promise<PurchaseHistoryRow[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT mp.id,
              mp.template_id,
              mp.amount_cents,
              COALESCE(mp.currency, 'usd') AS currency,
              mp.price_model,
              mp.status,
              mp.subscription_status,
              mp.created_at,
              mp.completed_at,
              mp.discount_badge_applied,
              mp.discount_coupon_id,
              mp.discount_promotion_code,
              mp.discount_name,
              mp.discount_percent_off,
              mp.discount_amount_off_cents,
              mp.discount_currency,
              tr.display_name AS template_name
         FROM marketplace_purchases mp
         LEFT JOIN template_registry tr ON tr.id = mp.template_id
        WHERE mp.tenant_id = $1
        ORDER BY COALESCE(mp.completed_at, mp.created_at) DESC`,
      [tenantId],
    );

    return rows.map((r) => {
      const badged = r.discount_badge_applied === true;
      const percentOff = r.discount_percent_off != null
        ? Number(r.discount_percent_off)
        : null;
      const amountOffCents = r.discount_amount_off_cents != null
        ? Number(r.discount_amount_off_cents)
        : null;
      const discount: PurchaseDiscountSummary | null = badged
        ? {
            couponId: (r.discount_coupon_id as string | null) ?? null,
            name: (r.discount_name as string | null) ?? null,
            promotionCode: (r.discount_promotion_code as string | null) ?? null,
            percentOff,
            amountOffCents,
            currency: (r.discount_currency as string | null) ?? null,
          }
        : null;
      return {
        id: r.id as string,
        templateId: r.template_id as string,
        templateName: (r.template_name as string | null) ?? null,
        amountCents: r.amount_cents as number,
        currency: (r.currency as string).toLowerCase(),
        priceModel: r.price_model as string,
        status: r.status as string,
        subscriptionStatus: (r.subscription_status as string | null) ?? null,
        createdAt: r.created_at as string,
        completedAt: (r.completed_at as string | null) ?? null,
        discount,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * One row in the per-purchase invoice sub-history surfaced under each
 * recurring marketplace subscription on the Purchases tab. Mirrors the
 * shape of `/billing/invoices` so the UI can render the same coupon
 * chip + Receipt PDF link layout — except here every renewal invoice
 * carries its own discount snapshot, so a tenant can see when a coupon
 * expired mid-subscription or a new one stacked on top for a renewal
 * (Task #1389).
 */
export interface PurchaseInvoiceRow {
  id: string;
  number: string | null;
  date: string | null;
  amountCents: number;
  currency: string;
  status: string;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
  description: string | null;
  /**
   * Every coupon Stripe applied to this specific renewal invoice. A
   * subscription invoice can stack multiple discounts (customer-level
   * promo + invoice-level one-off), so the list is rendered chip-by-chip
   * the same way `Billing.tsx` already renders platform invoice rows.
   */
  discounts: PurchaseDiscountSummary[];
}

/**
 * Fetch the renewal invoices Stripe has issued for a single recurring
 * marketplace purchase, each enriched with the coupon-aware discount
 * summary the Purchases tab renders inline. Scoped to the caller's
 * tenant — the purchase row must belong to `tenantId` AND carry a
 * `stripe_subscription_id`. One-off purchases (no subscription id)
 * return `[]` so the route layer can short-circuit before talking to
 * Stripe.
 *
 * Returns `null` when the purchase id doesn't match anything in the
 * tenant's history at all, so the route can distinguish "not found"
 * (404) from "found, but no invoices yet" ([]).
 */
export async function listInvoicesForPurchase(
  tenantId: TenantId,
  purchaseId: string,
): Promise<PurchaseInvoiceRow[] | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  let stripeSubscriptionId: string | null = null;
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT stripe_subscription_id, price_model
         FROM marketplace_purchases
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [purchaseId, tenantId],
    );
    if (rows.length === 0) {
      return null;
    }
    stripeSubscriptionId = (rows[0].stripe_subscription_id as string | null) ?? null;
  } finally {
    client.release();
  }

  // One-off purchases never have a Stripe subscription id, so there's
  // no renewal history to surface — bail before touching Stripe.
  if (!stripeSubscriptionId) {
    return [];
  }

  try {
    const { getStripeClient } = await import('../billing/stripe/client');
    const stripe = getStripeClient();

    // Walk every Stripe invoice tied to this subscription using the
    // standard `has_more` / `starting_after` cursor (mirrors the
    // pagination loop in `platform/billing/stripe/portalConfigCleanup.ts`).
    // The Done criteria require one sub-row per Stripe invoice, so a
    // hard `limit: 24` would silently truncate buyers on a long-running
    // monthly add-on. `MAX_HISTORICAL_INVOICES` only exists as a
    // belt-and-suspenders guard against a runaway loop — at one
    // invoice per week that's still ~9 years of history, well past
    // any reasonable subscription lifetime.
    const PAGE_SIZE = 100;
    const MAX_HISTORICAL_INVOICES = 500;
    const allInvoices: Array<Record<string, unknown>> = [];
    let startingAfter: string | undefined;
    for (;;) {
      const list = await stripe.invoices.list({
        subscription: stripeSubscriptionId,
        limit: PAGE_SIZE,
        expand: ['data.discounts', 'data.discounts.promotion_code'],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const inv of list.data) {
        allInvoices.push(inv as unknown as Record<string, unknown>);
        if (allInvoices.length >= MAX_HISTORICAL_INVOICES) break;
      }
      if (allInvoices.length >= MAX_HISTORICAL_INVOICES) {
        logger.warn('Marketplace purchase invoice history hit safety cap', {
          tenantId, purchaseId, cap: MAX_HISTORICAL_INVOICES,
        });
        break;
      }
      if (!list.has_more || list.data.length === 0) break;
      const lastId = list.data[list.data.length - 1]?.id;
      if (!lastId || lastId === startingAfter) break;
      startingAfter = lastId;
    }

    return allInvoices.map((inv) => {
      const discounts: PurchaseDiscountSummary[] = [];
      const rawDiscounts = ((inv as { discounts?: Array<unknown> | null }).discounts ?? []) as Array<unknown>;
      for (const raw of rawDiscounts) {
        if (typeof raw !== 'object' || raw === null) continue;
        const normalized = normalizeHistoricalInvoiceDiscount(
          raw as DiscountLikeForHistory,
        );
        if (normalized) discounts.push(normalized);
      }
      // Mirrors the `/billing/invoices` fallback: legacy invoices that
      // Stripe never re-expanded with the new `discounts` array still
      // expose `total_discount_amounts` when at least one discount was
      // applied. Surface a placeholder chip so the row doesn't silently
      // hide a renewal where the coupon ran but the metadata is sparse.
      const totalDiscountAmounts = (inv as { total_discount_amounts?: unknown[] | null }).total_discount_amounts;
      if (
        discounts.length === 0
        && Array.isArray(totalDiscountAmounts)
        && totalDiscountAmounts.length > 0
      ) {
        discounts.push({
          couponId: null,
          name: null,
          promotionCode: null,
          percentOff: null,
          amountOffCents: null,
          currency: ((inv as { currency?: string | null }).currency ?? null)?.toLowerCase() ?? null,
        });
      }

      const status = (inv as { status?: string | null }).status ?? 'unknown';
      const amountPaid = (inv as { amount_paid?: number | null }).amount_paid ?? null;
      const amountDue = (inv as { amount_due?: number | null }).amount_due ?? null;
      const total = (inv as { total?: number | null }).total ?? null;
      const amountCents = status === 'paid'
        ? (amountPaid ?? total ?? 0)
        : (amountDue ?? total ?? 0);
      const created = (inv as { created?: number | null }).created ?? null;
      const lines = (inv as { lines?: { data?: Array<{ description?: string | null }> } | null }).lines;

      return {
        id: (inv as { id?: string }).id as string,
        number: ((inv as { number?: string | null }).number) ?? null,
        date: created ? new Date(created * 1000).toISOString() : null,
        amountCents,
        currency: (((inv as { currency?: string | null }).currency) ?? 'usd').toLowerCase(),
        status,
        invoicePdf: ((inv as { invoice_pdf?: string | null }).invoice_pdf) ?? null,
        hostedInvoiceUrl: ((inv as { hosted_invoice_url?: string | null }).hosted_invoice_url) ?? null,
        description: ((inv as { description?: string | null }).description)
          ?? (lines?.data?.[0]?.description ?? null),
        discounts,
      };
    });
  } catch (err) {
    logger.error('Failed to list Stripe invoices for marketplace purchase', {
      tenantId, purchaseId, error: String(err),
    });
    throw err;
  }
}

interface CouponLikeForHistory {
  id?: string | null;
  name?: string | null;
  percent_off?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  // `valid` and `discount.end` are intentionally NOT honored by the
  // historical normalizer — see `normalizeHistoricalInvoiceDiscount`.
}

interface PromotionCodeLikeForHistory {
  id?: string | null;
  code?: string | null;
}

interface DiscountSourceLikeForHistory {
  coupon?: string | CouponLikeForHistory | null;
  promotion_code?: string | PromotionCodeLikeForHistory | null;
}

interface DiscountLikeForHistory {
  coupon?: CouponLikeForHistory | null;
  promotion_code?: string | PromotionCodeLikeForHistory | null;
  source?: DiscountSourceLikeForHistory | null;
}

/**
 * Coupon-aware normalizer for historical invoice rows surfaced under a
 * recurring marketplace purchase's expand-able sub-history.
 *
 * Why a local copy instead of `effectiveRate.normalizeDiscount`:
 * `normalizeDiscount` is designed for *active* surfaces (upgrade
 * preview, current subscription panel, Checkout sessions) and
 * intentionally suppresses any discount whose `end` is in the past or
 * whose underlying coupon has been invalidated (`valid === false`). For
 * an immutable invoice that *did* receive that coupon at the time it
 * was finalized, suppressing the badge would hide exactly the
 * scenario this task exists to surface — a coupon expiring
 * mid-subscription. Stripe stores the discount snapshot on the
 * historical invoice for a reason; the renewal-history view honors
 * that snapshot regardless of whether the coupon is still redeemable
 * today (Task #1389).
 */
function normalizeHistoricalInvoiceDiscount(
  discount: DiscountLikeForHistory | null | undefined,
): PurchaseDiscountSummary | null {
  if (!discount) return null;
  let coupon: CouponLikeForHistory | null | undefined = discount.coupon;
  if (!coupon && discount.source) {
    const sourceCoupon = discount.source.coupon;
    if (sourceCoupon && typeof sourceCoupon === 'object') {
      coupon = sourceCoupon;
    }
  }
  if (!coupon) return null;
  const percentOff =
    coupon.percent_off != null && Number.isFinite(coupon.percent_off)
      ? coupon.percent_off
      : null;
  const amountOffCents =
    coupon.amount_off != null && Number.isFinite(coupon.amount_off)
      ? coupon.amount_off
      : null;
  // Both null = pure-metadata coupon = no actual savings to surface.
  // Even on the historical view we don't render an empty chip.
  if (percentOff == null && amountOffCents == null) return null;

  let promotionCode: string | null = null;
  const promo = discount.promotion_code ?? discount.source?.promotion_code;
  if (promo && typeof promo === 'object') {
    promotionCode = promo.code ?? null;
  }

  return {
    couponId: coupon.id ?? null,
    name: coupon.name ?? null,
    promotionCode,
    percentOff,
    amountOffCents,
    currency: (coupon.currency ?? null)?.toLowerCase() ?? null,
  };
}

// Exported for unit tests so the historical-discount preservation
// behavior (an expired/invalidated coupon's chip still renders on the
// invoice it was applied to) can be pinned without round-tripping
// through Stripe.
export { normalizeHistoricalInvoiceDiscount };

export async function checkPurchaseAccess(
  tenantId: TenantId,
  templateId: string,
): Promise<{ hasAccess: boolean; purchase?: PurchaseRecord }> {
  const pool = getPlatformPool();

  const { rows: templateRows } = await pool.query(
    `SELECT price_model, price_cents FROM template_registry WHERE id = $1`,
    [templateId],
  );

  if (templateRows.length === 0) return { hasAccess: false };

  const priceModel = templateRows[0].price_model as string;
  const priceCents = templateRows[0].price_cents as number;

  if (priceModel === 'free' || priceCents === 0) {
    return { hasAccess: true };
  }

  const { rows } = await pool.query(
    `SELECT id, tenant_id, user_id, template_id, amount_cents, status, created_at, completed_at,
            stripe_subscription_id, subscription_status, price_model
     FROM marketplace_purchases
     WHERE tenant_id = $1 AND template_id = $2 AND status = 'completed'
     ORDER BY completed_at DESC
     LIMIT 1`,
    [tenantId, templateId],
  );

  if (rows.length === 0) return { hasAccess: false };

  const purchase = rows[0];
  const purchaseRecord: PurchaseRecord = {
    id: purchase.id as string,
    tenantId: purchase.tenant_id as string,
    userId: purchase.user_id as string,
    templateId: purchase.template_id as string,
    amountCents: purchase.amount_cents as number,
    status: purchase.status as string,
    createdAt: purchase.created_at as string,
    completedAt: purchase.completed_at as string | null,
  };

  if (priceModel === 'monthly_subscription' || priceModel === 'usage_based') {
    const subStatus = purchase.subscription_status as string | null;
    if (!subStatus || subStatus === 'canceled' || subStatus === 'unpaid') {
      return { hasAccess: false, purchase: purchaseRecord };
    }
  }

  return { hasAccess: true, purchase: purchaseRecord };
}

/**
 * Report marketplace add-on usage to Stripe via the Billing Meter Events API
 * (https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage).
 *
 * The legacy `subscriptionItems.createUsageRecord` endpoint has been removed
 * from the Stripe TypeScript types and is on Stripe's deprecation track, so we
 * publish a meter event instead. The `event_name` is resolved from the
 * template's `stripe_meter_event_name` column (set by the marketplace developer
 * when the template is published) with a `STRIPE_MARKETPLACE_METER_EVENT` env
 * fallback for templates provisioned before the column existed. The customer
 * is identified by `stripe_customer_id` from the tenant's primary subscription.
 *
 * Idempotency: callers that need exactly-once semantics for a given business
 * event should pass `idempotencyKey` derived from that event's stable id (e.g.
 * the tool-execution id, the call-session id, etc.). Stripe deduplicates meter
 * events by `idempotencyKey` for at least 24h. When no key is supplied we
 * generate a per-call UUID — this still protects against the Stripe SDK's own
 * automatic transport retries, but two distinct `reportUsage()` calls from the
 * route layer WILL produce two billable events (the route is just a thin
 * passthrough today; metering is the caller's responsibility).
 */
export async function reportUsage(
  tenantId: TenantId,
  templateId: string,
  quantity: number,
  options: { idempotencyKey?: string } = {},
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    return { success: false, error: 'quantity must be a positive integer' };
  }

  const pool = getPlatformPool();

  const { rows } = await pool.query(
    `SELECT mp.id AS purchase_id,
            mp.stripe_subscription_id,
            mp.subscription_status,
            tr.stripe_meter_event_name
     FROM marketplace_purchases mp
     LEFT JOIN template_registry tr ON tr.id = mp.template_id
     WHERE mp.tenant_id = $1 AND mp.template_id = $2 AND mp.status = 'completed'
       AND mp.stripe_subscription_id IS NOT NULL
     ORDER BY mp.completed_at DESC LIMIT 1`,
    [tenantId, templateId],
  );

  if (rows.length === 0 || !rows[0].stripe_subscription_id) {
    return { success: false, error: 'No active usage-based subscription found' };
  }

  const subStatus = rows[0].subscription_status as string | null;
  if (subStatus !== 'active' && subStatus !== 'past_due') {
    return { success: false, error: 'Subscription is not active' };
  }

  const purchaseId = rows[0].purchase_id as string;
  const eventName =
    (rows[0].stripe_meter_event_name as string | null) ??
    process.env.STRIPE_MARKETPLACE_METER_EVENT ??
    null;

  if (!eventName) {
    logger.error('Marketplace template missing stripe_meter_event_name and no env fallback', {
      tenantId, templateId,
    });
    return {
      success: false,
      error: 'Marketplace template is not configured for usage reporting (missing meter event name)',
    };
  }

  const { rows: customerRows } = await pool.query(
    `SELECT stripe_customer_id FROM subscriptions
     WHERE tenant_id = $1 AND stripe_customer_id IS NOT NULL
     LIMIT 1`,
    [tenantId],
  );
  const customerId = customerRows[0]?.stripe_customer_id as string | undefined;
  if (!customerId) {
    return { success: false, error: 'Tenant has no Stripe customer for usage reporting' };
  }

  try {
    const stripe = (await import('../billing/stripe/client')).getStripeClient();
    const timestamp = Math.floor(Date.now() / 1000);
    const idempotencyKey = options.idempotencyKey
      ? `mkt_${purchaseId}_${options.idempotencyKey}`
      : `mkt_${purchaseId}_${randomUUID()}`;

    await stripe.billing.meterEvents.create(
      {
        event_name: eventName,
        payload: {
          stripe_customer_id: customerId,
          value: String(quantity),
        },
        timestamp,
      },
      { idempotencyKey },
    );

    logger.info('Usage reported for marketplace subscription', {
      tenantId, templateId, quantity, eventName, purchaseId,
    });
    return { success: true };
  } catch (err) {
    logger.error('Failed to report usage', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Failed to report usage to billing provider' };
  }
}

export async function getRevenueStats(options: {
  developerId?: string;
  templateId?: string;
  days?: number;
} = {}): Promise<{
  totalRevenue: number;
  platformFees: number;
  developerPayouts: number;
  purchaseCount: number;
  recentEvents: { templateId: string; grossAmount: number; eventType: string; createdAt: string }[];
  byTemplate: { templateId: string; templateName: string; revenueCents: number; purchaseCount: number }[];
}> {
  const pool = getPlatformPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.developerId) {
    conditions.push(`developer_id = $${idx++}`);
    params.push(options.developerId);
  }
  if (options.templateId) {
    conditions.push(`template_id = $${idx++}`);
    params.push(options.templateId);
  }
  if (options.days) {
    conditions.push(`created_at >= NOW() - INTERVAL '${options.days} days'`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [statsResult, eventsResult, byTemplateResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(gross_amount_cents), 0)::int AS total_revenue,
         COALESCE(SUM(platform_fee_cents), 0)::int AS platform_fees,
         COALESCE(SUM(developer_share_cents), 0)::int AS developer_payouts,
         COUNT(*)::int AS purchase_count
       FROM marketplace_revenue_events ${where}`,
      params,
    ),
    pool.query(
      `SELECT template_id, gross_amount_cents, event_type, created_at
       FROM marketplace_revenue_events ${where}
       ORDER BY created_at DESC
       LIMIT 50`,
      params,
    ),
    pool.query(
      `SELECT
         e.template_id,
         COALESCE(tr.display_name, 'Unknown') AS template_name,
         COALESCE(SUM(e.gross_amount_cents), 0)::int AS revenue_cents,
         COUNT(*)::int AS purchase_count
       FROM marketplace_revenue_events e
       LEFT JOIN template_registry tr ON tr.id = e.template_id
       ${where}
       GROUP BY e.template_id, tr.display_name
       ORDER BY revenue_cents DESC
       LIMIT 50`,
      params,
    ),
  ]);

  const s = statsResult.rows[0];

  return {
    totalRevenue: s.total_revenue,
    platformFees: s.platform_fees,
    developerPayouts: s.developer_payouts,
    purchaseCount: s.purchase_count,
    recentEvents: eventsResult.rows.map((e) => ({
      templateId: e.template_id as string,
      grossAmount: e.gross_amount_cents as number,
      eventType: e.event_type as string,
      createdAt: e.created_at as string,
    })),
    byTemplate: byTemplateResult.rows.map((r) => ({
      templateId: r.template_id as string,
      templateName: r.template_name as string,
      revenueCents: r.revenue_cents as number,
      purchaseCount: r.purchase_count as number,
    })),
  };
}
