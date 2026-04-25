import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Stripe from 'stripe';

// We import the route lazily inside `buildApp` (after env vars are set) so the
// Stripe client is constructed against the test secret, mirroring the way the
// real `server/admin-api/app.ts` mounts the raw body parser only on the
// webhook path.

const TEST_API_KEY = 'sk_test_dummy_signature_validation_key';
const TEST_WEBHOOK_SECRET = 'whsec_test_signature_validation_secret';

function fakeEvent(): Stripe.Event {
  return {
    id: 'evt_test_123',
    object: 'event',
    api_version: '2026-02-25.clover',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_test_unused' } } as unknown as Stripe.Event.Data,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
  } as unknown as Stripe.Event;
}

function signEventBody(body: string, secret: string): { signature: string; body: string } {
  const stripe = new Stripe(TEST_API_KEY, { apiVersion: '2026-02-25.clover' as const });
  const header = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  return { signature: header, body };
}

describe('POST /billing/stripe-webhook — signature verification', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = TEST_API_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
  });

  async function buildApp(opts?: { mockHandler?: (event: Stripe.Event) => Promise<void> }) {
    // Stub the event handler so the test never touches the real DB.
    vi.doMock('../../platform/billing/stripe/webhook', async () => {
      const actual = await vi.importActual<typeof import('../../platform/billing/stripe/webhook')>(
        '../../platform/billing/stripe/webhook',
      );
      return {
        ...actual,
        handleStripeEvent: opts?.mockHandler ?? (async () => {}),
      };
    });

    const billingRouter = (await import('../../server/admin-api/routes/billing')).default;
    const app = express();
    // Match the real app.ts mount: raw body only on the webhook path.
    app.use('/billing/stripe-webhook', express.raw({ type: 'application/json' }));
    app.use(billingRouter);
    return app;
  }

  it('rejects with 400 when the stripe-signature header is missing', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(fakeEvent()));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Missing stripe-signature header' });
  });

  it('rejects with 400 when the signature is invalid', async () => {
    const app = await buildApp();
    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=this-is-not-a-valid-signature')
      .send(JSON.stringify(fakeEvent()));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid webhook signature' });
  });

  it('rejects with 400 when the body has been tampered after signing', async () => {
    const app = await buildApp();
    const original = JSON.stringify(fakeEvent());
    const { signature } = signEventBody(original, TEST_WEBHOOK_SECRET);
    const tampered = JSON.stringify({ ...fakeEvent(), type: 'invoice.payment_succeeded' });
    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(tampered);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid webhook signature' });
  });

  it('rejects with 400 when the signature was minted with a different secret', async () => {
    const app = await buildApp();
    const body = JSON.stringify(fakeEvent());
    const { signature } = signEventBody(body, 'whsec_completely_different_secret');
    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid webhook signature' });
  });

  it('fails-closed in production when STRIPE_WEBHOOK_SECRET is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const app = await buildApp();
    const body = JSON.stringify(fakeEvent());
    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=anything')
      .send(body);
    // The handler catches the thrown "STRIPE_WEBHOOK_SECRET is required" error
    // from getWebhookSecret() and converts it into a 400. Either way, the
    // request must NOT succeed (the test would be wrong if it ever returned
    // 200 here — that would mean a missing secret was treated as "skip
    // verification").
    expect(r.status).not.toBe(200);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a request with a valid signature and dispatches the event', async () => {
    const handler = vi.fn(async () => {});
    const app = await buildApp({ mockHandler: handler });

    const body = JSON.stringify(fakeEvent());
    const { signature } = signEventBody(body, TEST_WEBHOOK_SECRET);

    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.type).toBe('checkout.session.completed');
  });

  it('returns 500 (and does NOT swallow as success) when the handler throws after a valid signature', async () => {
    const handler = vi.fn(async () => { throw new Error('handler kaboom'); });
    const app = await buildApp({ mockHandler: handler });

    const body = JSON.stringify(fakeEvent());
    const { signature } = signEventBody(body, TEST_WEBHOOK_SECRET);

    const r = await request(app)
      .post('/billing/stripe-webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(body);

    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Webhook handler failed' });
  });
});
