/**
 * HTTP-level coverage for `GET /billing/effective-rate` (Task #1326).
 *
 * The Stripe-sourced overage path is already exercised at the
 * `getTenantEffectiveRate` unit level in `tests/billing/effectiveRate.test.ts`,
 * but the public Pricing page consumes the field via the API route and a
 * future regression in the handler (response shaping, accidental field
 * stripping, etc.) would not be caught by the unit test alone.
 *
 * This spec issues a real `request(app).get('/billing/effective-rate')`
 * with the platform DB and the Stripe SDK both mocked at the module
 * boundary, then asserts that `overagePriceSource` and the matching
 * `overageRatePerMinute` actually reach the JSON response — for both:
 *
 *   1. The "env-keyed overage" path: the subscription has no metered AI
 *      line, but `STRIPE_PRICE_<TIER>_AI_MINUTES` is wired and Stripe's
 *      `prices.retrieve` returns a metered price. The handler must
 *      surface `overagePriceSource: 'stripe'` plus the env-resolved
 *      per-minute rate.
 *   2. The "catalog fallback" path: same subscription shape, but the
 *      env var is unset and no metered AI line exists. The handler
 *      must surface `overagePriceSource: 'catalog'` plus the catalog
 *      per-minute rate for the inferred tier — proving the field is
 *      not silently dropped or rewritten when the override is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

const {
  queryMock,
  releaseMock,
  connectMock,
  subscriptionsRetrieveMock,
  pricesRetrieveMock,
} = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    subscriptionsRetrieveMock: vi.fn(),
    pricesRetrieveMock: vi.fn(),
  };
});

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/billing/stripe/checkout', () => ({
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
}));

// Intentionally do NOT mock `platform/billing/stripe/effectiveRate` —
// the whole point of this spec is to exercise the real
// `getTenantEffectiveRate` end-to-end through the handler.

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve: subscriptionsRetrieveMock },
    prices: { retrieve: pricesRetrieveMock },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

const currentUser = {
  tenantId: 'tenant-eff-rate-http',
  userId: 'user-1',
  role: 'manager',
  isPlatformAdmin: false,
  email: 'manager@acme.test',
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { ...currentUser };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import billingRoutes from '../../server/admin-api/routes/billing';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(billingRoutes);
  return app;
}

interface SubRow {
  plan: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  stripe_customer_id?: string | null;
}

/**
 * Stub the platform-pool query mock so the `loadSubscriptionRow` SELECT
 * resolves to the given row. Transactional control statements and
 * RLS `SET LOCAL` calls all return empty result sets so the helper still
 * completes cleanly.
 */
function stubSubscriptionRow(row: SubRow | null): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT plan, stripe_subscription_id/i.test(sql)) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const ENV_KEYS_TO_CLEAR = [
  'STRIPE_METER_AI_MINUTES',
  'STRIPE_METER_SMS_SENT',
  'STRIPE_METER_TWILIO_MINUTES',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
  'STRIPE_PRICE_STARTER_AI_MINUTES',
  'STRIPE_PRICE_PRO_AI_MINUTES',
  'STRIPE_PRICE_ENTERPRISE_AI_MINUTES',
];

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  subscriptionsRetrieveMock.mockReset();
  pricesRetrieveMock.mockReset();
  for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_CLEAR) delete process.env[key];
});

describe('GET /billing/effective-rate (HTTP)', () => {
  it('surfaces overagePriceSource: "stripe" + env-resolved overageRatePerMinute when STRIPE_PRICE_<TIER>_AI_MINUTES is wired', async () => {
    // Pro subscription with ONLY a licensed monthly base item — no
    // metered AI line on the live subscription. The resolver must fall
    // through to the `STRIPE_PRICE_PRO_AI_MINUTES` env-keyed lookup.
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_published';
    stubSubscriptionRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_pro_no_metered',
      stripe_price_id: 'price_pro_base_monthly',
      stripe_customer_id: 'cus_pro_no_metered',
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_base_monthly',
              unit_amount: PLAN_CATALOG.pro.monthlyPriceCents,
              unit_amount_decimal: String(PLAN_CATALOG.pro.monthlyPriceCents),
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });
    // The metered-AI lookup, plus the two interval lookups
    // (`_MONTHLY` / `_ANNUAL`) the handler also performs. Only the AI
    // lookup is asserted explicitly; the others are unset env vars and
    // are short-circuited before hitting Stripe.
    pricesRetrieveMock.mockImplementation(async (id: string) => {
      if (id === 'price_pro_ai_minutes_published') {
        return {
          id: 'price_pro_ai_minutes_published',
          unit_amount: 11,
          unit_amount_decimal: '11', // $0.11/min
          currency: 'usd',
          recurring: { usage_type: 'metered', interval: 'month' },
          metadata: { metric: 'ai_minutes' },
        };
      }
      throw new Error(`Unexpected prices.retrieve(${id})`);
    });

    const res = await request(buildApp()).get('/billing/effective-rate');

    expect(res.status).toBe(200);
    // The two assertions the task explicitly requires: the provenance
    // breadcrumb and the resolved per-minute rate must both reach the
    // wire untouched by response shaping in the handler.
    expect(res.body).toMatchObject({
      plan: 'pro',
      overagePriceSource: 'stripe',
      overagePriceId: 'price_pro_ai_minutes_published',
    });
    expect(res.body.overageRatePerMinute).toBeCloseTo(0.11, 6);
    // Sanity-check the env-keyed lookup actually fired against Stripe.
    expect(pricesRetrieveMock).toHaveBeenCalledWith('price_pro_ai_minutes_published');
    // Stripe override must beat the catalog rate (Pro = $0.12/min).
    expect(res.body.overageRatePerMinute).not.toBe(PLAN_CATALOG.pro.overageRatePerMinute);
  });

  it('surfaces overagePriceSource: "catalog" + catalog overageRatePerMinute when no Stripe override is available', async () => {
    // Same subscription shape (Pro, base-only), but the env var is
    // intentionally unset → the resolver should NOT find a Stripe
    // override and the response must report the catalog rate verbatim.
    stubSubscriptionRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_pro_no_metered',
      stripe_price_id: 'price_pro_base_monthly',
      stripe_customer_id: 'cus_pro_no_metered',
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_base_monthly',
              unit_amount: PLAN_CATALOG.pro.monthlyPriceCents,
              unit_amount_decimal: String(PLAN_CATALOG.pro.monthlyPriceCents),
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });

    const res = await request(buildApp()).get('/billing/effective-rate');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plan: 'pro',
      overagePriceSource: 'catalog',
      overagePriceId: null,
      overageRatePerMinute: PLAN_CATALOG.pro.overageRatePerMinute,
    });
    // No env var → no env-keyed `prices.retrieve` for the AI line.
    expect(pricesRetrieveMock).not.toHaveBeenCalledWith(
      'price_pro_ai_minutes_published',
    );
  });
});
