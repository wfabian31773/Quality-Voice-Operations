/**
 * Realtime-stream diagnostic probe.
 *
 * Drives the *real* voice-gateway WebSocket path (`/twilio/stream`) as a
 * synthetic Twilio Media Streams client so operators have an always-available,
 * on-demand way to test and diagnose the realtime path — the same handshake,
 * auth, `start`-frame handling, session setup, and (in `full` mode) the
 * round-trip to first audio that a real Twilio call exercises.
 *
 * Two modes:
 *  - `handshake` (default, dependency-free): verifies TCP + WS upgrade, the
 *    stream auth token, and that the gateway accepts the `start` frame without
 *    rejecting it. Safe to run anywhere — it does not require a seeded agent
 *    or a live OpenAI key, and it tears the socket down immediately.
 *  - `full`: additionally waits for the gateway to stream back the first
 *    `media` frame (time-to-first-audio), exercising agent load + the OpenAI
 *    Realtime session end-to-end. Run against an environment with a seeded
 *    diagnostic agent and `OPENAI_API_KEY` configured.
 *
 * Every run is tagged with a correlation id, logs each stage, and feeds the
 * shared realtime-stream telemetry (`recordStreamObservation`) so probe and
 * live traffic show up in the same latency/failure snapshot.
 */
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { createLogger } from '../../../platform/core/logger';
import {
  recordStreamObservation,
  type StreamStage,
  type StreamFailureReason,
} from '../../../platform/core/observability';

const logger = createLogger('STREAM_DIAGNOSTIC');

export type StreamDiagnosticMode = 'handshake' | 'full';

export interface StreamDiagnosticOptions {
  mode?: StreamDiagnosticMode;
  /** Full ws(s):// URL of the gateway stream endpoint. Defaults from env. */
  url?: string;
  /** Stream auth token. Defaults to VOICE_GATEWAY_STREAM_TOKEN. */
  token?: string;
  /** Synthetic stream `customParameters`. Defaults to a diagnostic identity. */
  params?: Partial<{
    tenantId: string;
    agentId: string;
    agentType: string;
    callSid: string;
    callerNumber: string;
    calledNumber: string;
  }>;
  connectTimeoutMs?: number;
  /** Grace window (handshake mode) the socket must stay open after `start`. */
  handshakeGraceMs?: number;
  /** Max wait for the first inbound media frame (full mode). */
  firstAudioTimeoutMs?: number;
}

export interface StreamDiagnosticStageResult {
  stage: StreamStage | 'handshake';
  status: 'ok' | 'fail' | 'skipped';
  latencyMs?: number;
  detail?: string;
}

export interface StreamDiagnosticReport {
  correlationId: string;
  mode: StreamDiagnosticMode;
  target: string;
  ok: boolean;
  stages: StreamDiagnosticStageResult[];
  latencies: Partial<Record<StreamStage, number>>;
  failureStage?: StreamStage;
  failureReason?: StreamFailureReason;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export function defaultStreamUrl(): string {
  const explicit = process.env.VOICE_GATEWAY_STREAM_URL;
  if (explicit) return explicit;
  const port = process.env.VOICE_GATEWAY_PORT ?? '3001';
  const host = process.env.VOICE_GATEWAY_HOST ?? '127.0.0.1';
  return `ws://${host}:${port}/twilio/stream`;
}

/** 20ms of g711_ulaw silence (0xFF), base64-encoded — a benign media frame. */
const SILENCE_FRAME_B64 = Buffer.alloc(160, 0xff).toString('base64');

function buildUrl(base: string, token: string | undefined): string {
  if (!token) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Run a realtime-stream diagnostic. Resolves with a structured report and
 * never rejects — failures are captured in the report so callers (HTTP
 * endpoint, CLI, monitor) always get a diagnosis.
 */
export async function runRealtimeStreamDiagnostic(
  options: StreamDiagnosticOptions = {},
): Promise<StreamDiagnosticReport> {
  const correlationId = randomUUID().slice(0, 8);
  const mode = options.mode ?? 'handshake';
  const base = options.url ?? defaultStreamUrl();
  const token = options.token ?? process.env.VOICE_GATEWAY_STREAM_TOKEN;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const handshakeGraceMs = options.handshakeGraceMs ?? 1_500;
  const firstAudioTimeoutMs = options.firstAudioTimeoutMs ?? 10_000;

  const params = {
    tenantId: 'diagnostic',
    agentId: 'diagnostic-probe',
    agentType: 'general',
    callSid: `DIAG${correlationId}`,
    callerNumber: '+10000000000',
    calledNumber: '+10000000001',
    ...options.params,
  };

  const startedAtMs = Date.now();
  const stages: StreamDiagnosticStageResult[] = [];
  const latencies: Partial<Record<StreamStage, number>> = {};
  const log = (msg: string, extra?: Record<string, unknown>) =>
    logger.info(msg, { correlationId, mode, target: base, ...extra });

  log('Realtime stream diagnostic started');

  const finish = (
    ok: boolean,
    failureStage?: StreamStage,
    failureReason?: StreamFailureReason,
    error?: string,
  ): StreamDiagnosticReport => {
    const finishedAtMs = Date.now();
    latencies.total = finishedAtMs - startedAtMs;
    stages.push({ stage: 'total', status: ok ? 'ok' : 'fail', latencyMs: latencies.total });

    recordStreamObservation({
      source: 'probe',
      latencies,
      outcome: ok ? 'success' : 'failure',
      failureStage,
      failureReason,
      correlationId,
    });

    const report: StreamDiagnosticReport = {
      correlationId, mode, target: base, ok, stages, latencies,
      failureStage, failureReason, error,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: latencies.total,
    };
    if (ok) {
      log('Realtime stream diagnostic passed', { latencies });
    } else {
      logger.error('Realtime stream diagnostic failed', {
        correlationId, mode, target: base, failureStage, failureReason, error, latencies,
      });
    }
    return report;
  };

  let ws: WebSocket;
  try {
    ws = new WebSocket(buildUrl(base, token), { handshakeTimeout: connectTimeoutMs });
  } catch (err) {
    stages.push({ stage: 'ws_connect', status: 'fail', detail: String(err) });
    return finish(false, 'ws_connect', 'connect_refused', String(err));
  }

  return await new Promise<StreamDiagnosticReport>((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const connectStart = Date.now();
    let startSentAt = 0;

    const cleanup = () => {
      for (const t of timers) clearTimeout(t);
      try {
        ws.removeAllListeners();
        // `ws` can emit a late 'error' while tearing down a rejected upgrade
        // (e.g. "Unexpected server response: 403"); swallow it so it doesn't
        // surface as an unhandled error after we've already diagnosed.
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch { /* ignore */ }
    };
    const settle = (
      ok: boolean, failureStage?: StreamStage, failureReason?: StreamFailureReason, error?: string,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(finish(ok, failureStage, failureReason, error));
    };

    const connectTimer = setTimeout(() => {
      stages.push({ stage: 'ws_connect', status: 'fail', detail: `no open within ${connectTimeoutMs}ms` });
      settle(false, 'ws_connect', 'connect_timeout', `connect timed out after ${connectTimeoutMs}ms`);
    }, connectTimeoutMs);
    timers.push(connectTimer);

    ws.on('open', () => {
      clearTimeout(connectTimer);
      latencies.ws_connect = Date.now() - connectStart;
      stages.push({ stage: 'ws_connect', status: 'ok', latencyMs: latencies.ws_connect });
      log('WebSocket open', { wsConnectMs: latencies.ws_connect });

      // Twilio Media Streams handshake: connected → start → media.
      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      startSentAt = Date.now();
      ws.send(JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: `MZ${correlationId}`,
        start: {
          streamSid: `MZ${correlationId}`,
          accountSid: 'ACdiagnostic',
          callSid: params.callSid,
          customParameters: params,
        },
      }));
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: `MZ${correlationId}`,
        media: { track: 'inbound', chunk: '1', timestamp: '0', payload: SILENCE_FRAME_B64 },
      }));
      log('Sent connected/start/media frames');

      if (mode === 'handshake') {
        // Success = the gateway accepted the upgrade, auth, and start frame
        // and kept the socket open through the grace window (no auth/param
        // rejection). We don't wait on the OpenAI round-trip here.
        const graceTimer = setTimeout(() => {
          stages.push({ stage: 'session_setup', status: 'ok', detail: 'accepted (handshake grace elapsed)' });
          try { ws.send(JSON.stringify({ event: 'stop', streamSid: `MZ${correlationId}` })); } catch { /* ignore */ }
          settle(true);
        }, handshakeGraceMs);
        timers.push(graceTimer);
      } else {
        // full mode: wait for the first inbound media frame (first audio).
        const audioTimer = setTimeout(() => {
          stages.push({ stage: 'first_audio', status: 'fail', detail: `no media within ${firstAudioTimeoutMs}ms` });
          settle(false, 'first_audio', 'first_audio_timeout', `no first audio within ${firstAudioTimeoutMs}ms`);
        }, firstAudioTimeoutMs);
        timers.push(audioTimer);
      }
    });

    ws.on('message', (data: Buffer) => {
      if (mode !== 'full' || settled) return;
      let msg: { event?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.event === 'media') {
        latencies.first_audio = Date.now() - startSentAt;
        stages.push({ stage: 'first_audio', status: 'ok', latencyMs: latencies.first_audio });
        log('First audio received', { firstAudioMs: latencies.first_audio });
        try { ws.send(JSON.stringify({ event: 'stop', streamSid: `MZ${correlationId}` })); } catch { /* ignore */ }
        settle(true);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      try { res.destroy(); } catch { /* ignore */ } // stop ws from also emitting 'error'
      stages.push({ stage: 'ws_connect', status: 'fail', detail: `HTTP ${code}` });
      const reason: StreamFailureReason = code === 403 ? 'auth_rejected' : 'bad_handshake';
      settle(false, 'ws_connect', reason, `upgrade rejected with HTTP ${code}`);
    });

    ws.on('error', (err: Error) => {
      if (settled) return;
      const refused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(String(err));
      stages.push({ stage: latencies.ws_connect ? 'session_setup' : 'ws_connect', status: 'fail', detail: String(err) });
      settle(false, latencies.ws_connect ? 'session_setup' : 'ws_connect', refused ? 'connect_refused' : 'setup_error', String(err));
    });

    ws.on('close', (code: number) => {
      if (settled) return;
      // Closed before we reached our success condition.
      const stage: StreamStage = latencies.ws_connect ? 'session_setup' : 'ws_connect';
      const reason: StreamFailureReason = !latencies.ws_connect
        ? 'auth_rejected'
        : (Date.now() - startSentAt < 500 ? 'closed_early' : 'setup_error');
      stages.push({ stage, status: 'fail', detail: `socket closed (code ${code})` });
      settle(false, stage, reason, `socket closed early with code ${code}`);
    });
  });
}
