import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
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
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
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

import router from './callsLive';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.acquireMock.mockReset();
  a.ackSseConnectionMock.mockReset().mockReturnValue(true);
});

describe('GET /calls/live (SSE)', () => {
  it('is rejected when the tenant concurrency cap is reached', async () => {
    // The limiter writes its own 429 and returns false; mirror that here so
    // the request completes instead of hanging on an open stream.
    a.acquireMock.mockImplementation((_req: unknown, res: express.Response) => {
      res.status(429).json({ error: 'cap reached' });
      return false;
    });
    const res = await request(app()).get('/calls/live');
    expect(res.status).toBe(429);
  });
});

describe('GET /calls/live escalation events (transfers end in CALL_COMPLETED since #143)', () => {
  type Row = { id: string; lifecycle_state: string; escalation_target: string | null };

  /** Runs the SSE handler on a fake req/res; returns the event names written and a way to run the next poll. */
  async function openStream(rows: { current: Row[] }) {
    a.acquireMock.mockReturnValue(true);
    a.queryMock.mockImplementation(async (sql: string) => (sql.includes('FROM call_sessions') ? { rows: rows.current } : { rows: [] }));
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> })
      .stack.find((l) => l.route?.path === '/calls/live' && l.route.methods.get)!;
    const handler = layer.route!.stack.at(-1)!.handle;
    const writes: string[] = [];
    // afterEach drops the fake timers, which stops the poll interval.
    const req = { user: a.user, on: vi.fn() };
    const res = { writeHead: vi.fn(), write: (chunk: string) => { writes.push(chunk); return true; } };
    await handler(req, res);
    return {
      events: () => writes.map((w) => /^event: (\w+)/.exec(w)?.[1]).filter((e) => e !== 'active_calls'),
      poll: () => vi.advanceTimersByTimeAsync(3000),
    };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a transfer landing after the call is final (CALL_COMPLETED + escalation_target) emits call_escalated once', async () => {
    const rows = { current: [{ id: 'c1', lifecycle_state: 'ACTIVE_CONVERSATION', escalation_target: null }] as Row[] };
    const s = await openStream(rows);
    rows.current = [{ id: 'c1', lifecycle_state: 'CALL_COMPLETED', escalation_target: null }];
    await s.poll();
    rows.current = [{ id: 'c1', lifecycle_state: 'CALL_COMPLETED', escalation_target: '+15550001111' }];
    await s.poll();
    await s.poll();
    expect(s.events()).toEqual(['connection', 'call_connected', 'call_completed', 'call_escalated']);
  });

  it('a transfer seen as ESCALATED then CALL_COMPLETED emits call_escalated once, then call_completed', async () => {
    const rows = { current: [{ id: 'c1', lifecycle_state: 'ACTIVE_CONVERSATION', escalation_target: null }] as Row[] };
    const s = await openStream(rows);
    rows.current = [{ id: 'c1', lifecycle_state: 'ESCALATED', escalation_target: '+15550001111' }];
    await s.poll();
    rows.current = [{ id: 'c1', lifecycle_state: 'CALL_COMPLETED', escalation_target: '+15550001111' }];
    await s.poll();
    expect(s.events()).toEqual(['connection', 'call_connected', 'call_escalated', 'call_completed']);
  });
});

describe('POST /calls/live/ack', () => {
  it('requires a connectionId', async () => {
    expect((await request(app()).post('/calls/live/ack').send({})).status).toBe(400);
  });
  it('404 for an unknown connectionId', async () => {
    a.ackSseConnectionMock.mockReturnValue(false);
    expect((await request(app()).post('/calls/live/ack').send({ connectionId: 'x' })).status).toBe(404);
  });
  it('204 on a valid ack', async () => {
    a.ackSseConnectionMock.mockReturnValue(true);
    const res = await request(app()).post('/calls/live/ack').send({ connectionId: 'conn-1' });
    expect(res.status).toBe(204);
    expect(a.ackSseConnectionMock).toHaveBeenCalledWith('t1', 'conn-1');
  });
  it('accepts the connectionId from the query string', async () => {
    a.ackSseConnectionMock.mockReturnValue(true);
    expect((await request(app()).post('/calls/live/ack?connectionId=q1').send({})).status).toBe(204);
  });
});
