import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyStripePricesReport } from '../../platform/billing/stripe/verifyPrices';

const {
  verifyStripePricesMock,
  postToOpsSlackWebhookMock,
  getLatestFailureScreenshotLinksMock,
} = vi.hoisted(() => ({
  verifyStripePricesMock: vi.fn(),
  postToOpsSlackWebhookMock: vi.fn(),
  getLatestFailureScreenshotLinksMock: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/verifyPrices', () => ({
  verifyStripePrices: verifyStripePricesMock,
}));

vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: postToOpsSlackWebhookMock,
}));

vi.mock('../../platform/billing/githubLiveBillingHealthArtifact', () => ({
  getLatestFailureScreenshotLinks: getLatestFailureScreenshotLinksMock,
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
  getLatestFailureScreenshotLinksMock.mockReset();
  // Default: GitHub integration unconfigured / no prior failure run —
  // the alert text should fall back to the no-link shape so the
  // existing behavioural tests stay focused on the regression
  // detection logic itself.
  getLatestFailureScreenshotLinksMock.mockResolvedValue(null);
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

  it('embeds the GitHub failure-screenshot artifact link into the regression alert', async () => {
    // Task #1476: on-call should be able to confirm the visual
    // regression directly from the Slack alert thread without
    // bouncing through the Admin console. When the GitHub integration
    // is configured and the live-billing-health workflow has a recent
    // failure run with a fresh artifact, the regression alert
    // includes a deep link to the artifact page.
    getLatestFailureScreenshotLinksMock.mockResolvedValueOnce({
      workflowRunHtmlUrl: 'https://github.com/qvo-org/qvo/actions/runs/999',
      artifactPageUrl:
        'https://github.com/qvo-org/qvo/actions/runs/999/artifacts/12345',
      artifactExpired: false,
      failureRunUpdatedAt: '2026-04-30T05:00:00Z',
    });
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(getLatestFailureScreenshotLinksMock).toHaveBeenCalledTimes(1);
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('Latest failure screenshot artifact:');
    expect(message.text).toContain(
      'https://github.com/qvo-org/qvo/actions/runs/999/artifacts/12345',
    );
    expect(snapshot.failureScreenshotLinks?.artifactPageUrl).toBe(
      'https://github.com/qvo-org/qvo/actions/runs/999/artifacts/12345',
    );
  });

  it('falls back to the workflow run URL when the failure artifact has expired', async () => {
    // 14-day artifact retention can age out a long-standing drift
    // before someone re-runs the workflow. The alert still surfaces
    // the failure run page so on-call has somewhere to land.
    getLatestFailureScreenshotLinksMock.mockResolvedValueOnce({
      workflowRunHtmlUrl: 'https://github.com/qvo-org/qvo/actions/runs/777',
      artifactPageUrl: null,
      artifactExpired: true,
      failureRunUpdatedAt: '2026-03-15T05:00:00Z',
    });
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    await runStripePriceVerificationCycle();

    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('artifact expired');
    expect(message.text).toContain('https://github.com/qvo-org/qvo/actions/runs/777');
    // No "screenshot artifact:" link line when the artifact is gone —
    // we use the "Latest failure run (artifact expired …)" line
    // instead so on-call isn't tricked into clicking a 404.
    expect(message.text).not.toContain('Latest failure screenshot artifact:');
  });

  it('still posts the regression alert when the GitHub integration is unconfigured', async () => {
    // Default beforeEach mock returns null (unconfigured / never
    // failed). The alert text should NOT include any "Latest failure"
    // line, the underlying drift alert must still fire, and the
    // snapshot should record `failureScreenshotLinks: null`.
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('Stripe price drift detected');
    expect(message.text).not.toContain('Latest failure');
    expect(snapshot.failureScreenshotLinks).toBeNull();
    expect(snapshot.slackNotified).toBe(true);
  });

  it('still posts the regression alert when the screenshot lookup throws', async () => {
    // Defence in depth: a transient GitHub API hiccup must NOT
    // swallow the underlying drift alert.
    getLatestFailureScreenshotLinksMock.mockRejectedValueOnce(
      new Error('GitHub API 503 — backend down'),
    );
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const message = postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('Stripe price drift detected');
    expect(message.text).not.toContain('Latest failure');
    expect(snapshot.failureScreenshotLinks).toBeNull();
    expect(snapshot.slackNotified).toBe(true);
  });

  it('does not call the GitHub failure-link helper on healthy / recovery / no-key cycles', async () => {
    // Recovery path: ok → failed → ok. The screenshot-link helper
    // should only be invoked on the *regression* edge (ok → failed).
    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T11:00:00.000Z'));
    await runStripePriceVerificationCycle();
    verifyStripePricesMock.mockResolvedValueOnce(failedReport('2026-04-30T12:00:00.000Z'));
    await runStripePriceVerificationCycle();
    expect(getLatestFailureScreenshotLinksMock).toHaveBeenCalledTimes(1);

    verifyStripePricesMock.mockResolvedValueOnce(okReport('2026-04-30T13:00:00.000Z'));
    const recoverySnapshot = await runStripePriceVerificationCycle();

    // Recovery cycle re-uses the standard recovery text (no failure
    // link section) and does not re-hit the GitHub API.
    expect(getLatestFailureScreenshotLinksMock).toHaveBeenCalledTimes(1);
    expect(recoverySnapshot.failureScreenshotLinks).toBeNull();
    const recoveryMessage = postToOpsSlackWebhookMock.mock.calls[1][0] as { text: string };
    expect(recoveryMessage.text).toContain('Stripe price drift recovered');
    expect(recoveryMessage.text).not.toContain('Latest failure');
  });

  it('records failureScreenshotLinks: null on the no-stripe-key path', async () => {
    verifyStripePricesMock.mockResolvedValueOnce(noKeyReport('2026-04-30T12:00:00.000Z'));

    const snapshot = await runStripePriceVerificationCycle();

    expect(getLatestFailureScreenshotLinksMock).not.toHaveBeenCalled();
    expect(snapshot.failureScreenshotLinks).toBeNull();
  });
});
