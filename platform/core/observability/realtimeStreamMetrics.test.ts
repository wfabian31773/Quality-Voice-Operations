import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

vi.mock('../logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('./errorLogger', () => ({ logError: a.logErrorMock }));

import {
  recordStreamObservation, getRealtimeStreamMetrics, __resetRealtimeStreamMetricsForTests, STREAM_STAGES,
} from './realtimeStreamMetrics';

beforeEach(() => {
  a.logErrorMock.mockReset();
  __resetRealtimeStreamMetricsForTests();
});

describe('getRealtimeStreamMetrics', () => {
  it('starts empty with a 100% success rate', () => {
    const snap = getRealtimeStreamMetrics();
    expect(snap.attempts).toBe(0);
    expect(snap.successRate).toBe(1);
    for (const stage of STREAM_STAGES) expect(snap.latency[stage].count).toBe(0);
  });
});

describe('recordStreamObservation', () => {
  it('accumulates attempts, successes, and per-stage latency', () => {
    recordStreamObservation({ source: 'probe', outcome: 'success', latencies: { ws_connect: 10, first_audio: 200, total: 250 } });
    recordStreamObservation({ source: 'live', outcome: 'success', latencies: { ws_connect: 30, first_audio: 400, total: 460 } });
    const snap = getRealtimeStreamMetrics();
    expect(snap.attempts).toBe(2);
    expect(snap.successes).toBe(2);
    expect(snap.successRate).toBe(1);
    expect(snap.bySource.probe.attempts).toBe(1);
    expect(snap.bySource.live.attempts).toBe(1);
    expect(snap.latency.ws_connect.count).toBe(2);
    expect(snap.latency.ws_connect.maxMs).toBe(30);
    expect(snap.latency.first_audio.avgMs).toBe(300);
    expect(snap.latency.first_audio.p95Ms).toBeGreaterThanOrEqual(200);
  });

  it('tracks failures by stage and reason', () => {
    recordStreamObservation({ source: 'probe', outcome: 'failure', failureStage: 'ws_connect', failureReason: 'auth_rejected', latencies: {} });
    const snap = getRealtimeStreamMetrics();
    expect(snap.failures).toBe(1);
    expect(snap.successRate).toBe(0);
    expect(snap.failureCounts.auth_rejected).toBe(1);
    expect(snap.failureByStage.ws_connect).toBe(1);
    expect(snap.lastFailureAt).not.toBeNull();
  });

  it('defaults a missing failure reason to "other"', () => {
    recordStreamObservation({ source: 'live', outcome: 'failure', latencies: {} });
    expect(getRealtimeStreamMetrics().failureCounts.other).toBe(1);
  });

  it('fires a critical alert once the per-minute failure threshold is crossed', () => {
    for (let i = 0; i < 5; i++) {
      recordStreamObservation({ source: 'probe', outcome: 'failure', failureStage: 'session_setup', failureReason: 'setup_error', latencies: {} });
    }
    expect(a.logErrorMock).toHaveBeenCalledWith(null, 'critical', expect.stringContaining('failure spike'), expect.objectContaining({ errorCode: 'realtime_stream_failure_spike' }));
    expect(getRealtimeStreamMetrics().failureRatePerMinute).toBe(5);
  });

  it('raises a latency-degradation alert when a stage p95 exceeds its ceiling', () => {
    // first_audio ceiling is 8000ms; feed a batch of slow samples.
    for (let i = 0; i < 6; i++) {
      recordStreamObservation({ source: 'live', outcome: 'success', latencies: { first_audio: 9000 } });
    }
    expect(a.logErrorMock).toHaveBeenCalledWith(null, 'warning', expect.stringContaining('latency degraded'), expect.objectContaining({ errorCode: 'realtime_stream_first_audio_latency' }));
  });

  it('never throws on a malformed observation', () => {
    expect(() => recordStreamObservation({ source: 'probe', outcome: 'success', latencies: { ws_connect: NaN, total: -5 } })).not.toThrow();
    // NaN / negative latencies are ignored rather than recorded.
    expect(getRealtimeStreamMetrics().latency.ws_connect.count).toBe(0);
  });
});
