import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';

// Enforce a stream token on the *real* gateway before stream.ts is imported
// (STREAM_AUTH_TOKEN is captured at module load).
vi.hoisted(() => { process.env.VOICE_GATEWAY_STREAM_TOKEN = 'integration-token'; });

import { attachWebSocket } from './stream';
import { __resetRealtimeStreamMetricsForTests, getRealtimeStreamMetrics } from '../../../platform/core/observability';
import { runRealtimeStreamDiagnostic } from '../services/streamDiagnostic';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();
  attachWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `ws://127.0.0.1:${port}/twilio/stream`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
});

beforeEach(() => __resetRealtimeStreamMetricsForTests());

describe('realtime stream diagnostic against the real gateway', () => {
  it('is rejected (auth_rejected) when the stream token is wrong', async () => {
    const report = await runRealtimeStreamDiagnostic({
      mode: 'handshake', url: baseUrl, token: 'WRONG', connectTimeoutMs: 2000, handshakeGraceMs: 500,
    });
    expect(report.ok).toBe(false);
    expect(report.failureStage).toBe('ws_connect');
    expect(report.failureReason).toBe('auth_rejected');
    // The failed probe is recorded in telemetry.
    expect(getRealtimeStreamMetrics().bySource.probe.failures).toBe(1);
  });

  it('connects with a valid token and the gateway closes the stream on missing params', async () => {
    const report = await runRealtimeStreamDiagnostic({
      mode: 'full',
      url: baseUrl,
      token: 'integration-token',
      connectTimeoutMs: 2000,
      firstAudioTimeoutMs: 2000,
      // Empty required params → the real start handler validates and closes.
      params: { tenantId: '', agentId: '', callSid: '' },
    });
    expect(report.ok).toBe(false);
    // We got past the WS upgrade + auth (ws_connect succeeded) before the
    // gateway closed the stream for missing parameters.
    expect(report.latencies.ws_connect).toBeGreaterThanOrEqual(0);
    expect(report.failureStage).toBe('session_setup');
  });
});
