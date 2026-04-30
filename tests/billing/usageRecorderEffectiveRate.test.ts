// Verifies `recordCallUsage` writes the AI-minutes row using the live
// per-tenant Stripe rate via `getCachedTenantEffectiveRate`, that the
// cache prevents repeat resolutions, and that resolver failures fall
// back to the env default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface InsertCall {
  metricType: string;
  values: unknown[];
}

let insertCalls: InsertCall[] = [];

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
        if (trimmed.startsWith('INSERT INTO usage_metrics')) {
          const metricType =
            sql.includes(`'ai_minutes'::usage_metric_type`)
              ? 'ai_minutes'
              : String(values?.[1] ?? '');
          insertCalls.push({ metricType, values: values ?? [] });
          return { rows: [] };
        }
        return { rows: [] };
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

const stripeRateMocks = vi.hoisted(() => ({
  getTenantEffectiveRate: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: stripeRateMocks.getTenantEffectiveRate,
}));

const { getTenantEffectiveRate } = stripeRateMocks;

import { recordCallUsage } from '../../platform/billing/usage/UsageRecorder';
import { clearTenantEffectiveRateCache } from '../../platform/billing/stripe/effectiveRateCache';

const TENANT = 'tenant-usage-effective-rate';

beforeEach(() => {
  insertCalls = [];
  getTenantEffectiveRate.mockReset();
  clearTenantEffectiveRateCache();
  process.env.AI_COST_PER_MINUTE_CENTS = '6';
  process.env.TWILIO_COST_PER_MINUTE_CENTS = '2';
});

afterEach(() => {
  delete process.env.AI_COST_PER_MINUTE_CENTS;
  delete process.env.TWILIO_COST_PER_MINUTE_CENTS;
  clearTenantEffectiveRateCache();
});

describe('recordCallUsage — tenant-effective Stripe rate', () => {
  it('writes AI-minutes total_cost_cents using the live Stripe overage rate', async () => {
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.09,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_custom',
    });

    await recordCallUsage(TENANT, 'inbound', 180);

    const aiInsert = insertCalls.find((c) => c.metricType === 'ai_minutes');
    expect(aiInsert).toBeDefined();
    // Bound params: $1 tenantId, $2 periodStart, $3 periodEnd,
    // $4 quantity, $5 unit_cost_cents, $6 total_cost_cents.
    const [tenantArg, , , quantity, unitCost, totalCost] = aiInsert!.values;
    expect(tenantArg).toBe(TENANT);
    expect(quantity).toBe(3);
    expect(unitCost).toBe(9);
    expect(totalCost).toBe(27);
  });

  it('caches the resolved rate across back-to-back calls', async () => {
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.11,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_custom',
    });

    await recordCallUsage(TENANT, 'inbound', 60);
    await recordCallUsage(TENANT, 'outbound', 60);
    await recordCallUsage(TENANT, 'inbound', 60);

    expect(getTenantEffectiveRate).toHaveBeenCalledTimes(1);

    const aiInserts = insertCalls.filter((c) => c.metricType === 'ai_minutes');
    expect(aiInserts).toHaveLength(3);
    for (const ins of aiInserts) {
      expect(ins.values[4]).toBe(11);
      expect(ins.values[5]).toBe(11);
    }
  });

  it('rounds the aggregate (not the per-minute rate) so sub-cent Stripe pricing matches the invoice', async () => {
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      // $0.075/min — would lossily round to 8¢/min if rounded per-minute.
      overageRatePerMinute: 0.075,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_subcent',
    });

    // 2 minutes × 7.5¢ = 15¢. Rounding per-minute would record 16¢.
    await recordCallUsage(TENANT, 'inbound', 120);

    const aiInsert = insertCalls.find((c) => c.metricType === 'ai_minutes');
    expect(aiInsert).toBeDefined();
    expect(aiInsert!.values[3]).toBe(2);
    expect(aiInsert!.values[5]).toBe(15);
  });

  it('skips the rate resolver entirely when there are no AI minutes to record', async () => {
    await recordCallUsage(TENANT, 'inbound', 0, 0);

    expect(getTenantEffectiveRate).not.toHaveBeenCalled();
    expect(insertCalls.find((c) => c.metricType === 'ai_minutes')).toBeUndefined();
  });

  it('falls back to AI_COST_PER_MINUTE_CENTS when the rate resolver throws', async () => {
    getTenantEffectiveRate.mockRejectedValue(new Error('Stripe boom'));

    await recordCallUsage(TENANT, 'inbound', 120);

    const aiInsert = insertCalls.find((c) => c.metricType === 'ai_minutes');
    expect(aiInsert).toBeDefined();
    expect(aiInsert!.values[4]).toBe(6);
    expect(aiInsert!.values[5]).toBe(12);
  });
});
