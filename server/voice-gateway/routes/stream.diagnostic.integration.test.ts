import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';

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

async function openStream(url = baseUrl): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return ws;
}

function sendStart(ws: WebSocket, customParameters: Record<string, string>): void {
  ws.send(JSON.stringify({
    event: 'start',
    start: { streamSid: 'MZ-test', customParameters },
  }));
}

describe('realtime stream diagnostic against the real gateway', () => {
  it('closes the start frame (1008) when the stream token is wrong', async () => {
    const report = await runRealtimeStreamDiagnostic({
      mode: 'handshake', url: baseUrl, token: 'WRONG', connectTimeoutMs: 2000, handshakeGraceMs: 500,
    });
    expect(report.ok).toBe(false);
    expect(report.latencies.ws_connect).toBeGreaterThanOrEqual(0);
    expect(report.failureStage).toBe('session_setup');
    expect(report.failureReason).toBe('closed_early');
    expect(report.error).toMatch(/1008/);
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
    // We got past the WS upgrade + start-frame token (ws_connect succeeded)
    // before the gateway closed the stream for missing parameters.
    expect(report.latencies.ws_connect).toBeGreaterThanOrEqual(0);
    expect(report.failureStage).toBe('session_setup');
    expect(report.error).not.toMatch(/1008/);
  });
});

describe('Twilio start-frame stream token', () => {
  it('proceeds past auth when the start token is valid', async () => {
    const ws = await openStream();
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }));
    });
    sendStart(ws, { token: 'integration-token', tenantId: '', agentId: '', callSid: '' });
    const result = await closed;
    // Missing required params close without 1008 — that code is reserved for
    // token rejection. The `ws` close handshake may surface as 1000 or 1005.
    expect(result.code).not.toBe(1008);
  });

  it('closes 1008 when the start token is wrong', async () => {
    const ws = await openStream();
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }));
    });
    sendStart(ws, {
      token: 'WRONG',
      tenantId: 't1',
      agentId: 'a1',
      callSid: 'CA1',
    });
    await expect(closed).resolves.toEqual({ code: 1008 });
  });

  it('closes 1008 when the start token is missing', async () => {
    const ws = await openStream();
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }));
    });
    sendStart(ws, { tenantId: 't1', agentId: 'a1', callSid: 'CA1' });
    await expect(closed).resolves.toEqual({ code: 1008 });
  });

  it('still rejects a wrong query-string token at upgrade when one is sent', async () => {
    const ws = new WebSocket(`${baseUrl}?token=WRONG`);
    const failed = new Promise<Error>((resolve) => {
      ws.on('error', (err) => resolve(err));
    });
    await expect(failed).resolves.toMatchObject({ message: expect.stringMatching(/403/) });
  });
});
