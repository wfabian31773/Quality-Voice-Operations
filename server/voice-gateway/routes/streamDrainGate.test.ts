// @vitest-environment node
// PR-00: new /twilio/stream and /widget/stream upgrades are refused while
// the gateway drains; streams accepted earlier are tracked until they close.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() }),
  withTenantContext: vi.fn(),
  withPrivilegedClient: vi.fn(),
}));

delete process.env.VOICE_GATEWAY_STREAM_TOKEN;

import { attachWebSocket } from './stream';
import { sessionManager } from '../services/sessionManager';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('ok'));
  attachWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  sessionManager.__resetForTests();
});

function upgradeStatus(path: string): Promise<number | 'open'> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve('open');
      ws.close();
    });
    ws.on('error', (err) => {
      if (!String(err).includes('Unexpected server response')) reject(err);
    });
  });
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('stream upgrade gate', () => {
  it('accepts a Twilio stream when not draining and tracks it until it closes', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await waitFor(() => sessionManager.getDrainStatus().openStreams === 1);
    ws.close();
    await waitFor(() => sessionManager.getDrainStatus().openStreams === 0);
  });

  it('refuses new /twilio/stream and /widget/stream upgrades with 503 while draining', async () => {
    sessionManager.beginDrain();
    expect(await upgradeStatus('/twilio/stream')).toBe(503);
    expect(await upgradeStatus('/widget/stream?token=abc')).toBe(503);
    expect(sessionManager.getDrainStatus().openStreams).toBe(0);
  });

  it('keeps the existing widget token check when not draining', async () => {
    expect(await upgradeStatus('/widget/stream')).toBe(403);
  });
});
