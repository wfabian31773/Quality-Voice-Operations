import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
// Keep the real probe out of the canary unit tests — we inject a fake runner.
vi.mock('./streamDiagnostic', () => ({ runRealtimeStreamDiagnostic: vi.fn() }));

import { startStreamCanary, stopStreamCanary, isStreamCanaryRunning } from './streamCanary';

const ENV_KEYS = ['STREAM_CANARY_ENABLED', 'STREAM_CANARY_MODE', 'STREAM_CANARY_INTERVAL_MS'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  stopStreamCanary();
  vi.useRealTimers();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('startStreamCanary', () => {
  it('is a no-op (returns false) when not enabled', () => {
    expect(startStreamCanary({ enabled: false })).toBe(false);
    expect(isStreamCanaryRunning()).toBe(false);
  });

  it('runs the probe on the configured interval when enabled', async () => {
    const runProbe = vi.fn().mockResolvedValue({ ok: true, correlationId: 'x', latencies: {} });
    expect(startStreamCanary({ enabled: true, intervalMs: 10_000, mode: 'handshake', runProbe })).toBe(true);
    expect(isStreamCanaryRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe).toHaveBeenCalledWith(expect.objectContaining({ mode: 'handshake' }));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(runProbe).toHaveBeenCalledTimes(3);
  });

  it('enforces the 10s minimum interval', async () => {
    const runProbe = vi.fn().mockResolvedValue({ ok: true, correlationId: 'x', latencies: {} });
    startStreamCanary({ enabled: true, intervalMs: 100, runProbe });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runProbe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  it('does not overlap runs — a slow probe is not re-entered', async () => {
    let resolveProbe: (v: unknown) => void = () => {};
    const runProbe = vi.fn().mockImplementation(() => new Promise((r) => { resolveProbe = r; }));
    startStreamCanary({ enabled: true, intervalMs: 10_000, runProbe });

    await vi.advanceTimersByTimeAsync(10_000); // first tick — probe in flight
    expect(runProbe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // second tick — skipped (still running)
    expect(runProbe).toHaveBeenCalledTimes(1);

    resolveProbe({ ok: true, correlationId: 'x', latencies: {} });
    await vi.advanceTimersByTimeAsync(10_000); // next tick after completion runs again
    expect(runProbe).toHaveBeenCalledTimes(2);
  });

  it('keeps running even if a probe throws', async () => {
    const runProbe = vi.fn().mockRejectedValue(new Error('boom'));
    startStreamCanary({ enabled: true, intervalMs: 10_000, runProbe });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(isStreamCanaryRunning()).toBe(true);
  });

  it('reads enablement and mode from the environment', async () => {
    process.env.STREAM_CANARY_ENABLED = 'true';
    process.env.STREAM_CANARY_MODE = 'full';
    const runProbe = vi.fn().mockResolvedValue({ ok: true, correlationId: 'x', latencies: {} });
    startStreamCanary({ intervalMs: 10_000, runProbe });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runProbe).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
  });
});

describe('stopStreamCanary', () => {
  it('stops the schedule', async () => {
    const runProbe = vi.fn().mockResolvedValue({ ok: true, correlationId: 'x', latencies: {} });
    startStreamCanary({ enabled: true, intervalMs: 10_000, runProbe });
    stopStreamCanary();
    expect(isStreamCanaryRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runProbe).not.toHaveBeenCalled();
  });
});
