import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveMock = vi.fn();

vi.mock('stripe', () => {
  class StripeMock {
    prices = { retrieve: retrieveMock };
    constructor(_apiKey: string, _opts?: unknown) {}
  }
  return { default: StripeMock };
});

import { verifyStripePrices } from '../../platform/billing/stripe/verifyPrices';

const PRICE_ENV_KEYS = [
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
] as const;

const AI_MINUTE_ENV_KEYS = [
  'STRIPE_PRICE_STARTER_AI_MINUTES',
  'STRIPE_PRICE_PRO_AI_MINUTES',
  'STRIPE_PRICE_ENTERPRISE_AI_MINUTES',
] as const;

const ALL_MANAGED_KEYS = [
  ...PRICE_ENV_KEYS,
  ...AI_MINUTE_ENV_KEYS,
  'STRIPE_SECRET_KEY',
  'STRIPE_METER_EVENT_AI_MINUTES',
  'STRIPE_METER_AI_MINUTES',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ALL_MANAGED_KEYS) {
  ORIGINAL_ENV[key] = process.env[key];
}

beforeEach(() => {
  retrieveMock.mockReset();
  for (const key of ALL_MANAGED_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function setPriceEnvVars(): void {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
  process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_a';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_a';
  process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_enterprise_m';
  process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL = 'price_enterprise_a';
}

function setAiMinutesEnvVars(): void {
  process.env.STRIPE_PRICE_STARTER_AI_MINUTES = 'price_starter_ai';
  process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai';
  process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES = 'price_enterprise_ai';
}

function makePrice(interval: 'month' | 'year', unitAmount: number) {
  return {
    id: 'price_x',
    recurring: { interval, interval_count: 1, usage_type: 'licensed' },
    unit_amount: unitAmount,
    unit_amount_decimal: String(unitAmount),
  };
}

function makeMeteredPrice(meter: string, unitAmount: number, decimal?: string) {
  return {
    id: 'price_x',
    recurring: {
      interval: 'month',
      interval_count: 1,
      usage_type: 'metered',
      meter,
    },
    unit_amount: unitAmount,
    unit_amount_decimal: decimal ?? String(unitAmount),
  };
}

describe('verifyStripePrices', () => {
  it('returns no-stripe-key when STRIPE_SECRET_KEY is unset', async () => {
    setPriceEnvVars();
    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('no-stripe-key');
    expect(report.summary.total).toBe(0);
    expect(report.results).toHaveLength(0);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('passes when every price is wired to the right interval', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('ok');
    expect(report.summary.total).toBe(6);
    expect(report.summary.ok).toBe(6);
    expect(report.summary.failed).toBe(0);

    const annual = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_ANNUAL');
    expect(annual?.status).toBe('ok');
    expect(annual?.kind).toBe('base');
    expect(annual?.actualInterval).toBe('year');
    expect(annual?.monthlyEquivalentCents).toBe(10_000);

    const monthly = report.results.find((r) => r.envKey === 'STRIPE_PRICE_STARTER_MONTHLY');
    expect(monthly?.monthlyEquivalentCents).toBe(100_00);
  });

  it('fails when an _ANNUAL env points at a month-interval Stripe price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_a') return makePrice('month', 100_00);
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    expect(report.summary.failed).toBe(1);
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_ANNUAL');
    expect(broken?.status).toBe('wrong-interval');
    expect(broken?.actualInterval).toBe('month');
    expect(broken?.message).toMatch(/expected year/);
  });

  it('reports missing-env without calling Stripe when an env var is unset', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    delete process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL;

    retrieveMock.mockImplementation(async (priceId: string) => {
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const missing = report.results.find((r) => r.envKey === 'STRIPE_PRICE_ENTERPRISE_ANNUAL');
    expect(missing?.status).toBe('missing-env');
    expect(missing?.priceId).toBeNull();
    const callsForMissing = retrieveMock.mock.calls.filter(
      (c) => c[0] === 'price_enterprise_a',
    );
    expect(callsForMissing).toHaveLength(0);
  });

  it('reports stripe-error when Stripe throws (e.g. deleted price)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_starter_m') {
        throw new Error('No such price: price_starter_m');
      }
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_STARTER_MONTHLY');
    expect(broken?.status).toBe('stripe-error');
    expect(broken?.message).toMatch(/No such price/);
  });

  it('flags prices with no unit_amount as no-amount', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_m') {
        return {
          id: priceId,
          recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
          unit_amount: null,
          unit_amount_decimal: null,
        };
      }
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_MONTHLY');
    expect(broken?.status).toBe('no-amount');
    expect(broken?.unitAmountCents).toBeNull();
  });

  describe('metered AI-minute price gate', () => {
    it('skips metered checks when STRIPE_METER_EVENT_AI_MINUTES is unset', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.total).toBe(6);
      expect(report.results.every((r) => r.kind === 'base')).toBe(true);
      const meteredCalls = retrieveMock.mock.calls.filter((c) =>
        String(c[0]).endsWith('_ai'),
      );
      expect(meteredCalls).toHaveLength(0);
    });

    it('passes when every metered AI-minute price is wired to the right meter', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId.endsWith('_ai')) {
          return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        }
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('ok');
      expect(report.summary.total).toBe(9);
      expect(report.summary.ok).toBe(9);
      expect(report.summary.failed).toBe(0);

      const meteredRows = report.results.filter((r) => r.kind === 'metered-ai-minutes');
      expect(meteredRows).toHaveLength(3);
      for (const row of meteredRows) {
        expect(row.status).toBe('ok');
        expect(row.actualUsageType).toBe('metered');
        expect(row.actualMeter).toBe('mtr_test_aiminutes');
        expect(row.expectedMeter).toBe('mtr_test_aiminutes');
        expect(row.unitAmountDecimal).toBe('7.5');
        expect(row.catalogOverageRatePerMinute).toBeGreaterThan(0);
        expect(row.expectedInterval).toBeNull();
        expect(row.catalogMonthlyCents).toBeNull();
      }
      expect(report.summary.message).toMatch(/3 metered/);
    });

    it('fails fast when STRIPE_METER_EVENT_AI_MINUTES is set but STRIPE_METER_AI_MINUTES is unset', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId.endsWith('_ai')) return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const meteredRows = report.results.filter((r) => r.kind === 'metered-ai-minutes');
      expect(meteredRows).toHaveLength(3);
      for (const row of meteredRows) {
        expect(row.status).toBe('missing-env');
        expect(row.expectedMeter).toBeNull();
        expect(row.message).toMatch(/STRIPE_METER_AI_MINUTES is not set/);
      }
      expect(
        retrieveMock.mock.calls.filter((c) => String(c[0]).endsWith('_ai')),
      ).toHaveLength(0);
    });

    it('reports missing-env for an unset _AI_MINUTES var when the gate is on', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai';
      process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES = 'price_enterprise_ai';

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId.endsWith('_ai')) return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const starter = report.results.find(
        (r) => r.envKey === 'STRIPE_PRICE_STARTER_AI_MINUTES',
      );
      expect(starter?.status).toBe('missing-env');
      expect(starter?.priceId).toBeNull();
      expect(
        retrieveMock.mock.calls.filter((c) => c[0] === 'price_starter_ai'),
      ).toHaveLength(0);
    });

    it('rejects a licensed price wired into a metered AI-minute slot', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId === 'price_pro_ai') {
          return makePrice('month', 39_900);
        }
        if (priceId.endsWith('_ai')) return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const broken = report.results.find(
        (r) => r.envKey === 'STRIPE_PRICE_PRO_AI_MINUTES',
      );
      expect(broken?.status).toBe('wrong-usage-type');
      expect(broken?.actualUsageType).toBe('licensed');
      expect(broken?.message).toMatch(/expected metered/);
    });

    it('rejects a metered price whose meter does not match STRIPE_METER_AI_MINUTES', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId === 'price_enterprise_ai') {
          return makeMeteredPrice('mtr_test_smssent', 5, '5');
        }
        if (priceId.endsWith('_ai')) return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const broken = report.results.find(
        (r) => r.envKey === 'STRIPE_PRICE_ENTERPRISE_AI_MINUTES',
      );
      expect(broken?.status).toBe('wrong-meter');
      expect(broken?.actualMeter).toBe('mtr_test_smssent');
      expect(broken?.expectedMeter).toBe('mtr_test_aiminutes');
      expect(broken?.message).toMatch(/expected mtr_test_aiminutes/);
      expect(broken?.message).toMatch(/STRIPE_METER_AI_MINUTES/);
    });

    it('also rejects a metered price whose recurring.meter equals the event name instead of the meter id', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId.endsWith('_ai')) {
          return makeMeteredPrice('ai_minutes', 8, '7.5');
        }
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const meteredRows = report.results.filter((r) => r.kind === 'metered-ai-minutes');
      expect(meteredRows).toHaveLength(3);
      for (const row of meteredRows) {
        expect(row.status).toBe('wrong-meter');
        expect(row.actualMeter).toBe('ai_minutes');
        expect(row.expectedMeter).toBe('mtr_test_aiminutes');
      }
    });

    it('reports stripe-error when the metered price retrieve throws', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
      process.env.STRIPE_METER_AI_MINUTES = 'mtr_test_aiminutes';
      setPriceEnvVars();
      setAiMinutesEnvVars();

      retrieveMock.mockImplementation(async (priceId: string) => {
        if (priceId === 'price_starter_ai') {
          throw new Error('No such price: price_starter_ai');
        }
        if (priceId.endsWith('_ai')) return makeMeteredPrice('mtr_test_aiminutes', 8, '7.5');
        const isAnnual = priceId.endsWith('_a');
        return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
      });

      const report = await verifyStripePrices();
      expect(report.summary.status).toBe('failed');
      const broken = report.results.find(
        (r) => r.envKey === 'STRIPE_PRICE_STARTER_AI_MINUTES',
      );
      expect(broken?.status).toBe('stripe-error');
      expect(broken?.message).toMatch(/No such price/);
    });
  });
});
