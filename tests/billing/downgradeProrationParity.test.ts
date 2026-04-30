/**
 * Parity coverage for Task #1305 (updated #1367). The
 * `proration_behavior` value the preview hands to
 * `stripe.invoices.createPreview` and the value the scheduler stamps
 * on the lower-tier phase must stay identical so the UI can never
 * quote a next-invoice total Stripe wouldn't actually generate at
 * apply time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryHandler = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

let queryHandler: QueryHandler = async () => ({ rows: [] });
const customersRetrieve = vi.fn();
const pricesRetrieve = vi.fn();
const subscriptionsRetrieve = vi.fn();
const invoicesCreatePreview = vi.fn();
const subscriptionSchedulesCreate = vi.fn();
const subscriptionSchedulesRetrieve = vi.fn();
const subscriptionSchedulesUpdate = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
        ) {
          return { rows: [] };
        }
        return queryHandler(sql, values);
      }),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: customersRetrieve },
    prices: { retrieve: pricesRetrieve },
    subscriptions: { retrieve: subscriptionsRetrieve },
    invoices: { createPreview: invoicesCreatePreview },
    subscriptionSchedules: {
      create: subscriptionSchedulesCreate,
      retrieve: subscriptionSchedulesRetrieve,
      update: subscriptionSchedulesUpdate,
    },
  }),
}));

import { getTenantDowngradePreview } from '../../platform/billing/stripe/effectiveRate';
import {
  scheduleDowngrade,
  DOWNGRADE_PRORATION_BEHAVIOR,
} from '../../platform/billing/stripe/planChange';

const TENANT = 'tenant-downgrade-parity';

interface SubRow {
  plan?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
  stripe_customer_id?: string | null;
  billing_interval?: string | null;
}

function setSubRow(row: SubRow | null) {
  queryHandler = async (sql: string) => {
    const trimmed = sql.trimStart();
    if (
      trimmed.startsWith('SELECT plan, stripe_subscription_id')
      || trimmed.startsWith('SELECT stripe_subscription_id')
    ) {
      return { rows: row ? [row as Record<string, unknown>] : [] };
    }
    return { rows: [] };
  };
}

beforeEach(() => {
  customersRetrieve.mockReset();
  pricesRetrieve.mockReset();
  subscriptionsRetrieve.mockReset();
  invoicesCreatePreview.mockReset();
  subscriptionSchedulesCreate.mockReset();
  subscriptionSchedulesRetrieve.mockReset();
  subscriptionSchedulesUpdate.mockReset();
  queryHandler = async () => ({ rows: [] });
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_published';
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_published';
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly_published';
});

afterEach(() => {
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
});

describe('downgrade preview ↔ scheduleDowngrade proration parity', () => {
  it('exposes a valid shared constant', () => {
    // Stripe only accepts these two values for schedule phases and
    // for `subscription_details.proration_behavior` on createPreview.
    expect(['none', 'create_prorations']).toContain(DOWNGRADE_PRORATION_BEHAVIOR);
  });

  it('preview and apply pass Stripe the same proration_behavior', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_parity',
      stripe_price_id: 'price_ent_base',
      stripe_customer_id: 'cus_parity',
      billing_interval: 'monthly',
    });

    // ---- Preview path setup ---------------------------------------
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_parity',
      deleted: false,
      currency: 'usd',
      discount: null,
    });
    // First subscriptions.retrieve call comes from the preview path.
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_parity',
      items: {
        data: [
          {
            id: 'si_licensed_ent',
            price: {
              id: 'price_ent_monthly',
              recurring: { usage_type: 'licensed', interval: 'month' },
            },
          },
        ],
      },
    });
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 39_900,
      amount_due: 39_900,
      currency: 'usd',
      next_payment_attempt: 1_770_000_000,
      period_end: 1_770_000_000,
      lines: { data: [{ amount: 39_900, proration: false }] },
    });

    await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    expect(invoicesCreatePreview).toHaveBeenCalledTimes(1);
    const previewArgs = invoicesCreatePreview.mock.calls[0]![0] as {
      subscription_details: { proration_behavior: string };
    };
    const previewProration = previewArgs.subscription_details.proration_behavior;

    // ---- Apply path setup -----------------------------------------
    const phaseStart = 1_750_000_000;
    const phaseEnd = 1_770_000_000;
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_parity',
      schedule: null,
      items: {
        data: [
          {
            id: 'si_licensed_ent',
            price: { id: 'price_enterprise_monthly' },
          },
        ],
      },
    });
    subscriptionSchedulesCreate.mockResolvedValueOnce({
      id: 'sub_sched_parity',
      phases: [
        {
          start_date: phaseStart,
          end_date: phaseEnd,
          items: [{ price: 'price_enterprise_monthly', quantity: 1 }],
        },
      ],
    });
    subscriptionSchedulesUpdate.mockResolvedValueOnce({ id: 'sub_sched_parity' });

    await scheduleDowngrade({
      tenantId: TENANT,
      targetPlan: 'pro',
      targetInterval: 'monthly',
    });

    expect(subscriptionSchedulesUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = subscriptionSchedulesUpdate.mock.calls[0]![1] as {
      phases: Array<{ proration_behavior: string }>;
    };
    // Phase 1 is the new lower-tier phase.
    const applyProration = updateArgs.phases[1]!.proration_behavior;

    expect(previewProration).toBe(DOWNGRADE_PRORATION_BEHAVIOR);
    expect(applyProration).toBe(DOWNGRADE_PRORATION_BEHAVIOR);
    expect(previewProration).toBe(applyProration);
  });

  it('parity holds for an annual downgrade target as well', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_parity_annual',
      stripe_price_id: null,
      stripe_customer_id: 'cus_parity_annual',
      billing_interval: 'monthly',
    });

    // Preview path
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_annual_published',
      unit_amount: 383_040,
      unit_amount_decimal: '383040',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'year' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_parity_annual',
      deleted: false,
      discount: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_parity_annual',
      items: {
        data: [
          {
            id: 'si_licensed_ent_annual',
            price: { id: 'price_ent_monthly', recurring: { usage_type: 'licensed' } },
          },
        ],
      },
    });
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 383_040,
      amount_due: 383_040,
      currency: 'usd',
      next_payment_attempt: null,
      period_end: 1_780_000_000,
      lines: { data: [{ amount: 383_040, proration: false }] },
    });

    await getTenantDowngradePreview(TENANT, 'pro', 'annual');

    const previewArgs = invoicesCreatePreview.mock.calls[0]![0] as {
      subscription_details: { proration_behavior: string };
    };

    // Apply path
    const phaseStart = 1_750_000_000;
    const phaseEnd = 1_780_000_000;
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_parity_annual',
      schedule: null,
      items: {
        data: [{ id: 'si_licensed_ent_annual', price: { id: 'price_enterprise_monthly' } }],
      },
    });
    subscriptionSchedulesCreate.mockResolvedValueOnce({
      id: 'sub_sched_parity_annual',
      phases: [
        {
          start_date: phaseStart,
          end_date: phaseEnd,
          items: [{ price: 'price_enterprise_monthly', quantity: 1 }],
        },
      ],
    });
    subscriptionSchedulesUpdate.mockResolvedValueOnce({ id: 'sub_sched_parity_annual' });

    await scheduleDowngrade({
      tenantId: TENANT,
      targetPlan: 'pro',
      targetInterval: 'annual',
    });

    const updateArgs = subscriptionSchedulesUpdate.mock.calls[0]![1] as {
      phases: Array<{ proration_behavior: string; duration?: { interval: string } }>;
    };
    expect(updateArgs.phases[1]!.duration).toEqual({ interval_count: 1, interval: 'year' });
    expect(updateArgs.phases[1]!.proration_behavior).toBe(
      previewArgs.subscription_details.proration_behavior,
    );
  });

});
