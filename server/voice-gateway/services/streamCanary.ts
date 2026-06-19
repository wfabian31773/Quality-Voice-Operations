/**
 * Synthetic realtime-stream canary.
 *
 * Periodically runs the realtime-stream diagnostic probe against the gateway
 * (by default the gateway probes itself) so the realtime path is continuously
 * exercised even when no real calls are flowing — turning the on-demand probe
 * into a scheduled, self-monitoring canary. Each run feeds the shared
 * realtime-stream telemetry (latency + failures, alerts on spikes), so a
 * regression shows up in the metrics snapshot and fires an alert without anyone
 * having to place a call.
 *
 * Off by default. Enable in an environment via:
 *   STREAM_CANARY_ENABLED=true
 *   STREAM_CANARY_MODE=handshake|full      (default: handshake)
 *   STREAM_CANARY_INTERVAL_MS=60000        (default: 60s, floor 10s)
 *
 * `handshake` mode is safe everywhere (no seeded agent / OpenAI key needed).
 * `full` mode exercises end-to-end to first audio and expects a seeded
 * diagnostic agent (see scripts/seed-diagnostic-agent.ts) + OPENAI_API_KEY.
 */
import { createLogger } from '../../../platform/core/logger';
import {
  runRealtimeStreamDiagnostic,
  type StreamDiagnosticMode,
  type StreamDiagnosticReport,
} from './streamDiagnostic';

const logger = createLogger('STREAM_CANARY');

const MIN_INTERVAL_MS = 10_000;
const DEFAULT_INTERVAL_MS = 60_000;

export interface StreamCanaryOptions {
  enabled?: boolean;
  mode?: StreamDiagnosticMode;
  intervalMs?: number;
  /** Probe URL override (defaults to the gateway's own stream endpoint). */
  url?: string;
  /** Injectable probe runner for tests. */
  runProbe?: (opts: { mode: StreamDiagnosticMode; url?: string }) => Promise<StreamDiagnosticReport>;
}

interface CanaryState {
  timer: NodeJS.Timeout;
  running: boolean; // a probe is currently in-flight (prevents overlap)
}

let state: CanaryState | null = null;

function resolveOptions(options: StreamCanaryOptions): Required<Omit<StreamCanaryOptions, 'url'>> & { url?: string } {
  const enabled = options.enabled ?? /^(1|true|yes|on)$/i.test(process.env.STREAM_CANARY_ENABLED ?? '');
  const mode: StreamDiagnosticMode =
    (options.mode ?? (process.env.STREAM_CANARY_MODE === 'full' ? 'full' : 'handshake'));
  const envInterval = parseInt(process.env.STREAM_CANARY_INTERVAL_MS ?? '', 10);
  const requested = options.intervalMs ?? (Number.isFinite(envInterval) ? envInterval : DEFAULT_INTERVAL_MS);
  const intervalMs = Math.max(MIN_INTERVAL_MS, requested);
  return {
    enabled,
    mode,
    intervalMs,
    url: options.url,
    runProbe: options.runProbe ?? runRealtimeStreamDiagnostic,
  };
}

/**
 * Start the canary if enabled. Idempotent — a second call replaces the prior
 * schedule. Returns `true` if a canary is now running.
 */
export function startStreamCanary(options: StreamCanaryOptions = {}): boolean {
  const opts = resolveOptions(options);
  if (!opts.enabled) {
    logger.info('Realtime stream canary disabled');
    return false;
  }
  stopStreamCanary();

  logger.info('Realtime stream canary started', { mode: opts.mode, intervalMs: opts.intervalMs });

  const tick = async (): Promise<void> => {
    if (!state || state.running) return; // skip if a run is still in flight
    state.running = true;
    try {
      const report = await opts.runProbe({ mode: opts.mode, url: opts.url });
      if (report.ok) {
        logger.info('Canary probe passed', { correlationId: report.correlationId, latencies: report.latencies });
      } else {
        logger.warn('Canary probe failed', {
          correlationId: report.correlationId,
          failureStage: report.failureStage,
          failureReason: report.failureReason,
        });
      }
    } catch (err) {
      logger.error('Canary probe threw', { error: String(err) });
    } finally {
      if (state) state.running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs);
  // Don't keep the process alive solely for the canary.
  if (typeof timer.unref === 'function') timer.unref();
  state = { timer, running: false };
  return true;
}

export function stopStreamCanary(): void {
  if (state) {
    clearInterval(state.timer);
    state = null;
  }
}

export function isStreamCanaryRunning(): boolean {
  return state !== null;
}
