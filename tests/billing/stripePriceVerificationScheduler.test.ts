import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyStripePricesReport } from '../../platform/billing/stripe/verifyPrices';

const { verifyStripePricesMock, postToOpsSlackWebhookMock } = vi.hoisted(() => ({
  verifyStripePricesMock: vi.fn(),
  postToOpsSlackWebhookMock: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/verifyPrices', () => ({
  verifyStripePrices: verifyStripePricesMock,
}));

vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: postToOpsSlackWebhookMock,
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  __resetStripePriceVerificationStateForTests,
  getLatestStripePriceVerificationSnapshot,
  runStripePriceVerificationCycle,
} from '../../platform/billing/StripePriceVerificationScheduler';

function okReport(generatedAt = '2026-04-30T12:00:00.000Z'): VerifyStripePricesReport {
  return {
    summary: {
      total: 6,
      ok: 6,
      failed: 0,
      status: 'ok',
      message: 'All 6 STRIPE_PRICE_<TIER>_<INTERVAL> env vars verified.',
    },
    results: [],
    generatedAt,
  };
}

function failedReport(generatedAt = '2026-04-30T13:00:00.000Z'): VerifyStripePricesReport {
  return {
    summary: {
      total: 6,
      ok: 4,
      failed: 2,
      status: 'failed',
      message: '2 of 6 checks failed.',
    },
    results: [
      {
        envKey: 'STRIPE_PRICE_PRO_MONTHLY',
        plan: 'pro',
        interval: 'monthly',
        status: 'wrong-interval',
        priceId: 'price_pro_m',
        expectedInterval: 'month',
        actualInterval: 'year',
        unitAmountCents: 39_900,
        monthlyEquivalentCents: null,
        catalogMonthlyCents: 39_900,
        message: 'Price price_pro_m has recurring.interval=year, expected month',
      },
      {
        envKey: 'STRIPE_PRICE_ENTERPRISE_ANNUAL',
        plan: 'enterprise',
        interval: 'annual',
        status: 'missing-env',
        priceId: null,
        expectedInterval: 'year',
        actualInterval: null,
        unitAmountCents: null,
        monthlyEquivalentCents: null,
        catalogMonthlyCents: 99_900,
        message: 'STRIPE_PRICE_ENTERPRISE_ANNUAL is not set',
      },
    ],
    generatedAt,
  };
}

function noKeyReport(generatedAt = '2026-04-30T12:00:00.000Z'): VerifyStripePricesReport {
  return {
    summary: {
      total: 0,
      ok: 0,
      failed: 0,
      status: 'no-stripe-key',
      message: 'STRIPE_SECRET_KEY is not set — cannot verify prices.',
    },
    results: [],
    generatedAt,
  };
}

beforeEach(() => {
  verifyStripePricesMock.mockReset();
  postToOpsSlackWebhookMock.mockReset();
  postToOpsSlackWebhookMock.mockResolvedValue({ success: true });
  __resetStripePriceVerificationStateForTests();
});

afterEach(() => {
  __resetStripePriceVerificationStateForTests();
});

describe('runStripePriceVerificationCycle', () => {
  it('does not alert on a healthy first run', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport());

    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
    expect(snapshot.summary.status).toBe('ok');
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
    expect(snapshot.lastOkAt).toBe('2026-04-30T12:00:00.000Z');
    expect(snapshot.lastFailureAt).toBeNull();
    expect(getLatestStripePriceVerificationSnapshot()).toEqual(snapshot);
  });

  it('posts a Slack alert when the verifier regresses from ok to failed', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();
    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();

    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));
    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('Stripe price drift detected');
    expect(message.text).toContain('STRIPE_PRICE_PRO_MONTHLY');
    expect(message.text).toContain('wrong-interval');
    expect(message.text).toContain('STRIPE_PRICE_ENTERPRISE_ANNUAL');
    expect(message.text).toContain('missing-env');
    expect(snapshot.summary.status).toBe('failed');
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
    expect(snapshot.lastFailureAt).toBe('2026-04-30T12:00:00.000Z');
    expect(snapshot.lastOkAt).toBe('2026-04-30T11:00:00.000Z');
  });

  it('does not re-alert while the failed status persists across cycles', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();

    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));
    await runStripePriceVerificationCycle();
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);

    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T13:00:00.000Z'));
    const snapshot = await runStripePriceVerificationCycle();
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
    expect(snapshot.lastFailureAt).toBe('2026-04-30T13:00:00.000Z');
  });

  it('posts a recovery message when the verifier returns to ok after a failure', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));
    await runStripePriceVerificationCycle();
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);

    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T13:00:00.000Z'));
    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(2);
    const recoveryMessage = postToOpsSlackWebhookMock.mock.calls[1][0] as { text: string };
    expect(recoveryMessage.text).toContain('Stripe price drift recovered');
    expect(snapshot.summary.status).toBe('ok');
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
    expect(snapshot.lastFailureAt).toBeNull();
    expect(snapshot.lastOkAt).toBe('2026-04-30T13:00:00.000Z');
  });

  it('alerts on the very first observed failure (e.g. process restart)', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
  });

  it('treats `no-stripe-key` as not-configured: no alert, snapshot still updated', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(noKeyReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
    expect(snapshot.summary.status).toBe('no-stripe-key');
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
    expect(snapshot.lastOkAt).toBeNull();
    expect(snapshot.lastFailureAt).toBeNull();
    expect(getLatestStripePriceVerificationSnapshot()?.summary.status).toBe('no-stripe-key');
  });

  it('does not flip alert state when toggling between no-stripe-key and ok', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(noKeyReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T12:00:00.000Z'));
    await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
  });

  it('records the source of the cycle in the snapshot', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport());

    const snapshot = await runStripePriceVerificationCycle({ source: 'manual' });

    expect(snapshot.source).toBe('manual');
  });

  it('still records the snapshot when the Slack webhook fails to deliver', async () => {
    postToOpsSlackWebhookMock.mockResolvedValueOnce({
      success: false,
      error: 'HTTP 502',
    });
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(snapshot.summary.status).toBe('failed');
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(false);
    expect(getLatestStripePriceVerificationSnapshot()).toEqual(snapshot);
  });

  it('surfaces per-result stripe-error rows in the Slack alert', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();

    const stripeErrorReport: VerifyStripePricesReport = {
      summary: {
        total: 6,
        ok: 5,
        failed: 1,
        status: 'failed',
        message: '1 of 6 checks failed.',
      },
      results: [
        {
          envKey: 'STRIPE_PRICE_STARTER_MONTHLY',
          plan: 'starter',
          interval: 'monthly',
          status: 'stripe-error',
          priceId: 'price_starter_m',
          expectedInterval: 'month',
          actualInterval: null,
          unitAmountCents: null,
          monthlyEquivalentCents: null,
          catalogMonthlyCents: 9_900,
          message: 'Stripe error retrieving price_starter_m: No such price',
        },
      ],
      generatedAt: '2026-04-30T12:00:00.000Z',
    };

    verifyStripePricesMock.mockResolvedValueOnce(stripeErrorReport);
    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('STRIPE_PRICE_STARTER_MONTHLY');
    expect(message.text).toContain('stripe-error');
    expect(snapshot.summary.status).toBe('failed');
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
  });
});
