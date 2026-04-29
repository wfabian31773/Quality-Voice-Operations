import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: poolQueryMock }),
}));

import {
  CRM_STALE_CACHE_RETENTION_DEFAULTS,
  getCrmStaleCacheRetentionDays,
  runCrmStaleCacheRetentionCycle,
  startCrmStaleCacheRetentionScheduler,
  stopCrmStaleCacheRetentionScheduler,
} from './CrmStaleCacheRetentionScheduler';

describe('CrmStaleCacheRetentionScheduler', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    delete process.env.CRM_STALE_CACHE_RETENTION_DAYS;
  });

  afterEach(() => {
    stopCrmStaleCacheRetentionScheduler();
    vi.useRealTimers();
    delete process.env.CRM_STALE_CACHE_RETENTION_DAYS;
  });

  describe('getCrmStaleCacheRetentionDays', () => {
    it('returns the documented 30-day default when the env var is unset', () => {
      expect(getCrmStaleCacheRetentionDays()).toBe(30);
      expect(CRM_STALE_CACHE_RETENTION_DEFAULTS.retentionDays).toBe(30);
    });

    it('honours a positive integer override from CRM_STALE_CACHE_RETENTION_DAYS', () => {
      process.env.CRM_STALE_CACHE_RETENTION_DAYS = '14';
      expect(getCrmStaleCacheRetentionDays()).toBe(14);
    });

    it('falls back to the default when the override is blank, zero, negative, or non-numeric', () => {
      for (const raw of ['', '0', '-5', 'abc', 'NaN']) {
        process.env.CRM_STALE_CACHE_RETENTION_DAYS = raw;
        expect(getCrmStaleCacheRetentionDays()).toBe(30);
      }
    });
  });

  describe('runCrmStaleCacheRetentionCycle', () => {
    it('deletes rows older than the configured retention horizon and reports the count', async () => {
      poolQueryMock.mockResolvedValueOnce({ rowCount: 12, rows: [] });

      const result = await runCrmStaleCacheRetentionCycle();

      expect(poolQueryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = poolQueryMock.mock.calls[0];
      // Pin the exact DELETE shape so a future refactor cannot silently widen
      // the window or zero-out retention without updating this test.
      expect(String(sql)).toMatch(/DELETE FROM crm_stale_cache_scrubs/);
      expect(String(sql)).toMatch(/occurred_at\s*<\s*NOW\(\)\s*-\s*make_interval\(days\s*=>\s*\$1::int\)/);
      expect(params).toEqual([30]);
      expect(result).toEqual({ deleted: 12, retentionDays: 30 });
    });

    it('uses the env-var override when running with no explicit option', async () => {
      process.env.CRM_STALE_CACHE_RETENTION_DAYS = '7';
      poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await runCrmStaleCacheRetentionCycle();

      expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [7]);
      expect(result).toEqual({ deleted: 0, retentionDays: 7 });
    });

    it('honours an explicitly-supplied retentionDays option ahead of the env var', async () => {
      process.env.CRM_STALE_CACHE_RETENTION_DAYS = '7';
      poolQueryMock.mockResolvedValueOnce({ rowCount: 3, rows: [] });

      const result = await runCrmStaleCacheRetentionCycle({ retentionDays: 60 });

      expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [60]);
      expect(result).toEqual({ deleted: 3, retentionDays: 60 });
    });

    it('clamps a non-positive retentionDays option to a minimum of 1 day so the window can never be widened to "everything"', async () => {
      poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await runCrmStaleCacheRetentionCycle({ retentionDays: 0 });

      expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [1]);
      expect(result.retentionDays).toBe(1);
    });

    it('returns a zero-deleted result and does not throw when the DELETE fails', async () => {
      poolQueryMock.mockRejectedValueOnce(new Error('db down'));

      const result = await runCrmStaleCacheRetentionCycle({ retentionDays: 10 });

      expect(result).toEqual({ deleted: 0, retentionDays: 10 });
    });

    it('treats a missing rowCount as zero deleted rows', async () => {
      poolQueryMock.mockResolvedValueOnce({ rows: [] });

      const result = await runCrmStaleCacheRetentionCycle({ retentionDays: 30 });

      expect(result.deleted).toBe(0);
    });
  });

  describe('start/stop wiring', () => {
    it('start is idempotent — a second start call does not register additional timers', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      startCrmStaleCacheRetentionScheduler(60_000);
      const firstIntervalCalls = setIntervalSpy.mock.calls.length;
      const firstTimeoutCalls = setTimeoutSpy.mock.calls.length;
      startCrmStaleCacheRetentionScheduler(60_000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(firstIntervalCalls);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(firstTimeoutCalls);

      stopCrmStaleCacheRetentionScheduler();
      stopCrmStaleCacheRetentionScheduler();
    });

    it('stop clears both the initial-delay timer and the recurring interval', () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      startCrmStaleCacheRetentionScheduler(60_000);
      stopCrmStaleCacheRetentionScheduler();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});
