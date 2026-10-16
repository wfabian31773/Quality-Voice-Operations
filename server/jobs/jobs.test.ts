import { describe, it, expect, vi } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runJob, nightlySteps } from './jobs';
import type { SchedulerDefinition } from '../../platform/runtime/schedulers';

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
});
