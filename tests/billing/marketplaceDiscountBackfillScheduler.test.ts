import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CliOptions,
  RowOutcome,
  RunBackfillResult,
  runBackfill,
} from '../../scripts/backfill-marketplace-purchase-discounts';

const { postToOpsSlackWebhookMock } = vi.hoisted(() => ({
  postToOpsSlackWebhookMock: vi.fn(),
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

// Stub the platform pool import so this scheduler test never reaches
// the live DB or env-validated stripe client. The scheduler injects
// `acquireDeps` per-call below, so the real `defaultAcquireDeps` is
// never invoked here — but the import graph still resolves.
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => {
    throw new Error('platform pool not used in this test');
  },
}));

import {
  __resetMarketplaceDiscountBackfillStateForTests,
  getLatestMarketplaceDiscountBackfillSnapshot,
  runMarketplaceDiscountBackfillCycle,
} from '../../platform/billing/MarketplaceDiscountBackfillScheduler';

type RunBackfillFn = typeof runBackfill;

interface FakeAcquireResult {
  released: boolean;
}

function fakeAcquireDeps(state: FakeAcquireResult = { released: false }) {
  return async () => ({
    deps: {
      stripe: {} as never,
      client: { query: vi.fn() } as never,
    },
    release: () => {
      state.released = true;
    },
  });
}

function makeRunBackfillFn(
  totals: RunBackfillResult['totals'],
  outcomes: RowOutcome[],
): RunBackfillFn {
  return (async (
    _client: unknown,
    _opts: CliOptions,
    _deps: unknown,
  ): Promise<RunBackfillResult> => ({
    totals,
    outcomes,
  })) as unknown as RunBackfillFn;
}

const ZERO_TOTALS: RunBackfillResult['totals'] = {
  scanned: 12,
  updated: 0,
  noDiscount: 12,
  noStripeLink: 0,
  apiFailures: 0,
};

function driftedTotals(updated: number): RunBackfillResult['totals'] {
  return {
    scanned: 100,
    updated,
    noDiscount: 90,
    noStripeLink: 5,
    apiFailures: 5 - updated > 0 ? 5 - updated : 0,
  };
}

function driftedOutcomes(ids: string[]): RowOutcome[] {
  return ids.map((id) => ({
    kind: 'updated',
    purchaseId: id,
    invoiceId: `inv_${id}`,
  }));
}

beforeEach(() => {
  postToOpsSlackWebhookMock.mockReset();
  postToOpsSlackWebhookMock.mockResolvedValue({ success: true });
  __resetMarketplaceDiscountBackfillStateForTests();
});

afterEach(() => {
  __resetMarketplaceDiscountBackfillStateForTests();
});

describe('runMarketplaceDiscountBackfillCycle', () => {
  it('does not alert when the dry-run reports zero drift', async () => {
    const released = { released: false };
    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(released),
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });

    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
    expect(snapshot.driftDetected).toBe(false);
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
    expect(snapshot.wouldUpdate).toBe(0);
    expect(snapshot.scanned).toBe(12);
    expect(snapshot.driftedPurchaseIds).toEqual([]);
    expect(released.released).toBe(true);
    expect(getLatestMarketplaceDiscountBackfillSnapshot()).toEqual(snapshot);
  });

  it('pages Slack on the rising edge from no-drift to drift with affected purchase ids', async () => {
    await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });
    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(2),
        driftedOutcomes(['pur_a', 'pur_b']),
      ),
    });

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    const text = (postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string })
      .text;
    expect(text).toContain('Marketplace discount drift detected');
    expect(text).toContain('2 purchase(s) need a backfill');
    expect(text).toContain('pur_a');
    expect(text).toContain('pur_b');
    expect(text).toContain('--apply');
    expect(snapshot.driftDetected).toBe(true);
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
    expect(snapshot.wouldUpdate).toBe(2);
    expect(snapshot.driftedPurchaseIds).toEqual(['pur_a', 'pur_b']);
    expect(snapshot.truncatedPurchaseIds).toBe(false);
  });

  it('does not re-alert while drift persists across cycles', async () => {
    await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(1),
        driftedOutcomes(['pur_a']),
      ),
    });
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(3),
        driftedOutcomes(['pur_a', 'pur_b', 'pur_c']),
      ),
    });

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    expect(snapshot.driftDetected).toBe(true);
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
    expect(snapshot.wouldUpdate).toBe(3);
  });

  it('posts a recovery message when drift clears', async () => {
    await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(2),
        driftedOutcomes(['pur_a', 'pur_b']),
      ),
    });
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(2);
    const recoveryText = (
      postToOpsSlackWebhookMock.mock.calls[1][0] as { text: string }
    ).text;
    expect(recoveryText).toContain('Marketplace discount drift recovered');
    expect(snapshot.driftDetected).toBe(false);
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
  });

  it('alerts on the very first observed drift (process restart)', async () => {
    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(1),
        driftedOutcomes(['pur_a']),
      ),
    });

    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(true);
  });

  it('truncates the affected-id list in the Slack alert when above the cap', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `pur_${i + 1}`);
    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(driftedTotals(40), driftedOutcomes(ids)),
    });

    expect(snapshot.truncatedPurchaseIds).toBe(true);
    expect(snapshot.driftedPurchaseIds).toHaveLength(25);
    expect(snapshot.driftedPurchaseIds[0]).toBe('pur_1');
    const text = (postToOpsSlackWebhookMock.mock.calls[0][0] as { text: string })
      .text;
    expect(text).toContain('and 15 more (truncated)');
    expect(text).toContain('pur_25');
    expect(text).not.toContain('pur_26');
  });

  it('refuses to write even if a misconfigured deps factory tries: hard-codes apply=false', async () => {
    let observedApply: boolean | null = null;
    const runBackfillFn = (async (
      _client: unknown,
      opts: CliOptions,
      _deps: unknown,
    ): Promise<RunBackfillResult> => {
      observedApply = opts.apply;
      return { totals: ZERO_TOTALS, outcomes: [] };
    }) as unknown as RunBackfillFn;

    await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn,
      // Even with a hostile override, the scheduler must force apply=false.
      options: { apply: true, batchSize: 50, limit: 10, tenantId: 't1' },
    });

    expect(observedApply).toBe(false);
  });

  it('records the manual source in the snapshot', async () => {
    const snapshot = await runMarketplaceDiscountBackfillCycle({
      source: 'manual',
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });
    expect(snapshot.source).toBe('manual');
  });

  it('still records the snapshot when Slack delivery fails', async () => {
    postToOpsSlackWebhookMock.mockResolvedValueOnce({
      success: false,
      error: 'HTTP 502',
    });
    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(1),
        driftedOutcomes(['pur_a']),
      ),
    });

    expect(snapshot.driftDetected).toBe(true);
    expect(snapshot.regressed).toBe(true);
    expect(snapshot.slackNotified).toBe(false);
    expect(getLatestMarketplaceDiscountBackfillSnapshot()).toEqual(snapshot);
  });

  it('skips with reason no-stripe-key when STRIPE_SECRET_KEY is missing', async () => {
    const acquireDeps = async () => {
      throw new Error(
        'STRIPE_SECRET_KEY is not configured. Set the secret to enable billing features.',
      );
    };

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps,
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });

    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
    expect(snapshot.skippedReason).toBe('no-stripe-key');
    expect(snapshot.driftDetected).toBe(false);
    expect(snapshot.regressed).toBe(false);
    expect(snapshot.slackNotified).toBe(false);
  });

  it('skips with reason deps-init-failed for other acquireDeps errors and does not move the alert baseline', async () => {
    const acquireDeps = async () => {
      throw new Error('database pool exhausted');
    };

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps,
      runBackfillFn: makeRunBackfillFn(ZERO_TOTALS, []),
    });

    expect(snapshot.skippedReason).toBe('deps-init-failed');
    expect(snapshot.skippedError).toContain('database pool exhausted');
    expect(snapshot.regressed).toBe(false);

    // Subsequent cycles can still alert on first observed drift —
    // the skipped run did not poison previousDriftDetected.
    const next = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: fakeAcquireDeps(),
      runBackfillFn: makeRunBackfillFn(
        driftedTotals(1),
        driftedOutcomes(['pur_z']),
      ),
    });
    expect(next.regressed).toBe(true);
    expect(postToOpsSlackWebhookMock).toHaveBeenCalledTimes(1);
  });

  it('records a backfill-failed snapshot when runBackfill throws and releases the client', async () => {
    const released = { released: false };
    const acquire = fakeAcquireDeps(released);
    const runBackfillFn = (async () => {
      throw new Error('connection reset');
    }) as unknown as RunBackfillFn;

    const snapshot = await runMarketplaceDiscountBackfillCycle({
      acquireDeps: acquire,
      runBackfillFn,
    });

    expect(snapshot.skippedReason).toBe('backfill-failed');
    expect(snapshot.skippedError).toContain('connection reset');
    expect(released.released).toBe(true);
    expect(postToOpsSlackWebhookMock).not.toHaveBeenCalled();
  });
});
