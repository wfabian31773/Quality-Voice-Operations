import { describe, it, expect, vi } from 'vitest';

import {
  parseArgs,
  selectCandidatePage,
  countAlreadyStamped,
  resolveInvoiceId,
  fetchInvoiceDiscount,
  processRow,
  runBackfill,
  wrapApplyWithVerification,
  type CandidateRow,
  type CliOptions,
  type RunBackfillDeps,
} from '../../scripts/backfill-marketplace-purchase-discounts';
import type { UpgradeDiscount } from '../../platform/billing/stripe/effectiveRate';

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  calls: FakeQueryCall[];
}

function makeFakeClient(
  handler: (sql: string, params?: unknown[]) => unknown[],
): FakeClient {
  const calls: FakeQueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    const rows = handler(sql, params);
    return { rows, rowCount: rows.length };
  });
  return { query, calls } as unknown as FakeClient;
}

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'pur_1',
    tenant_id: 'tenant_1',
    template_id: 'tpl_1',
    price_model: 'one_time',
    stripe_subscription_id: null,
    stripe_checkout_session_id: 'cs_test_1',
    ...overrides,
  };
}

function defaultOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return { apply: false, batchSize: 200, limit: null, tenantId: null, ...overrides };
}

const COUPON_DISCOUNT: UpgradeDiscount = {
  couponId: 'coupon_promo25',
  name: '25% off',
  percentOff: 25,
  amountOffCents: null,
  currency: null,
  promotionCode: 'PROMO25',
  promotionCodeId: 'promo_1',
};

describe('parseArgs', () => {
  it('defaults to dry-run with batch=200', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      batchSize: 200,
      limit: null,
      tenantId: null,
    });
  });

  it('honors --apply, --batch, --limit, --tenant', () => {
    expect(parseArgs(['--apply', '--batch=50', '--limit=10', '--tenant=t1'])).toEqual({
      apply: true,
      batchSize: 50,
      limit: 10,
      tenantId: 't1',
    });
  });

  it('ignores invalid numeric flags', () => {
    expect(parseArgs(['--batch=abc', '--limit=-5'])).toEqual({
      apply: false,
      batchSize: 200,
      limit: null,
      tenantId: null,
    });
  });
});

describe('selectCandidatePage', () => {
  it('issues a paginated SELECT with the idempotency + link guards', async () => {
    const client = makeFakeClient(() => []);
    await selectCandidatePage(client as never, defaultOpts({ batchSize: 25 }), null);
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call.sql).toContain('FROM marketplace_purchases');
    expect(call.sql).toContain('discount_badge_applied = FALSE');
    expect(call.sql).toContain(
      '(stripe_subscription_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL)',
    );
    expect(call.sql).toContain('ORDER BY id ASC');
    expect(call.sql).toContain('LIMIT $1');
    expect(call.params).toEqual([25]);
  });

  it('appends the cursor + tenant filter when provided', async () => {
    const client = makeFakeClient(() => []);
    await selectCandidatePage(
      client as never,
      defaultOpts({ batchSize: 10, tenantId: 't_42' }),
      'pur_cursor',
    );
    const call = client.calls[0];
    expect(call.sql).toContain('id > $1');
    expect(call.sql).toContain('tenant_id = $2');
    expect(call.sql).toContain('LIMIT $3');
    expect(call.params).toEqual(['pur_cursor', 't_42', 10]);
  });
});

describe('countAlreadyStamped', () => {
  it('counts globally when no tenant scope is set', async () => {
    const client = makeFakeClient(() => [{ count: '17' }]);
    const n = await countAlreadyStamped(client as never, defaultOpts());
    expect(n).toBe(17);
    const call = client.calls[0];
    expect(call.sql).toContain('discount_badge_applied = TRUE');
    expect(call.sql).toContain(
      '(stripe_subscription_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL)',
    );
    expect(call.sql).not.toContain('tenant_id');
    expect(call.params).toEqual([]);
  });

  it('scopes the count by --tenant when set', async () => {
    const client = makeFakeClient(() => [{ count: '4' }]);
    const n = await countAlreadyStamped(
      client as never,
      defaultOpts({ tenantId: 't_42' }),
    );
    expect(n).toBe(4);
    expect(client.calls[0].sql).toContain('tenant_id = $1');
    expect(client.calls[0].params).toEqual(['t_42']);
  });

  it('returns 0 when COUNT(*) is unparseable (defensive)', async () => {
    const client = makeFakeClient(() => [{ count: 'oops' }]);
    expect(await countAlreadyStamped(client as never, defaultOpts())).toBe(0);
  });

  it('returns 0 when no rows come back at all', async () => {
    const client = makeFakeClient(() => []);
    expect(await countAlreadyStamped(client as never, defaultOpts())).toBe(0);
  });
});

describe('wrapApplyWithVerification', () => {
  const COUPON: UpgradeDiscount = {
    couponId: 'c1',
    name: null,
    percentOff: 10,
    amountOffCents: null,
    currency: null,
    promotionCode: null,
    promotionCodeId: null,
  };

  it('resolves when the row flips to discount_badge_applied=TRUE on disk', async () => {
    const liveApply = vi.fn(async () => {});
    const client = makeFakeClient((sql) => {
      if (sql.includes('SELECT discount_badge_applied')) {
        return [{ discount_badge_applied: true }];
      }
      return [];
    });
    const wrapped = wrapApplyWithVerification(liveApply, client as never);
    await expect(wrapped('pur_1', COUPON)).resolves.toBeUndefined();
    expect(liveApply).toHaveBeenCalledWith('pur_1', COUPON);
    expect(client.calls[0].sql).toContain('SELECT discount_badge_applied');
    expect(client.calls[0].params).toEqual(['pur_1']);
  });

  it('throws when the live writer silently swallowed a DB error (row still FALSE)', async () => {
    const liveApply = vi.fn(async () => {});
    const client = makeFakeClient(() => [{ discount_badge_applied: false }]);
    const wrapped = wrapApplyWithVerification(liveApply, client as never);
    await expect(wrapped('pur_2', COUPON)).rejects.toThrow(/silently failed/);
  });

  it('throws when the row vanished between SELECT and UPDATE', async () => {
    const liveApply = vi.fn(async () => {});
    const client = makeFakeClient(() => []);
    const wrapped = wrapApplyWithVerification(liveApply, client as never);
    await expect(wrapped('pur_3', COUPON)).rejects.toThrow(/silently failed/);
  });
});

describe('resolveInvoiceId', () => {
  it('expands subscription.latest_invoice for recurring rows', async () => {
    const subscriptionsRetrieve = vi.fn(async () => ({
      latest_invoice: 'in_sub_latest',
    }));
    const stripe = {
      subscriptions: { retrieve: subscriptionsRetrieve },
      checkout: { sessions: { retrieve: vi.fn() } },
    } as unknown as Parameters<typeof resolveInvoiceId>[0];
    const id = await resolveInvoiceId(
      stripe,
      row({ price_model: 'monthly_subscription', stripe_subscription_id: 'sub_1' }),
    );
    expect(id).toBe('in_sub_latest');
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_1', {
      expand: ['latest_invoice'],
    });
  });

  it('reads expanded latest_invoice when Stripe returns it as an object', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ latest_invoice: { id: 'in_obj' } })),
      },
      checkout: { sessions: { retrieve: vi.fn() } },
    } as unknown as Parameters<typeof resolveInvoiceId>[0];
    const id = await resolveInvoiceId(
      stripe,
      row({ price_model: 'usage_based', stripe_subscription_id: 'sub_2' }),
    );
    expect(id).toBe('in_obj');
  });

  it('expands session.invoice for one-off rows', async () => {
    const sessionsRetrieve = vi.fn(async () => ({ invoice: 'in_sess_1' }));
    const stripe = {
      subscriptions: { retrieve: vi.fn() },
      checkout: { sessions: { retrieve: sessionsRetrieve } },
    } as unknown as Parameters<typeof resolveInvoiceId>[0];
    const id = await resolveInvoiceId(stripe, row());
    expect(id).toBe('in_sess_1');
    expect(sessionsRetrieve).toHaveBeenCalledWith('cs_test_1', {
      expand: ['invoice'],
    });
  });

  it('returns null for one-offs without an attached invoice (legacy charge-only sessions)', async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn() },
      checkout: { sessions: { retrieve: vi.fn(async () => ({ invoice: null })) } },
    } as unknown as Parameters<typeof resolveInvoiceId>[0];
    const id = await resolveInvoiceId(stripe, row());
    expect(id).toBeNull();
  });

  it('returns null when the candidate has neither link', async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn() },
      checkout: { sessions: { retrieve: vi.fn() } },
    } as unknown as Parameters<typeof resolveInvoiceId>[0];
    const id = await resolveInvoiceId(
      stripe,
      row({ stripe_checkout_session_id: null, stripe_subscription_id: null }),
    );
    expect(id).toBeNull();
  });
});

describe('fetchInvoiceDiscount', () => {
  it('runs the first usable discount through normalizeDiscount and returns it', async () => {
    const invoicesRetrieve = vi.fn(async () => ({
      discounts: [
        {
          coupon: {
            id: 'coupon_promo25',
            name: '25% off',
            percent_off: 25,
            valid: true,
          },
          promotion_code: { id: 'promo_1', code: 'PROMO25', active: true },
        },
      ],
    }));
    const stripe = { invoices: { retrieve: invoicesRetrieve } } as unknown as Parameters<
      typeof fetchInvoiceDiscount
    >[0];
    const discount = await fetchInvoiceDiscount(stripe, 'in_x');
    expect(discount).not.toBeNull();
    expect(discount?.couponId).toBe('coupon_promo25');
    expect(discount?.percentOff).toBe(25);
    expect(discount?.promotionCode).toBe('PROMO25');
    expect(invoicesRetrieve).toHaveBeenCalledWith('in_x', {
      expand: ['discounts', 'discounts.promotion_code'],
    });
  });

  it('returns null when the invoice has no discounts', async () => {
    const stripe = {
      invoices: { retrieve: vi.fn(async () => ({ discounts: [] })) },
    } as unknown as Parameters<typeof fetchInvoiceDiscount>[0];
    expect(await fetchInvoiceDiscount(stripe, 'in_y')).toBeNull();
  });

  it('skips invalid coupons (e.g. valid:false)', async () => {
    const stripe = {
      invoices: {
        retrieve: vi.fn(async () => ({
          discounts: [{ coupon: { id: 'expired', valid: false, percent_off: 50 } }],
        })),
      },
    } as unknown as Parameters<typeof fetchInvoiceDiscount>[0];
    expect(await fetchInvoiceDiscount(stripe, 'in_z')).toBeNull();
  });
});

type InvoiceResolution = string | null | (() => never);
type DiscountResolution = UpgradeDiscount | null | (() => never);

function makeStripeStub(map: {
  resolveInvoiceFor?: Record<string, InvoiceResolution>;
  discountFor?: Record<string, DiscountResolution>;
}) {
  return {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        const v = map.resolveInvoiceFor?.[id];
        if (typeof v === 'function') v();
        return { latest_invoice: typeof v === 'function' ? null : v ?? null };
      }),
    },
    checkout: {
      sessions: {
        retrieve: vi.fn(async (id: string) => {
          const v = map.resolveInvoiceFor?.[id];
          if (typeof v === 'function') v();
          return { invoice: typeof v === 'function' ? null : v ?? null };
        }),
      },
    },
    invoices: {
      retrieve: vi.fn(async (id: string) => {
        const v = map.discountFor?.[id];
        if (typeof v === 'function') v();
        if (!v || typeof v === 'function') return { discounts: [] };
        return {
          discounts: [
            {
              coupon: {
                id: v.couponId,
                name: v.name,
                percent_off: v.percentOff,
                amount_off: v.amountOffCents,
                currency: v.currency,
                valid: true,
              },
              promotion_code: v.promotionCodeId
                ? { id: v.promotionCodeId, code: v.promotionCode, active: true }
                : null,
            },
          ],
        };
      }),
    },
  } as unknown as RunBackfillDeps['stripe'];
}

describe('processRow', () => {
  it('returns "updated" and calls the mirror writer when a discount exists and --apply is set', async () => {
    const stripe = makeStripeStub({
      resolveInvoiceFor: { cs_test_1: 'in_1' },
      discountFor: { in_1: COUPON_DISCOUNT },
    });
    const apply = vi.fn(async () => {});
    const out = await processRow(row(), defaultOpts({ apply: true }), { stripe, apply });
    expect(out).toMatchObject({ kind: 'updated', purchaseId: 'pur_1', invoiceId: 'in_1' });
    expect(apply).toHaveBeenCalledTimes(1);
    const [purchaseIdArg, discountArg] = apply.mock.calls[0] as unknown as [
      string,
      UpgradeDiscount,
    ];
    expect(purchaseIdArg).toBe('pur_1');
    expect(discountArg.couponId).toBe('coupon_promo25');
  });

  it('does NOT call the mirror writer in dry-run, but still classifies as "updated"', async () => {
    const stripe = makeStripeStub({
      resolveInvoiceFor: { cs_test_1: 'in_1' },
      discountFor: { in_1: COUPON_DISCOUNT },
    });
    const apply = vi.fn(async () => {});
    const out = await processRow(row(), defaultOpts({ apply: false }), { stripe, apply });
    expect(out.kind).toBe('updated');
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns "no_discount" when the invoice has no usable discount', async () => {
    const stripe = makeStripeStub({
      resolveInvoiceFor: { cs_test_1: 'in_2' },
      discountFor: { in_2: null },
    });
    const apply = vi.fn();
    const out = await processRow(row(), defaultOpts({ apply: true }), { stripe, apply });
    expect(out).toMatchObject({ kind: 'no_discount', purchaseId: 'pur_1', invoiceId: 'in_2' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns "no_stripe_link" when no invoice can be resolved', async () => {
    const stripe = makeStripeStub({ resolveInvoiceFor: { cs_test_1: null } });
    const apply = vi.fn();
    const out = await processRow(row(), defaultOpts({ apply: true }), { stripe, apply });
    expect(out).toEqual({ kind: 'no_stripe_link', purchaseId: 'pur_1' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns "api_failure" when Stripe throws on subscription retrieve', async () => {
    const stripe = makeStripeStub({
      resolveInvoiceFor: {
        sub_err: () => {
          throw new Error('stripe boom');
        },
      },
    });
    const apply = vi.fn();
    const out = await processRow(
      row({ price_model: 'monthly_subscription', stripe_subscription_id: 'sub_err' }),
      defaultOpts({ apply: true }),
      { stripe, apply },
    );
    expect(out.kind).toBe('api_failure');
    if (out.kind === 'api_failure') {
      expect(out.error).toContain('stripe boom');
    }
  });

  it('returns "api_failure" when applyInvoiceDiscountToPurchase throws', async () => {
    const stripe = makeStripeStub({
      resolveInvoiceFor: { cs_test_1: 'in_1' },
      discountFor: { in_1: COUPON_DISCOUNT },
    });
    const apply = vi.fn(async () => {
      throw new Error('db down');
    });
    const out = await processRow(row(), defaultOpts({ apply: true }), { stripe, apply });
    expect(out.kind).toBe('api_failure');
  });
});

describe('runBackfill', () => {
  it('walks pages with id-based cursor pagination and tallies outcomes', async () => {
    const rows: CandidateRow[] = [
      row({ id: 'a', stripe_checkout_session_id: 'cs_a' }),
      row({ id: 'b', stripe_checkout_session_id: 'cs_b' }),
      row({ id: 'c', stripe_checkout_session_id: 'cs_c' }),
      row({ id: 'd', stripe_checkout_session_id: 'cs_d' }),
    ];
    const client = makeFakeClient((_sql, params) => {
      // Cursor is the FIRST param when set; otherwise SELECT returns
      // page from the start. The last param is always the limit.
      const pageSize = (params?.[params.length - 1] as number) ?? 200;
      // First param is cursor when there are >1 params (cursor + limit
      // here, since no tenant filter is set in this test).
      const cursor = params && params.length > 1 ? (params[0] as string) : null;
      const start = cursor === null ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
      return rows.slice(start, start + pageSize);
    });
    const stripe = makeStripeStub({
      resolveInvoiceFor: {
        cs_a: 'in_a',
        cs_b: 'in_b',
        cs_c: null, // no link
        cs_d: 'in_d',
      },
      discountFor: {
        in_a: COUPON_DISCOUNT,
        in_b: null, // no discount
        in_d: COUPON_DISCOUNT,
      },
    });
    const apply = vi.fn(async () => {});
    const result = await runBackfill(
      client as never,
      defaultOpts({ apply: true, batchSize: 2 }),
      { stripe, apply, logger: { log: () => {}, warn: () => {}, error: () => {} } },
    );
    expect(result.totals).toEqual({
      scanned: 4,
      updated: 2,
      noDiscount: 1,
      noStripeLink: 1,
      apiFailures: 0,
    });
    expect(apply).toHaveBeenCalledTimes(2);
    // Two-page walk: first page returns a/b, second returns c/d, third
    // returns empty and exits.
    expect(client.calls.length).toBe(3);
    // Verify the cursor advanced correctly between pages.
    expect(client.calls[1].params?.[0]).toBe('b');
    expect(client.calls[2].params?.[0]).toBe('d');
  });

  it('respects --limit and stops after N rows', async () => {
    const rows: CandidateRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ id: `r${i}`, stripe_checkout_session_id: `cs${i}` }),
    );
    const client = makeFakeClient((_sql, params) => {
      const pageSize = (params?.[params.length - 1] as number) ?? 200;
      const cursor = params && params.length > 1 ? (params[0] as string) : null;
      const start = cursor === null ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
      return rows.slice(start, start + pageSize);
    });
    const stripe = makeStripeStub({
      resolveInvoiceFor: { cs0: 'i0', cs1: 'i1', cs2: 'i2', cs3: 'i3', cs4: 'i4' },
      discountFor: {
        i0: COUPON_DISCOUNT,
        i1: COUPON_DISCOUNT,
        i2: COUPON_DISCOUNT,
        i3: COUPON_DISCOUNT,
        i4: COUPON_DISCOUNT,
      },
    });
    const apply = vi.fn(async () => {});
    const result = await runBackfill(
      client as never,
      defaultOpts({ apply: true, batchSize: 10, limit: 3 }),
      { stripe, apply, logger: { log: () => {}, warn: () => {}, error: () => {} } },
    );
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.updated).toBe(3);
    // The page size should be capped at the remaining limit.
    expect(client.calls[0].params).toContain(3);
  });

  it('aggregates api_failures without aborting the run', async () => {
    const rows: CandidateRow[] = [
      row({ id: 'good', stripe_checkout_session_id: 'cs_good' }),
      row({ id: 'bad', stripe_checkout_session_id: 'cs_bad' }),
    ];
    const client = makeFakeClient((_sql, params) => {
      const pageSize = (params?.[params.length - 1] as number) ?? 200;
      const cursor = params && params.length > 1 ? (params[0] as string) : null;
      const start = cursor === null ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
      return rows.slice(start, start + pageSize);
    });
    const stripe = makeStripeStub({
      resolveInvoiceFor: {
        cs_good: 'in_good',
        cs_bad: () => {
          throw new Error('rate limited');
        },
      },
      discountFor: { in_good: COUPON_DISCOUNT },
    });
    const apply = vi.fn(async () => {});
    const result = await runBackfill(
      client as never,
      defaultOpts({ apply: true, batchSize: 10 }),
      { stripe, apply, logger: { log: () => {}, warn: () => {}, error: () => {} } },
    );
    expect(result.totals).toEqual({
      scanned: 2,
      updated: 1,
      noDiscount: 0,
      noStripeLink: 0,
      apiFailures: 1,
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
