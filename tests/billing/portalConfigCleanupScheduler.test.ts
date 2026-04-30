import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runDiscountPortalConfigCleanupMock } = vi.hoisted(() => ({
  runDiscountPortalConfigCleanupMock: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/portalConfigCleanup', () => ({
  runDiscountPortalConfigCleanup: runDiscountPortalConfigCleanupMock,
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
  __resetPortalConfigCleanupSnapshotForTests,
  getLatestPortalConfigCleanupSnapshot,
  runPortalConfigCleanupCycle,
} from '../../platform/billing/PortalConfigCleanupScheduler';

beforeEach(() => {
  runDiscountPortalConfigCleanupMock.mockReset();
  __resetPortalConfigCleanupSnapshotForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runPortalConfigCleanupCycle', () => {
  it('records a success snapshot when the underlying cycle resolves', async () => {
    runDiscountPortalConfigCleanupMock.mockResolvedValue({
      startedAt: '2026-04-30T10:00:00.000Z',
      finishedAt: '2026-04-30T10:00:01.000Z',
      durationMs: 1_000,
      examinedConfigurations: 5,
      candidateConfigurations: 2,
      customersConsidered: 12,
      activeHeadlinesCount: 1,
      activeCouponsCount: 1,
      deactivatedConfigurationIds: ['bpc_dead'],
      keptConfigurationIds: ['bpc_alive'],
      errors: [],
      truncatedActiveSet: false,
    });

    const snapshot = await runPortalConfigCleanupCycle({ source: 'manual' });

    expect(snapshot.status).toBe('success');
    expect(snapshot.source).toBe('manual');
    expect(snapshot.errorMessage).toBeNull();
    expect(snapshot.result?.deactivatedConfigurationIds).toEqual(['bpc_dead']);
    expect(getLatestPortalConfigCleanupSnapshot()).toEqual(snapshot);
  });

  it('records a failure snapshot and never throws when the underlying cycle rejects', async () => {
    runDiscountPortalConfigCleanupMock.mockRejectedValue(
      new Error('stripe is having a bad day'),
    );

    const snapshot = await runPortalConfigCleanupCycle();

    expect(snapshot.status).toBe('failure');
    expect(snapshot.source).toBe('scheduled');
    expect(snapshot.errorMessage).toBe('stripe is having a bad day');
    expect(snapshot.result).toBeNull();
    expect(getLatestPortalConfigCleanupSnapshot()).toEqual(snapshot);
  });
});
