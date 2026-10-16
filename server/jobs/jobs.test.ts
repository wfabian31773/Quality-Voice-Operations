import { describe, it, expect, vi } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runJob, nightlySteps } from './jobs';
import { isPrivilegedScope } from '../../platform/db/tenantScope';
import { SCHEDULERS, type SchedulerDefinition } from '../../platform/runtime/schedulers';

describe('runJob', () => {
  it('runs every step in order and succeeds', async () => {
    const order: string[] = [];
    const r = await runJob('nightly', [
      { name: 'a', run: async () => void order.push('a') },
      { name: 'b', run: async () => void order.push('b') },
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true]);
  });

  it('runs each step in the privileged DB scope', async () => {
    let privileged = false;
    await runJob('nightly', [{ name: 'a', run: async () => { privileged = isPrivilegedScope(); } }]);
    expect(privileged).toBe(true);
    expect(isPrivilegedScope()).toBe(false);
  });

  it('keeps going after a failing step but fails the job', async () => {
    const ran = vi.fn();
    const r = await runJob('nightly', [
      { name: 'boom', run: async () => { throw new Error('stripe down'); } },
      { name: 'after', run: async () => ran() },
    ]);
    expect(ran).toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ name: 'boom', ok: false, error: 'stripe down' });
  });

  it('fails the step and the job when a resolved result reports failure', async () => {
    const ran = vi.fn();
    const r = await runJob('nightly', [
      {
        name: 'cleanup',
        run: async () => ({ status: 'failure' }),
        failed: (v) => ((v as { status: string }).status === 'failure' ? 'cleanup failed' : null),
      },
      { name: 'after', run: async () => ran() },
    ]);
    expect(ran).toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ name: 'cleanup', ok: false, error: 'cleanup failed' });
    expect(r.steps[1]).toMatchObject({ name: 'after', ok: true });
  });

  it('passes the step when a resolved result reports success', async () => {
    const r = await runJob('nightly', [
      {
        name: 'cleanup',
        run: async () => ({ status: 'success' }),
        failed: (v) => ((v as { status: string }).status === 'failure' ? 'cleanup failed' : null),
      },
    ]);
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ name: 'cleanup', ok: true });
  });
});

describe('nightlyFailed interpreters', () => {
  const failedFor = (name: string) => {
    const fn = SCHEDULERS.find((s) => s.name === name)?.nightlyFailed;
    if (!fn) throw new Error(`no nightlyFailed for ${name}`);
    return fn;
  };

  it.each([
    ['portal-config-cleanup', { status: 'failure' }, { status: 'success' }],
    ['billing-reconciliation', { errors: 2 }, { errors: 0 }],
    ['plan-recommendation-digest', { failed: 1 }, { failed: 0 }],
    ['recommendation-direction-digest', { failed: true }, { failed: false }],
    ['encryption-reminder', { failed: 1 }, { failed: 0 }],
    ['connector-stale-alert', { snapshotLoadFailed: true }, { staleCount: 3 }],
    ['tenant-isolation', { skippedReason: 'db down', failed: 0 }, { ranTests: true, failed: 2 }],
  ])('%s: reported failure fails, success passes', (name, bad, good) => {
    const fn = failedFor(name);
    expect(fn(bad)).toEqual(expect.any(String));
    expect(fn(bad)).not.toContain('db down');
    expect(fn(good)).toBeNull();
  });

  it('is only set on schedulers that run nightly', () => {
    for (const s of SCHEDULERS) if (s.nightlyFailed) expect(typeof s.nightly).toBe('function');
  });
});

describe('nightlySteps', () => {
  it('maps registry entries with a nightly body, in order', async () => {
    const calls: string[] = [];
    const reg: SchedulerDefinition[] = [
      { name: 'interval-only', start: () => {}, stop: () => {} },
      { name: 'daily-a', start: () => {}, stop: () => {}, nightly: async () => void calls.push('a') },
      { name: 'daily-b', start: () => {}, stop: () => {}, nightly: async () => void calls.push('b') },
    ];
    const steps = nightlySteps(reg);
    expect(steps.map((s) => s.name)).toEqual(['daily-a', 'daily-b']);
    for (const s of steps) await s.run();
    expect(calls).toEqual(['a', 'b']);
  });

  it('carries the nightlyFailed check onto the step', async () => {
    const nightlyFailed = (r: unknown) => ((r as { errors: number }).errors > 0 ? 'errors' : null);
    const [step] = nightlySteps([
      { name: 'daily', start: () => {}, stop: () => {}, nightly: async () => ({ errors: 1 }), nightlyFailed },
    ]);
    const r = await runJob('nightly', [step]);
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ ok: false, error: 'errors' });
  });
});
