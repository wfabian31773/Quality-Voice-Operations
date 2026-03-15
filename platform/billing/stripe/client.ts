import Stripe from 'stripe';
import { createLogger } from '../../core/logger';

const logger = createLogger('STRIPE_CLIENT');
const IS_PROD = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (_stripe) return _stripe;

  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    if (IS_PROD) {
      throw new Error('STRIPE_SECRET_KEY is required in production');
    }
    logger.warn('STRIPE_SECRET_KEY not set — Stripe calls will fail (dev mode)');
    _stripe = new Stripe('sk_test_placeholder', {
      apiVersion: '2026-02-25.clover' as const,
    });
    return _stripe;
  }

  _stripe = new Stripe(apiKey, { apiVersion: '2026-02-25.clover' as const });
  return _stripe;
}

export function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    if (IS_PROD) throw new Error('STRIPE_WEBHOOK_SECRET is required in production');
    logger.warn('STRIPE_WEBHOOK_SECRET not set — webhook verification disabled (dev mode)');
    return 'whsec_placeholder';
  }
  return secret;
}
