import { afterEach, describe, expect, it, vi } from 'vitest';

const release = vi.hoisted(() => vi.fn());
vi.mock('./send', () => ({ releaseDueDeferredSms: release }));

import {
  SMS_DEFERRED_RELEASE_INTERVAL_MS,
  runSmsDeferredReleaseCycle,
  smsDeferredReleaseInFlight,
  startSmsDeferredReleaseScheduler,
  stopSmsDeferredReleaseScheduler,
} from './deferredReleaseScheduler';

const SUMMARY = { claimed: 0, reclaimed: 0, sent: 0, deferred: 0, rateLimited: 0, retried: 0, suppressed: 0, failed: 0 };

afterEach(() => {
  stopSmsDeferredReleaseScheduler();
  vi.useRealTimers();
  release.mockReset();
});

describe('sms deferred release scheduler', () => {
  it('runs releaseDueDeferredSms every 60 s until stopped', async () => {
    vi.useFakeTimers();
    release.mockResolvedValue(SUMMARY);
    expect(SMS_DEFERRED_RELEASE_INTERVAL_MS).toBe(60_000);
    startSmsDeferredReleaseScheduler();
    startSmsDeferredReleaseScheduler(); // idempotent
    await vi.advanceTimersByTimeAsync(59_999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(release).toHaveBeenCalledTimes(2);
    stopSmsDeferredReleaseScheduler();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('never overlaps passes and reports inFlight while one runs', async () => {
    let finish!: (v: typeof SUMMARY) => void;
    release.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const first = runSmsDeferredReleaseCycle();
    expect(smsDeferredReleaseInFlight()).toBe(true);
    expect(await runSmsDeferredReleaseCycle()).toBeNull();
    finish({ ...SUMMARY, claimed: 1, sent: 1 });
    expect(await first).toMatchObject({ sent: 1 });
    expect(smsDeferredReleaseInFlight()).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing pass so the interval keeps running', async () => {
    release.mockRejectedValueOnce(new Error('db down'));
    expect(await runSmsDeferredReleaseCycle()).toBeNull();
    expect(smsDeferredReleaseInFlight()).toBe(false);
  });
});
