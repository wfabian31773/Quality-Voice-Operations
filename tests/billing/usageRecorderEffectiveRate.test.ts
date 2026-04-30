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
          let metricType: string;
          if (sql.includes(`'ai_minutes'::usage_metric_type`)) {
            metricType = 'ai_minutes';
          } else if (sql.includes(`'sms_sent'::usage_metric_type`)) {
            metricType = 'sms_sent';
          } else {
            metricType = String(values?.[1] ?? '');
          }
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

import {
  recordCallUsage,
  recordSmsUsage,
  estimateCallCostWithLiveRate,
} from '../../platform/billing/usage/UsageRecorder';
import { clearTenantEffectiveRateCache } from '../../platform/billing/stripe/effectiveRateCache';

const TENANT = 'tenant-usage-effective-rate';

beforeEach(() => {
  insertCalls = [];
  getTenantEffectiveRate.mockReset();
  clearTenantEffectiveRateCache();
  process.env.AI_COST_PER_MINUTE_CENTS = '6';
  process.env.TWILIO_COST_PER_MINUTE_CENTS = '2';
  process.env.SMS_COST_PER_MESSAGE_CENTS = '1';
});

afterEach(() => {
  delete process.env.AI_COST_PER_MINUTE_CENTS;
  delete process.env.TWILIO_COST_PER_MINUTE_CENTS;
  delete process.env.SMS_COST_PER_MESSAGE_CENTS;
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

describe('estimateCallCostWithLiveRate — per-call drilldown matches Stripe', () => {
  it('quotes the live tenant overage rate (not the env default) for the AI portion', async () => {
    // Negotiated tenant on $0.09/min — env default of 6¢/min would
    // under-quote the per-call AI cost by 33% if we used it instead.
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.09,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_negotiated',
    });

    // 3 minutes (180s rounded up) × 9¢/min = 27¢ AI; Twilio env = 2¢/min
    // × 3min = 6¢; total = 33¢. Env-default AI would give 18¢ + 6¢ = 24¢.
    const cost = await estimateCallCostWithLiveRate(TENANT, 180);

    expect(cost.aiCostCents).toBe(27);
    expect(cost.twilioCostCents).toBe(6);
    expect(cost.totalCostCents).toBe(33);
  });

  it('rounds the AI aggregate (not the per-minute rate) so sub-cent Stripe pricing matches the invoice', async () => {
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

    // 2 minutes × 7.5¢ = 15¢. Per-minute rounding would give 16¢.
    const cost = await estimateCallCostWithLiveRate(TENANT, 120);

    expect(cost.aiCostCents).toBe(15);
  });

  it('falls back to AI_COST_PER_MINUTE_CENTS when the resolver throws', async () => {
    getTenantEffectiveRate.mockRejectedValue(new Error('Stripe boom'));

    const cost = await estimateCallCostWithLiveRate(TENANT, 120);

    // 2 minutes × 6¢ env default = 12¢ AI; 2 × 2¢ Twilio env = 4¢.
    expect(cost.aiCostCents).toBe(12);
    expect(cost.twilioCostCents).toBe(4);
    expect(cost.totalCostCents).toBe(16);
  });

  it('skips the resolver entirely for a zero-duration call', async () => {
    const cost = await estimateCallCostWithLiveRate(TENANT, 0);

    expect(getTenantEffectiveRate).not.toHaveBeenCalled();
    expect(cost.aiCostCents).toBe(0);
    expect(cost.twilioCostCents).toBe(0);
    expect(cost.totalCostCents).toBe(0);
  });
});

describe('recordSmsUsage — tenant-effective Stripe rate', () => {
  it('writes sms_sent total_cost_cents using the live Stripe per-message rate', async () => {
    // Tenant negotiated $0.025/SMS — well above the env catalog default of 1¢.
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.09,
      smsRatePerMessage: 0.025,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      smsPriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_custom',
      smsPriceId: 'price_sms_custom',
    });

    await recordSmsUsage(TENANT, 4);

    const smsInsert = insertCalls.find((c) => c.metricType === 'sms_sent');
    expect(smsInsert).toBeDefined();
    // Bound params: $1 tenantId, $2 periodStart, $3 periodEnd,
    // $4 quantity, $5 unit_cost_cents, $6 total_cost_cents.
    const [tenantArg, , , quantity, unitCost, totalCost] = smsInsert!.values;
    expect(tenantArg).toBe(TENANT);
    expect(quantity).toBe(4);
    // $0.025/SMS = 2.5¢ → unit rounds to 3¢, aggregate stays at 4 × 2.5 = 10¢.
    expect(unitCost).toBe(3);
    expect(totalCost).toBe(10);
  });

  it('caches the resolved SMS rate across back-to-back sends', async () => {
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.09,
      smsRatePerMessage: 0.04,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      smsPriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_custom',
      smsPriceId: 'price_sms_custom',
    });

    await recordSmsUsage(TENANT, 1);
    await recordSmsUsage(TENANT, 2);
    await recordSmsUsage(TENANT, 1);

    expect(getTenantEffectiveRate).toHaveBeenCalledTimes(1);

    const smsInserts = insertCalls.filter((c) => c.metricType === 'sms_sent');
    expect(smsInserts).toHaveLength(3);
    // Each insert uses the cached 4¢/message rate.
    expect(smsInserts[0]!.values[5]).toBe(4);
    expect(smsInserts[1]!.values[5]).toBe(8);
    expect(smsInserts[2]!.values[5]).toBe(4);
  });

  it('skips the rate resolver entirely when there is nothing to record', async () => {
    await recordSmsUsage(TENANT, 0);

    expect(getTenantEffectiveRate).not.toHaveBeenCalled();
    const smsInsert = insertCalls.find((c) => c.metricType === 'sms_sent');
    expect(smsInsert).toBeDefined();
    expect(smsInsert!.values[3]).toBe(0);
    expect(smsInsert!.values[5]).toBe(0);
  });

  it('falls back to SMS_COST_PER_MESSAGE_CENTS when the rate resolver throws', async () => {
    process.env.SMS_COST_PER_MESSAGE_CENTS = '2';
    getTenantEffectiveRate.mockRejectedValue(new Error('Stripe boom'));

    await recordSmsUsage(TENANT, 3);

    const smsInsert = insertCalls.find((c) => c.metricType === 'sms_sent');
    expect(smsInsert).toBeDefined();
    expect(smsInsert!.values[4]).toBe(2);
    expect(smsInsert!.values[5]).toBe(6);
  });

  it('falls back to the env default when the resolver omits smsRatePerMessage', async () => {
    process.env.SMS_COST_PER_MESSAGE_CENTS = '5';
    // Old-style fixture without `smsRatePerMessage` (back-compat with
    // pre-1206 callers).
    getTenantEffectiveRate.mockResolvedValue({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.12,
      currency: 'usd',
      source: 'catalog',
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      basePriceId: null,
      overagePriceId: null,
    });

    await recordSmsUsage(TENANT, 2);

    const smsInsert = insertCalls.find((c) => c.metricType === 'sms_sent');
    expect(smsInsert).toBeDefined();
    expect(smsInsert!.values[4]).toBe(5);
    expect(smsInsert!.values[5]).toBe(10);
  });
});
