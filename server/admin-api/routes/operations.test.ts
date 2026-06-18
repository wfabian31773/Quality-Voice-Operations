import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  acquireMock: vi.fn(),
  ackSseConnectionMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  getTenantSseConnectionLimiter: () => ({ acquire: a.acquireMock }),
  attachSseHeartbeat: () => ({ ack: vi.fn() }),
  resolveLiveStreamCap: () => 5,
  registerSseConnection: () => vi.fn(),
  ackSseConnection: a.ackSseConnectionMock,
}));

import router, { redactOutboxValue } from './operations';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [{}] });
  a.releaseMock.mockReset();
  a.acquireMock.mockReset().mockReturnValue(true);
  a.ackSseConnectionMock.mockReset().mockReturnValue(true);
});

describe('GET /operations/realtime', () => {
  it('returns aggregated realtime metrics', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('total_calls')) return { rows: [{ total_calls: 10, completed_calls: 8, failed_calls: 1, escalated_calls: 0, avg_duration: 42, active_calls: 1 }] };
      if (sql.includes("DATE_TRUNC('hour'")) return { rows: [{ hour: '2026-05-01T10:00:00Z', calls: 3 }] };
      if (sql.includes('total_executions')) return { rows: [{ total_executions: 5, completed_tools: 4, started_tools: 5 }] };
      if (sql.includes('FROM call_events ce')) return { rows: [{ id: 'e1', event_type: 'TOOL_END', payload: { tool: 'lookup' }, occurred_at: 'now', agent_name: 'Bot', caller_number: '+15551234567' }] };
      return { rows: [{}] };
    });
    const res = await request(app()).get('/operations/realtime?range=7d');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCalls: 10, completedCalls: 8, completionRate: 80 });
    expect(res.body.recentTools[0].callerNumber).toBe('***4567');
  });
  it('500 on error', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/operations/realtime')).status).toBe(500);
  });
});

describe('GET /operations/alerts', () => {
  it('lists alerts with an unacknowledged count', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY created_at DESC')) return { rows: [{ id: 'al1', type: 'billing' }] };
      if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 4 }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/operations/alerts?type=billing&acknowledged=false');
    expect(res.body).toMatchObject({ unacknowledgedCount: 4 });
    expect(res.body.alerts).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/operations/alerts')).status).toBe(500);
  });
});

describe('GET /operations/alerts/summary', () => {
  it('returns per-type unacked counts', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ type: 'billing', count: 2 }, { type: 'sync', count: 0 }] });
    const res = await request(app()).get('/operations/alerts/summary?types=billing,sync');
    expect(res.body.counts).toEqual({ billing: 2 });
  });
});

describe('alert acknowledge', () => {
  it('acknowledges one (404 when missing)', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await request(app()).post('/operations/alerts/al1/acknowledge')).status).toBe(404);
  });
  it('acknowledges one (success)', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'al1' }], rowCount: 1 });
    expect((await request(app()).post('/operations/alerts/al1/acknowledge')).body).toEqual({ success: true });
  });
  it('acknowledges all', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [], rowCount: 7 });
    expect((await request(app()).post('/operations/alerts/acknowledge-all')).body).toEqual({ acknowledged: 7 });
  });
});

describe('GET /operations/calls/:callId/live guards', () => {
  it('404 when the call session does not exist', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/operations/calls/c1/live')).status).toBe(404);
  });
  it('500 when the session check throws', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/operations/calls/c1/live')).status).toBe(500);
  });
});

describe('POST /operations/calls/:callId/live/ack', () => {
  it('requires a connectionId', async () => {
    expect((await request(app()).post('/operations/calls/c1/live/ack').send({})).status).toBe(400);
  });
  it('404 for an unknown connection', async () => {
    a.ackSseConnectionMock.mockReturnValue(false);
    expect((await request(app()).post('/operations/calls/c1/live/ack').send({ connectionId: 'x' })).status).toBe(404);
  });
  it('204 on a valid ack', async () => {
    a.ackSseConnectionMock.mockReturnValue(true);
    expect((await request(app()).post('/operations/calls/c1/live/ack').send({ connectionId: 'x' })).status).toBe(204);
  });
});

describe('redactOutboxValue (exported helper)', () => {
  it('collapses sensitive keys and scrubs string PII', () => {
    const out = redactOutboxValue({
      email: 'a@b.com',
      phone: '+15551234567',
      nested: { address: { zip: '90210' }, note: 'call 555-123-4567' },
      count: 5,
    }) as Record<string, unknown>;
    expect(out.email).toBe('[REDACTED]');
    expect(out.phone).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).address).toBe('[REDACTED]');
    expect(out.count).toBe(5);
  });
});
