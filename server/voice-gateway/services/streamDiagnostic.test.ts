import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { __resetRealtimeStreamMetricsForTests, getRealtimeStreamMetrics } from '../../../platform/core/observability';
import { runRealtimeStreamDiagnostic } from './streamDiagnostic';

// A stub that emulates the gateway's Twilio Media Streams endpoint so the
// probe's protocol + timing logic is exercised hermetically (no DB/OpenAI).
type StubBehavior = 'echo_audio' | 'reject_403' | 'close_on_start' | 'silent';

function startStubGateway(behavior: StubBehavior): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      if (behavior === 'reject_403') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data: Buffer) => {
        let msg: { event?: string; streamSid?: string };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.event !== 'start') return;
        if (behavior === 'close_on_start') { ws.close(); return; }
        if (behavior === 'echo_audio') {
          ws.send(JSON.stringify({ event: 'media', streamSid: msg.streamSid, media: { payload: 'AAAA' } }));
        }
        // 'silent' → never responds, exercising the first-audio timeout.
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `ws://127.0.0.1:${port}/twilio/stream` });
    });
  });
}

let stub: { server: Server; url: string } | undefined;

beforeEach(() => { __resetRealtimeStreamMetricsForTests(); });
afterEach(async () => {
  if (stub) { await new Promise((r) => stub!.server.close(r)); stub = undefined; }
});

describe('runRealtimeStreamDiagnostic — full mode', () => {
  it('passes and times first audio when the gateway streams media back', async () => {
    stub = await startStubGateway('echo_audio');
    const report = await runRealtimeStreamDiagnostic({ mode: 'full', url: stub.url, firstAudioTimeoutMs: 2000 });
    expect(report.ok).toBe(true);
    expect(report.latencies.ws_connect).toBeGreaterThanOrEqual(0);
    expect(report.latencies.first_audio).toBeGreaterThanOrEqual(0);
    expect(report.stages.find((s) => s.stage === 'first_audio')?.status).toBe('ok');
    // Telemetry recorded a probe success.
    const snap = getRealtimeStreamMetrics();
    expect(snap.bySource.probe.successes).toBe(1);
  });

  it('fails with first_audio_timeout when no media is returned', async () => {
    stub = await startStubGateway('silent');
    const report = await runRealtimeStreamDiagnostic({ mode: 'full', url: stub.url, firstAudioTimeoutMs: 300 });
    expect(report.ok).toBe(false);
    expect(report.failureReason).toBe('first_audio_timeout');
    expect(getRealtimeStreamMetrics().bySource.probe.failures).toBe(1);
  });

  it('reports closed_early when the gateway drops the socket after start', async () => {
    stub = await startStubGateway('close_on_start');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const report = await runRealtimeStreamDiagnostic({ mode: 'full', url: stub.url, firstAudioTimeoutMs: 2000 });
      expect(report.ok).toBe(false);
      expect(report.latencies.ws_connect).toBe(0);
      expect(report.failureStage).toBe('session_setup');
      expect(report.failureReason).toBe('closed_early');
    } finally {
      now.mockRestore();
    }
  });
});

describe('runRealtimeStreamDiagnostic — handshake mode', () => {
  it('passes when the socket stays open through the grace window', async () => {
    stub = await startStubGateway('silent');
    const report = await runRealtimeStreamDiagnostic({ mode: 'handshake', url: stub.url, handshakeGraceMs: 200 });
    expect(report.ok).toBe(true);
    expect(report.latencies.ws_connect).toBeGreaterThanOrEqual(0);
  });
});

describe('runRealtimeStreamDiagnostic — connection failures', () => {
  it('reports auth_rejected on a 403 upgrade', async () => {
    stub = await startStubGateway('reject_403');
    const report = await runRealtimeStreamDiagnostic({ mode: 'handshake', url: stub.url, handshakeGraceMs: 200, connectTimeoutMs: 1000 });
    expect(report.ok).toBe(false);
    expect(report.failureReason).toBe('auth_rejected');
    expect(report.failureStage).toBe('ws_connect');
  });

  it('reports connect_refused when nothing is listening', async () => {
    const report = await runRealtimeStreamDiagnostic({ mode: 'handshake', url: 'ws://127.0.0.1:9/twilio/stream', connectTimeoutMs: 1000 });
    expect(report.ok).toBe(false);
    expect(report.failureStage).toBe('ws_connect');
    expect(['connect_refused', 'connect_timeout']).toContain(report.failureReason);
  });
});
