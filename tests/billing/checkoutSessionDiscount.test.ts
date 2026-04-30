import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

const customersRetrieve = vi.fn();
const sessionsCreate = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
        ) {
          return { rows: [] };
        }
        return { rows: [{ stripe_customer_id: 'cus_existing_123' }] };
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

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_starter_monthly',
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: customersRetrieve },
    checkout: { sessions: { create: sessionsCreate } },
  }),
}));

import { createCheckoutSession } from '../../platform/billing/stripe/checkout';

const TENANT: TenantId = 'tenant-checkout-discount';

beforeEach(() => {
  customersRetrieve.mockReset();
  sessionsCreate.mockReset();
  sessionsCreate.mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createCheckoutSession discount forwarding', () => {
  it('prefers promotion_code over coupon when both are available', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_existing_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });

    await createCheckoutSession({
      tenantId: TENANT,
      plan: 'starter',
      interval: 'monthly',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    });

    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.discounts).toEqual([{ promotion_code: 'promo_xyz' }]);
  });

  it('falls back to coupon when no promotion code exists', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_existing_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: null,
      },
    });

    await createCheckoutSession({
      tenantId: TENANT,
      plan: 'starter',
      interval: 'monthly',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    });

    const args = sessionsCreate.mock.calls[0][0];
    expect(args.discounts).toEqual([{ coupon: 'coupon_promo25' }]);
  });

  it('omits the `discounts` key entirely when no discount is attached', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_existing_123',
      discount: null,
    });

    await createCheckoutSession({
      tenantId: TENANT,
      plan: 'starter',
      interval: 'monthly',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    });

    const args = sessionsCreate.mock.calls[0][0];
    expect('discounts' in args).toBe(false);
  });

  it('does not block checkout when the discount lookup throws', async () => {
    customersRetrieve.mockRejectedValue(new Error('stripe is down'));

    const result = await createCheckoutSession({
      tenantId: TENANT,
      plan: 'starter',
      interval: 'monthly',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    });

    expect(result.sessionId).toBe('cs_test_123');
    const args = sessionsCreate.mock.calls[0][0];
    expect('discounts' in args).toBe(false);
  });

  it('drops the discount when the coupon is no longer valid', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_existing_123',
      discount: {
        coupon: { id: 'coupon_dead', percent_off: 50, valid: false },
      },
    });

    await createCheckoutSession({
      tenantId: TENANT,
      plan: 'starter',
      interval: 'monthly',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    });

    const args = sessionsCreate.mock.calls[0][0];
    expect('discounts' in args).toBe(false);
  });
});
