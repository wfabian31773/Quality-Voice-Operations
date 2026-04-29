import { createLogger } from '../../../platform/core/logger';
import { logError } from '../../../platform/core/observability';

const logger = createLogger('TWILIO_SIGNATURE_METRICS');

export type RejectionReason =
  | 'missing_header'
  | 'invalid_signature'
  | 'validator_unavailable'
  | 'replay_detected';

export const REJECTION_REASONS: RejectionReason[] = [
  'missing_header',
  'invalid_signature',
  'validator_unavailable',
  'replay_detected',
];

const BUCKET_COUNT = 60;
const BUCKET_MS = 60_000;

const ALERT_THRESHOLDS_PER_MINUTE: Record<RejectionReason, number> = {
  invalid_signature: 5,
  missing_header: 20,
  validator_unavailable: 1,
  // A genuine Twilio retry storm could push this above 1, but the dedupe key
  // includes SequenceNumber on status callbacks so even retries should hash
  // distinctly. A burst here almost certainly means a replay attempt.
  replay_detected: 1,
};

const ALERT_COOLDOWN_MS = 5 * 60_000;

interface BucketState {
  startedAt: number;
  counts: Record<RejectionReason, number>;
}

interface InternalState {
  totals: Record<RejectionReason, number>;
  lastRejectionAt: Record<RejectionReason, number | null>;
  buckets: BucketState[];
  lastAlertAt: Record<RejectionReason, number>;
  startedAt: number;
}

function emptyCounts(): Record<RejectionReason, number> {
  return {
    missing_header: 0,
    invalid_signature: 0,
    validator_unavailable: 0,
    replay_detected: 0,
  };
}

function emptyAlertMap(): Record<RejectionReason, number> {
  return {
    missing_header: 0,
    invalid_signature: 0,
    validator_unavailable: 0,
    replay_detected: 0,
  };
}

function emptyLastSeen(): Record<RejectionReason, number | null> {
  return {
    missing_header: null,
    invalid_signature: null,
    validator_unavailable: null,
    replay_detected: null,
  };
}

function newBucket(startedAt: number): BucketState {
  return { startedAt, counts: emptyCounts() };
}

function bucketStartFor(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

const state: InternalState = {
  totals: emptyCounts(),
  lastRejectionAt: emptyLastSeen(),
  buckets: [newBucket(bucketStartFor(Date.now()))],
  lastAlertAt: emptyAlertMap(),
  startedAt: Date.now(),
};

/**
 * Ensure the head bucket corresponds to the current wall-clock minute.
 * - If we're already in the same minute, no-op.
 * - If we've drifted forward by N < BUCKET_COUNT minutes, append N empty
 *   buckets aligned to minute boundaries and trim the ring to BUCKET_COUNT.
 * - If we've drifted by >= BUCKET_COUNT minutes (long idle), every old
 *   bucket would have rolled out anyway — replace the ring with a single
 *   fresh bucket anchored at the current minute. This is the case the
 *   previous implementation handled incorrectly: it only advanced by
 *   BUCKET_COUNT slots from the stale head, leaving `head.startedAt`
 *   minutes (or hours) behind `now`, so subsequent counts landed in a
 *   stale bucket and `ratePerMinute` undercounted real traffic.
 */
function rotateBuckets(now: number): void {
  const currentStart = bucketStartFor(now);
  const head = state.buckets[state.buckets.length - 1];

  if (!head) {
    state.buckets = [newBucket(currentStart)];
    return;
  }
  if (head.startedAt === currentStart) return;

  const elapsedBuckets = Math.floor((currentStart - head.startedAt) / BUCKET_MS);
  if (elapsedBuckets <= 0) return;

  if (elapsedBuckets >= BUCKET_COUNT) {
    state.buckets = [newBucket(currentStart)];
    return;
  }

  for (let i = 1; i <= elapsedBuckets; i++) {
    state.buckets.push(newBucket(head.startedAt + i * BUCKET_MS));
  }
  while (state.buckets.length > BUCKET_COUNT) {
    state.buckets.shift();
  }
}

function maybeFireAlert(reason: RejectionReason, ratePerMinute: number, now: number): void {
  const threshold = ALERT_THRESHOLDS_PER_MINUTE[reason];
  if (ratePerMinute < threshold) return;
  const lastAlert = state.lastAlertAt[reason];
  if (lastAlert && now - lastAlert < ALERT_COOLDOWN_MS) return;
  state.lastAlertAt[reason] = now;

  const message = `Twilio webhook rejection spike: ${ratePerMinute} '${reason}' rejection(s) in the last minute (threshold ${threshold}/min)`;
  logger.error(message, { reason, ratePerMinute, threshold });
  void logError(null, 'critical', message, {
    service: 'voice-gateway',
    errorCode: `twilio_signature_${reason}_spike`,
    extra: {
      reason,
      ratePerMinute,
      threshold,
      window: '1m',
      cooldownMs: ALERT_COOLDOWN_MS,
    },
  });
}

export function recordRejection(reason: RejectionReason): void {
  const now = Date.now();
  rotateBuckets(now);
  state.totals[reason] += 1;
  state.lastRejectionAt[reason] = now;
  const head = state.buckets[state.buckets.length - 1];
  head.counts[reason] += 1;

  maybeFireAlert(reason, head.counts[reason], now);
}

export interface TwilioSignatureMetricsSnapshot {
  totals: Record<RejectionReason, number>;
  ratePerMinute: Record<RejectionReason, number>;
  buckets: Array<{ startedAt: string; counts: Record<RejectionReason, number> }>;
  thresholdsPerMinute: Record<RejectionReason, number>;
  lastRejectionAt: Record<RejectionReason, string | null>;
  lastAlertAt: Record<RejectionReason, string | null>;
  alertActive: Record<RejectionReason, boolean>;
  alertCooldownMs: number;
  startedAt: string;
  generatedAt: string;
}

export function getTwilioSignatureMetrics(): TwilioSignatureMetricsSnapshot {
  const now = Date.now();
  rotateBuckets(now);
  const head = state.buckets[state.buckets.length - 1];

  const ratePerMinute: Record<RejectionReason, number> = emptyCounts();
  for (const reason of REJECTION_REASONS) {
    ratePerMinute[reason] = head.counts[reason];
  }

  const lastRejectionAt = {} as Record<RejectionReason, string | null>;
  const lastAlertAt = {} as Record<RejectionReason, string | null>;
  const alertActive = {} as Record<RejectionReason, boolean>;
  for (const reason of REJECTION_REASONS) {
    const lastRej = state.lastRejectionAt[reason];
    lastRejectionAt[reason] = lastRej ? new Date(lastRej).toISOString() : null;
    const lastAlert = state.lastAlertAt[reason];
    lastAlertAt[reason] = lastAlert ? new Date(lastAlert).toISOString() : null;
    alertActive[reason] = !!lastAlert && now - lastAlert < ALERT_COOLDOWN_MS;
  }

  return {
    totals: { ...state.totals },
    ratePerMinute,
    buckets: state.buckets.map((b) => ({
      startedAt: new Date(b.startedAt).toISOString(),
      counts: { ...b.counts },
    })),
    thresholdsPerMinute: { ...ALERT_THRESHOLDS_PER_MINUTE },
    lastRejectionAt,
    lastAlertAt,
    alertActive,
    alertCooldownMs: ALERT_COOLDOWN_MS,
    startedAt: new Date(state.startedAt).toISOString(),
    generatedAt: new Date(now).toISOString(),
  };
}

export function __resetTwilioSignatureMetricsForTests(): void {
  state.totals = emptyCounts();
  state.lastRejectionAt = emptyLastSeen();
  state.buckets = [newBucket(bucketStartFor(Date.now()))];
  state.lastAlertAt = emptyAlertMap();
  state.startedAt = Date.now();
}
