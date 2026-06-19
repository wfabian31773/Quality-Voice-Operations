/**
 * In-process telemetry for the realtime voice-stream path (Twilio Media
 * Streams ↔ OpenAI Realtime). Captures the numbers that matter for this
 * path — per-stage latency (connect, session setup, time-to-first-audio,
 * end-to-end) and failures bucketed by the stage + reason they occurred —
 * for both synthetic diagnostic probes (`source: 'probe'`) and real
 * production sessions (`source: 'live'`).
 *
 * Mirrors the rolling-window + alert-on-spike design of
 * `server/voice-gateway/middleware/twilioSignatureMetrics.ts` so ops get a
 * consistent snapshot shape across the gateway. It is deliberately
 * dependency-light (logger + the shared error logger for alerts) and holds
 * no PII: only timings, counts, and short reason codes.
 *
 * Exposed to operators via `GET /admin/diagnostics/realtime-stream/metrics`
 * on the voice gateway.
 */
import { createLogger } from '../logger';
import { logError } from './errorLogger';

const logger = createLogger('REALTIME_STREAM_METRICS');

/** Stages of a realtime stream attempt, in the order they occur. */
export type StreamStage = 'ws_connect' | 'session_setup' | 'first_audio' | 'total';

export const STREAM_STAGES: StreamStage[] = ['ws_connect', 'session_setup', 'first_audio', 'total'];

/** Where an observation came from — a synthetic probe or a real call. */
export type StreamSource = 'probe' | 'live';

/**
 * Short, enumerated failure reasons so the snapshot stays bounded and
 * greppable. Anything not covered maps to `other`.
 */
export type StreamFailureReason =
  | 'connect_timeout'
  | 'connect_refused'
  | 'auth_rejected'
  | 'bad_handshake'
  | 'setup_timeout'
  | 'setup_error'
  | 'first_audio_timeout'
  | 'closed_early'
  | 'other';

export const STREAM_FAILURE_REASONS: StreamFailureReason[] = [
  'connect_timeout', 'connect_refused', 'auth_rejected', 'bad_handshake',
  'setup_timeout', 'setup_error', 'first_audio_timeout', 'closed_early', 'other',
];

export interface StreamObservation {
  source: StreamSource;
  /** Per-stage latency in ms. Omit a stage that wasn't reached. */
  latencies: Partial<Record<StreamStage, number>>;
  outcome: 'success' | 'failure';
  /** For failures: the stage that failed and a short reason code. */
  failureStage?: StreamStage;
  failureReason?: StreamFailureReason;
  /** Optional correlation id from the probe/session for log stitching. */
  correlationId?: string;
}

// --- Alerting thresholds (per rolling minute) ----------------------------
const ALERT_FAILURE_RATE_PER_MIN = 5;
// p95 latency ceilings (ms) above which we raise a latency-degradation alert.
const ALERT_P95_MS: Record<StreamStage, number> = {
  ws_connect: 1_500,
  session_setup: 6_000,
  first_audio: 8_000,
  total: 12_000,
};
const ALERT_COOLDOWN_MS = 5 * 60_000;
const SAMPLE_RING_SIZE = 512;
const BUCKET_MS = 60_000;
const BUCKET_COUNT = 60;

interface StageStats {
  count: number;
  sumMs: number;
  maxMs: number;
  /** Bounded ring of recent samples for percentile estimates. */
  samples: number[];
}

interface MinuteBucket {
  startedAt: number;
  attempts: number;
  failures: number;
}

interface State {
  startedAt: number;
  attempts: number;
  successes: number;
  failures: number;
  bySource: Record<StreamSource, { attempts: number; successes: number; failures: number }>;
  stageStats: Record<StreamStage, StageStats>;
  failureCounts: Record<StreamFailureReason, number>;
  failureByStage: Record<StreamStage, number>;
  lastFailureAt: number | null;
  lastObservationAt: number | null;
  buckets: MinuteBucket[];
  lastAlertAt: number;
  lastLatencyAlertAt: Record<StreamStage, number>;
}

function emptyStageStats(): StageStats {
  return { count: 0, sumMs: 0, maxMs: 0, samples: [] };
}

function freshState(): State {
  const now = Date.now();
  return {
    startedAt: now,
    attempts: 0,
    successes: 0,
    failures: 0,
    bySource: {
      probe: { attempts: 0, successes: 0, failures: 0 },
      live: { attempts: 0, successes: 0, failures: 0 },
    },
    stageStats: {
      ws_connect: emptyStageStats(),
      session_setup: emptyStageStats(),
      first_audio: emptyStageStats(),
      total: emptyStageStats(),
    },
    failureCounts: {
      connect_timeout: 0, connect_refused: 0, auth_rejected: 0, bad_handshake: 0,
      setup_timeout: 0, setup_error: 0, first_audio_timeout: 0, closed_early: 0, other: 0,
    },
    failureByStage: { ws_connect: 0, session_setup: 0, first_audio: 0, total: 0 },
    lastFailureAt: null,
    lastObservationAt: null,
    buckets: [{ startedAt: now, attempts: 0, failures: 0 }],
    lastAlertAt: 0,
    lastLatencyAlertAt: { ws_connect: 0, session_setup: 0, first_audio: 0, total: 0 },
  };
}

let state: State = freshState();

function rotateBuckets(now: number): void {
  let head = state.buckets[state.buckets.length - 1];
  while (now - head.startedAt >= BUCKET_MS) {
    state.buckets.push({ startedAt: head.startedAt + BUCKET_MS, attempts: 0, failures: 0 });
    if (state.buckets.length > BUCKET_COUNT) state.buckets.shift();
    head = state.buckets[state.buckets.length - 1];
  }
}

function recordSample(stage: StreamStage, ms: number): void {
  const s = state.stageStats[stage];
  s.count += 1;
  s.sumMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  s.samples.push(ms);
  if (s.samples.length > SAMPLE_RING_SIZE) s.samples.shift();
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

/** Record one realtime-stream attempt (probe or live). Never throws. */
export function recordStreamObservation(obs: StreamObservation): void {
  try {
    const now = Date.now();
    rotateBuckets(now);

    state.attempts += 1;
    state.lastObservationAt = now;
    state.bySource[obs.source].attempts += 1;
    const head = state.buckets[state.buckets.length - 1];
    head.attempts += 1;

    for (const stage of STREAM_STAGES) {
      const ms = obs.latencies[stage];
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
        recordSample(stage, ms);
      }
    }

    if (obs.outcome === 'success') {
      state.successes += 1;
      state.bySource[obs.source].successes += 1;
    } else {
      state.failures += 1;
      state.bySource[obs.source].failures += 1;
      state.lastFailureAt = now;
      head.failures += 1;
      const reason = obs.failureReason ?? 'other';
      state.failureCounts[reason] += 1;
      if (obs.failureStage) state.failureByStage[obs.failureStage] += 1;
      maybeFireFailureAlert(now);
    }

    maybeFireLatencyAlert(now);
  } catch (err) {
    // Telemetry must never break the call path or the probe.
    logger.warn('Failed to record realtime stream observation', { error: String(err) });
  }
}

function failuresInLastMinute(now: number): number {
  rotateBuckets(now);
  const cutoff = now - BUCKET_MS;
  return state.buckets
    .filter((b) => b.startedAt >= cutoff)
    .reduce((sum, b) => sum + b.failures, 0);
}

function maybeFireFailureAlert(now: number): void {
  const rate = failuresInLastMinute(now);
  if (rate < ALERT_FAILURE_RATE_PER_MIN) return;
  if (state.lastAlertAt && now - state.lastAlertAt < ALERT_COOLDOWN_MS) return;
  state.lastAlertAt = now;
  const message = `Realtime stream failure spike: ${rate} failures in the last minute (threshold ${ALERT_FAILURE_RATE_PER_MIN}/min)`;
  logger.error(message, { rate, threshold: ALERT_FAILURE_RATE_PER_MIN });
  void logError(null, 'critical', message, {
    service: 'voice-gateway',
    errorCode: 'realtime_stream_failure_spike',
    extra: { ratePerMinute: rate, threshold: ALERT_FAILURE_RATE_PER_MIN, window: '1m', cooldownMs: ALERT_COOLDOWN_MS },
  });
}

function maybeFireLatencyAlert(now: number): void {
  for (const stage of STREAM_STAGES) {
    const s = state.stageStats[stage];
    if (s.samples.length < 5) continue; // need a few samples before trusting p95
    const p95 = percentile(s.samples, 95);
    if (p95 < ALERT_P95_MS[stage]) continue;
    const last = state.lastLatencyAlertAt[stage];
    if (last && now - last < ALERT_COOLDOWN_MS) continue;
    state.lastLatencyAlertAt[stage] = now;
    const message = `Realtime stream latency degraded: ${stage} p95 ${p95}ms exceeds ${ALERT_P95_MS[stage]}ms`;
    logger.error(message, { stage, p95, threshold: ALERT_P95_MS[stage] });
    void logError(null, 'warning', message, {
      service: 'voice-gateway',
      errorCode: `realtime_stream_${stage}_latency`,
      extra: { stage, p95Ms: p95, thresholdMs: ALERT_P95_MS[stage] },
    });
  }
}

export interface StageLatencySnapshot {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface RealtimeStreamMetricsSnapshot {
  startedAt: string;
  generatedAt: string;
  attempts: number;
  successes: number;
  failures: number;
  successRate: number;
  failureRatePerMinute: number;
  bySource: Record<StreamSource, { attempts: number; successes: number; failures: number }>;
  latency: Record<StreamStage, StageLatencySnapshot>;
  latencyThresholdsP95Ms: Record<StreamStage, number>;
  failureCounts: Record<StreamFailureReason, number>;
  failureByStage: Record<StreamStage, number>;
  lastFailureAt: string | null;
  lastObservationAt: string | null;
  alertCooldownMs: number;
}

export function getRealtimeStreamMetrics(): RealtimeStreamMetricsSnapshot {
  const now = Date.now();
  const latency = {} as Record<StreamStage, StageLatencySnapshot>;
  for (const stage of STREAM_STAGES) {
    const s = state.stageStats[stage];
    latency[stage] = {
      count: s.count,
      avgMs: s.count > 0 ? Math.round(s.sumMs / s.count) : 0,
      p50Ms: percentile(s.samples, 50),
      p95Ms: percentile(s.samples, 95),
      maxMs: Math.round(s.maxMs),
    };
  }
  return {
    startedAt: new Date(state.startedAt).toISOString(),
    generatedAt: new Date(now).toISOString(),
    attempts: state.attempts,
    successes: state.successes,
    failures: state.failures,
    successRate: state.attempts > 0 ? Math.round((state.successes / state.attempts) * 1000) / 1000 : 1,
    failureRatePerMinute: failuresInLastMinute(now),
    bySource: {
      probe: { ...state.bySource.probe },
      live: { ...state.bySource.live },
    },
    latency,
    latencyThresholdsP95Ms: { ...ALERT_P95_MS },
    failureCounts: { ...state.failureCounts },
    failureByStage: { ...state.failureByStage },
    lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
    lastObservationAt: state.lastObservationAt ? new Date(state.lastObservationAt).toISOString() : null,
    alertCooldownMs: ALERT_COOLDOWN_MS,
  };
}

export function __resetRealtimeStreamMetricsForTests(): void {
  state = freshState();
}
