/**
 * Unit coverage for `reportUsage` in
 * `platform/marketplace/MarketplacePurchaseService.ts`. The function is the
 * marketplace add-on hook into Stripe's metered billing — we exercise the
 * happy path (a meter event is published with the right shape) and the failure
 * paths (no completed purchase, inactive subscription, missing customer,
 * unconfigured meter event name, and a thrown error from Stripe) so that
 * regressions away from the new Billing Meter Events API are caught.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRow = Record<string, unknown>;
type QueryHandler = (sql: string, values?: unknown[]) => Promise<{ rows: QueryRow[] }>;

let queryHandler: QueryHandler;
const meterEventCreate = vi.fn(async () => ({ id: 'mtr_evt_test' }));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: vi.fn(async (sql: string, values?: unknown[]) => queryHandler(sql, values)),
  }),
  withTenantContext: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    billing: {
      meterEvents: {
        create: meterEventCreate,
      },
    },
  }),
}));

import { reportUsage } from '../../platform/marketplace/MarketplacePurchaseService';

const TENANT = 'tenant-abc' as unknown as Parameters<typeof reportUsage>[0];
const TEMPLATE = 'tpl_marketplace_widget';

interface ScenarioOpts {
  purchase?: QueryRow | null;
  customerId?: string | null;
}

function setQueryHandler({ purchase, customerId }: ScenarioOpts) {
  queryHandler = async (sql: string) => {
    const trimmed = sql.trimStart();
    if (trimmed.startsWith('SELECT mp.id AS purchase_id')) {
      return { rows: purchase ? [purchase] : [] };
    }
    if (trimmed.startsWith('SELECT stripe_customer_id FROM subscriptions')) {
      return {
        rows: customerId ? [{ stripe_customer_id: customerId }] : [],
      };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
}

beforeEach(() => {
  meterEventCreate.mockClear();
  meterEventCreate.mockResolvedValue({ id: 'mtr_evt_test' });
  delete process.env.STRIPE_MARKETPLACE_METER_EVENT;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reportUsage (marketplace) — Billing Meter Events API', () => {
  it('publishes a meter event with the template-configured event name on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));

    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-1',
        stripe_subscription_id: 'sub_123',
        subscription_status: 'active',
        stripe_meter_event_name: 'marketplace_widget_calls',
      },
      customerId: 'cus_abc',
    });

    const result = await reportUsage(TENANT, TEMPLATE, 5);

    expect(result).toEqual({ success: true });
    expect(meterEventCreate).toHaveBeenCalledTimes(1);

    const [params, options] = meterEventCreate.mock.calls[0] as unknown as [
      {
        event_name: string;
        payload: Record<string, string>;
        timestamp: number;
      },
      { idempotencyKey: string },
    ];

    expect(params.event_name).toBe('marketplace_widget_calls');
    expect(params.payload).toEqual({
      stripe_customer_id: 'cus_abc',
      value: '5',
    });
    expect(params.timestamp).toBe(Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000));
    // Default idempotency key has the `mkt_<purchaseId>_<uuid>` shape — it
    // protects against the Stripe SDK's automatic transport retries but is
    // intentionally non-deterministic across separate `reportUsage()` calls.
    expect(options.idempotencyKey).toMatch(
      /^mkt_purchase-1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('honors a caller-supplied idempotency key (exactly-once semantics)', async () => {
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-idem',
        stripe_subscription_id: 'sub_active',
        subscription_status: 'active',
        stripe_meter_event_name: 'marketplace_widget_calls',
      },
      customerId: 'cus_abc',
    });

    // Two calls with the same business-event key must produce two Stripe
    // requests carrying the SAME idempotency key, so Stripe deduplicates.
    await reportUsage(TENANT, TEMPLATE, 3, { idempotencyKey: 'tool-exec-42' });
    await reportUsage(TENANT, TEMPLATE, 3, { idempotencyKey: 'tool-exec-42' });

    expect(meterEventCreate).toHaveBeenCalledTimes(2);
    const keys = meterEventCreate.mock.calls.map(
      (c) => (c as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey,
    );
    expect(keys[0]).toBe('mkt_purchase-idem_tool-exec-42');
    expect(keys[1]).toBe(keys[0]);
  });

  it('falls back to STRIPE_MARKETPLACE_METER_EVENT when the template has no event name', async () => {
    process.env.STRIPE_MARKETPLACE_METER_EVENT = 'marketplace_default_meter';
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-2',
        stripe_subscription_id: 'sub_456',
        subscription_status: 'past_due',
        stripe_meter_event_name: null,
      },
      customerId: 'cus_xyz',
    });

    const result = await reportUsage(TENANT, TEMPLATE, 1);

    expect(result.success).toBe(true);
    expect(meterEventCreate).toHaveBeenCalledTimes(1);
    const [params] = meterEventCreate.mock.calls[0] as unknown as [{ event_name: string }];
    expect(params.event_name).toBe('marketplace_default_meter');
  });

  it('rejects non-positive or non-integer quantities without hitting Stripe or the DB', async () => {
    setQueryHandler({ purchase: null });

    for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportUsage(TENANT, TEMPLATE, bad);
      expect(result).toEqual({
        success: false,
        error: 'quantity must be a positive integer',
      });
    }
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('returns a clean error when there is no completed usage-based purchase', async () => {
    setQueryHandler({ purchase: null });

    const result = await reportUsage(TENANT, TEMPLATE, 2);

    expect(result).toEqual({
      success: false,
      error: 'No active usage-based subscription found',
    });
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('returns a clean error when the subscription is canceled', async () => {
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-3',
        stripe_subscription_id: 'sub_789',
        subscription_status: 'canceled',
        stripe_meter_event_name: 'marketplace_widget_calls',
      },
      customerId: 'cus_abc',
    });

    const result = await reportUsage(TENANT, TEMPLATE, 1);

    expect(result).toEqual({ success: false, error: 'Subscription is not active' });
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('returns a clean error when the template + env both lack a meter event name', async () => {
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-4',
        stripe_subscription_id: 'sub_no_meter',
        subscription_status: 'active',
        stripe_meter_event_name: null,
      },
      customerId: 'cus_abc',
    });

    const result = await reportUsage(TENANT, TEMPLATE, 1);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing meter event name/i);
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('returns a clean error when the tenant has no Stripe customer on file', async () => {
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-5',
        stripe_subscription_id: 'sub_active',
        subscription_status: 'active',
        stripe_meter_event_name: 'marketplace_widget_calls',
      },
      customerId: null,
    });

    const result = await reportUsage(TENANT, TEMPLATE, 1);

    expect(result).toEqual({
      success: false,
      error: 'Tenant has no Stripe customer for usage reporting',
    });
    expect(meterEventCreate).not.toHaveBeenCalled();
  });

  it('catches Stripe errors and returns a billing-provider failure (no exception leak)', async () => {
    setQueryHandler({
      purchase: {
        purchase_id: 'purchase-6',
        stripe_subscription_id: 'sub_active',
        subscription_status: 'active',
        stripe_meter_event_name: 'marketplace_widget_calls',
      },
      customerId: 'cus_abc',
    });

    meterEventCreate.mockRejectedValueOnce(new Error('Stripe 500: meter unavailable'));

    const result = await reportUsage(TENANT, TEMPLATE, 4);

    expect(result).toEqual({
      success: false,
      error: 'Failed to report usage to billing provider',
    });
    expect(meterEventCreate).toHaveBeenCalledTimes(1);
  });
});
