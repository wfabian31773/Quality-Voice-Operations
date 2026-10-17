import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../core/types';

const h = vi.hoisted(() => ({
  expireStaleHolds: vi.fn(),
}));

vi.mock('./holds', () => ({ expireStaleHolds: h.expireStaleHolds }));

import {
  HOLD_SWEEP_BATCH,
  HOLD_SWEEP_INTERVAL_MS,
  holdSweepInFlight,
  runHoldSweepCycle,
  startHoldSweeper,
  stopHoldSweeper,
  type HoldSweepDeps,
  type StaleHoldGroup,
} from './holdSweeper';

function deps(groups: StaleHoldGroup[] | (() => Promise<StaleHoldGroup[]>)) {
  const txFor = new Map<string, TenantTx>();
  const d = {
    findStaleGroups: vi.fn(typeof groups === 'function' ? groups : async () => groups),
    withTenantTx: vi.fn(async <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => {
      const tx = { query: vi.fn() } as unknown as TenantTx;
      txFor.set(tenantId, tx);
      return fn(tx);
    }),
    logger: { info: vi.fn(), error: vi.fn() },
  };
  return { d: d as unknown as HoldSweepDeps & typeof d, txFor };
}

afterEach(() => {
  stopHoldSweeper();
  h.expireStaleHolds.mockReset();
  vi.useRealTimers();
});

describe('runHoldSweepCycle', () => {
  it('releases each group through expireStaleHolds in its own tenant transaction', async () => {
    h.expireStaleHolds
      .mockResolvedValueOnce({ expiredBookingIds: ['b1', 'b2'] })
      .mockResolvedValueOnce({ expiredBookingIds: ['b3'] });
    const { d, txFor } = deps([
      { tenantId: 't1', providerId: 'p1', resourceId: null },
      { tenantId: 't2', providerId: null, resourceId: 'r1' },
    ]);

    const result = await runHoldSweepCycle(d);

    expect(result).toEqual({ skipped: false, groups: 2, released: 3, failed: 0 });
    expect(d.findStaleGroups).toHaveBeenCalledWith(HOLD_SWEEP_BATCH);
    expect(d.withTenantTx.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
    expect(h.expireStaleHolds.mock.calls).toEqual([
      [txFor.get('t1'), 't1', 'p1', { resourceId: null }],
      [txFor.get('t2'), 't2', null, { resourceId: 'r1' }],
    ]);
    expect(d.logger.info).toHaveBeenCalledWith('Released expired holds', { released: 3, groups: 2 });
    expect(d.logger.error).not.toHaveBeenCalled();
  });

  it('stays quiet when there is nothing to release', async () => {
    const { d } = deps([]);
    expect(await runHoldSweepCycle(d)).toEqual({ skipped: false, groups: 0, released: 0, failed: 0 });
    expect(d.logger.info).not.toHaveBeenCalled();
  });

  it('skips a sweep that would overlap one still running', async () => {
    let release!: (groups: StaleHoldGroup[]) => void;
    const { d } = deps(() => new Promise((resolve) => { release = resolve; }));
    const first = runHoldSweepCycle(d);
    expect(holdSweepInFlight()).toBe(true);
    expect(await runHoldSweepCycle(d)).toEqual({ skipped: true, groups: 0, released: 0, failed: 0 });
    expect(d.findStaleGroups).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    expect(holdSweepInFlight()).toBe(false);
  });

  it('logs and swallows a failing group, then keeps going', async () => {
    const overlap = Object.assign(new Error('conflicting key value violates exclusion constraint'), { code: '23P01' });
    h.expireStaleHolds.mockRejectedValueOnce(overlap).mockResolvedValueOnce({ expiredBookingIds: ['b9'] });
    const { d } = deps([
      { tenantId: 't1', providerId: 'p1', resourceId: null },
      { tenantId: 't2', providerId: 'p2', resourceId: null },
    ]);
    const result = await runHoldSweepCycle(d);
    expect(result).toEqual({ skipped: false, groups: 2, released: 1, failed: 1 });
    expect(d.logger.error).toHaveBeenCalledWith('Failed to release expired holds', {
      tenantId: 't1',
      error: expect.stringContaining('exclusion constraint'),
    });
  });

  it('logs and swallows a failed lookup, and clears the in-flight flag', async () => {
    const { d } = deps(async () => { throw new Error('db down'); });
    await expect(runHoldSweepCycle(d)).resolves.toEqual({ skipped: false, groups: 0, released: 0, failed: 1 });
    expect(d.logger.error).toHaveBeenCalledWith('Hold sweep failed', { error: 'Error: db down' });
    expect(holdSweepInFlight()).toBe(false);
  });
});

describe('startHoldSweeper / stopHoldSweeper', () => {
  it('sweeps about every 60 s until stopped, and starting twice keeps one timer', async () => {
    vi.useFakeTimers();
    const { d } = deps([]);
    expect(HOLD_SWEEP_INTERVAL_MS).toBe(60_000);
    startHoldSweeper(HOLD_SWEEP_INTERVAL_MS, d);
    startHoldSweeper(HOLD_SWEEP_INTERVAL_MS, d);
    expect(d.findStaleGroups).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.findStaleGroups).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.findStaleGroups).toHaveBeenCalledTimes(3);
    stopHoldSweeper();
    stopHoldSweeper();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(d.findStaleGroups).toHaveBeenCalledTimes(3);
  });
});
