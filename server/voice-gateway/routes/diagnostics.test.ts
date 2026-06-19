import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({ runProbeMock: vi.fn(), getMetricsMock: vi.fn() }));

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../platform/core/observability', () => ({ getRealtimeStreamMetrics: a.getMetricsMock }));
vi.mock('../services/streamDiagnostic', () => ({ runRealtimeStreamDiagnostic: a.runProbeMock }));

import router from './diagnostics';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const saved = { tok: process.env.ADMIN_INTERNAL_TOKEN };
beforeEach(() => {
  process.env.ADMIN_INTERNAL_TOKEN = 'secret';
  a.runProbeMock.mockReset().mockResolvedValue({ ok: true, mode: 'handshake', stages: [], latencies: {} });
  a.getMetricsMock.mockReset().mockReturnValue({ attempts: 3, successes: 3, failures: 0 });
});
afterEach(() => {
  if (saved.tok === undefined) delete process.env.ADMIN_INTERNAL_TOKEN; else process.env.ADMIN_INTERNAL_TOKEN = saved.tok;
});

describe('admin token gate', () => {
  it('503 when ADMIN_INTERNAL_TOKEN is unset', async () => {
    delete process.env.ADMIN_INTERNAL_TOKEN;
    expect((await request(app()).get('/admin/diagnostics/realtime-stream/metrics')).status).toBe(503);
  });
  it('403 with a wrong token', async () => {
    expect((await request(app()).get('/admin/diagnostics/realtime-stream/metrics').set('x-admin-token', 'nope')).status).toBe(403);
  });
});

describe('POST /admin/diagnostics/realtime-stream', () => {
  it('runs the probe and returns 200 when healthy', async () => {
    const res = await request(app()).post('/admin/diagnostics/realtime-stream').set('x-admin-token', 'secret').send({ mode: 'handshake' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(a.runProbeMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'handshake' }));
  });
  it('returns 503 when the probe reports failure', async () => {
    a.runProbeMock.mockResolvedValue({ ok: false, failureStage: 'ws_connect', failureReason: 'connect_refused', stages: [], latencies: {} });
    const res = await request(app()).post('/admin/diagnostics/realtime-stream').set('x-admin-token', 'secret').send({ mode: 'full' });
    expect(res.status).toBe(503);
    expect(a.runProbeMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }));
  });
  it('defaults an unknown mode to handshake', async () => {
    await request(app()).post('/admin/diagnostics/realtime-stream').set('x-admin-token', 'secret').send({ mode: 'bogus' });
    expect(a.runProbeMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'handshake' }));
  });
  it('500 when the probe throws', async () => {
    a.runProbeMock.mockRejectedValue(new Error('boom'));
    const res = await request(app()).post('/admin/diagnostics/realtime-stream').set('x-admin-token', 'secret').send({});
    expect(res.status).toBe(500);
  });
});

describe('GET /admin/diagnostics/realtime-stream/metrics', () => {
  it('returns the telemetry snapshot', async () => {
    const res = await request(app()).get('/admin/diagnostics/realtime-stream/metrics').set('x-admin-token', 'secret');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attempts: 3, successes: 3 });
  });
});
